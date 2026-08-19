/**
 * /api/cron/stats KBO 선수기록 HTML → Naver 시즌기록 failover 회귀.
 *
 * 배경(감사): 수정 전 route 는
 *   1) fetchHtml 이 res.ok 를 보지 않아 503/302 본문을 그대로 파싱 → parseTable [] 반환
 *   2) [] 가 "정상 수집 0명"으로 통과 → upsert([]) 후 job "success" 로 마감
 *      (= KBO 전면 차단이 조용한 no-op 성공으로 은폐됨)
 *   3) 투수는 Promise.all 이라 10개 sort 중 1개만 죽어도 전량 throw
 *   4) 안내문 행이 섞이면 parseInt → 0, avg ".000" 인 레코드가 실제 upsert 됨(기존값 파괴)
 *
 * 검증 대상: KBO 503/204/200-empty/timeout/partial 각각 Naver 복구, dual-fail 시 upsert 미수행,
 * Naver 미커버 컬럼(pa/sac/sf)·미매칭 kbo_id 를 덮어쓰지 않는지.
 *
 * 스텁 전략: 모듈 목킹 없이 global fetch 만 가로챈다. supabase-js 도 fetch 로 나가므로
 * PostgREST upsert 요청을 그대로 관측할 수 있고, route 의 실제 코드경로가 그대로 실행된다.
 */
import assert from "node:assert/strict";

import "./_stats-cron-smoke-env";
import { GET } from "@/app/api/cron/stats/route";

// ── 관측 버퍼 ─────────────────────────────────────────────────────────────
interface UpsertCall {
  table: string;
  rows: Record<string, unknown>[];
}
let upserts: UpsertCall[] = [];
let jobStatuses: string[] = [];
let jobMessages: (string | null)[] = [];

const TEAMS10 = ["LG", "두산", "KT", "SSG", "NC", "KIA", "롯데", "삼성", "한화", "키움"];

// ── KBO HTML fixtures (실 컬럼 인덱스 준수) ───────────────────────────────
function hitterRow(i: number): string {
  const c = [
    `${i + 1}`, `타자${i}`, TEAMS10[i % 10], ".327", "99", "432", "367",
    "64", "120", "24", "2", "4", "160", "49", "7", "3",
  ];
  return `<tr>${c.map((x) => `<td>${x}</td>`).join("")}</tr>`;
}
function pitcherRow(i: number): string {
  const c = [
    `${i + 1}`, `투수${i}`, TEAMS10[i % 10], "2.64", "19", "9", "3", "0", "0",
    "0.750", "105 2/3", "90", "4", "47", "4", "97", "43", "31", "1.30",
  ];
  return `<tr>${c.map((x) => `<td>${x}</td>`).join("")}</tr>`;
}
const KBO_HITTER_HTML = `<table><tbody>${Array.from({ length: 40 }, (_, i) => hitterRow(i)).join("")}</tbody></table>`;
const KBO_HITTER_PAGE_BOUNDARY_HTML = `<table><tbody>${Array.from({ length: 30 }, (_, i) => hitterRow(i)).join("")}</tbody></table>`;
const KBO_PITCHER_HTML = `<table><tbody>${Array.from({ length: 19 }, (_, i) => pitcherRow(i)).join("")}</tbody></table>`;
const EMPTY_TABLE_HTML = "<table><tbody></tbody></table>";
// KBO 503/302 본문에는 표가 아예 없다(실측: 302 본문 <tbody> 부재).
const ERROR_BODY = "<html><body>Service Unavailable</body></html>";

// ── Naver fixtures (실 응답 스키마 준수) ──────────────────────────────────
function naverHitters(n: number) {
  return {
    success: true,
    result: {
      seasonPlayerStats: Array.from({ length: n }, (_, i) => ({
        playerId: `5${String(i).padStart(4, "0")}`,
        playerName: `타자${i}`,
        teamName: TEAMS10[i % 10],
        hitterHra: 0.3498694516971279,
        hitterGameCount: 97,
        hitterAb: 383,
        hitterRun: 49,
        hitterHit: 134,
        hitterH2: 22,
        hitterH3: 1,
        hitterHr: 13,
        hitterRbi: 70,
      })),
    },
  };
}
function naverPitchers(n: number) {
  return {
    success: true,
    result: {
      seasonPlayerStats: Array.from({ length: n }, (_, i) => ({
        playerId: `6${String(i).padStart(4, "0")}`,
        playerName: `투수${i}`,
        teamName: TEAMS10[i % 10],
        pitcherEra: 2.640378548895899,
        pitcherGameCount: 19,
        pitcherWin: 9,
        pitcherLose: 3,
        pitcherSave: 0,
        pitcherHold: 0,
        pitcherWra: 0.75,
        pitcherInning: "105 2/3",
        pitcherHit: 90,
        pitcherHr: 4,
        pitcherBb: 47,
        pitcherHp: 4,
        pitcherKk: 97,
        pitcherR: 43,
        pitcherEr: 31,
        pitcherWhip: 1.3,
      })),
    },
  };
}

type KboMode =
  | "ok"
  | "503"
  | "204"
  | "empty"
  | "timeout"
  | "partial-row"
  | "valid-partial"
  | "page-boundary"
  | "bad-numeric"
  | "one-sort-fails";
type NaverMode =
  | "ok"
  | "500"
  | "timeout"
  | "empty"
  | "schema"
  | "truncated"
  | "pagesize-full"
  | "duplicate-names"
  | "team-skew"
  | "bad-inning";

const realFetch = globalThis.fetch;

function installFetch(kbo: KboMode, naver: NaverMode, dbFail = false) {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String((input as { url?: string })?.url ?? input);

    // ── Supabase PostgREST: upsert 페이로드 관측 + job 로그 흡수 ──
    if (url.includes("127.0.0.1:54321")) {
      const table = url.split("/rest/v1/")[1]?.split("?")[0] ?? "";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (table.startsWith("player_stats_") && Array.isArray(body)) {
        upserts.push({ table, rows: body });
        if (dbFail) return Response.json({ message: "forced upsert failure" }, { status: 500 });
        return Response.json([]);
      }
      if (table === "admin_job_logs") {
        // startJob/finishJob 은 .single() 을 쓰므로 배열이 아닌 단일 객체로 응답해야
        // logId 가 정상 반환된다(배열이면 logId=undefined → finishJob 조기 return).
        if (init?.method === "POST") return Response.json({ id: 1 });
        if (init?.method === "PATCH") {
          if (body?.status) {
            jobStatuses.push(String(body.status));
            jobMessages.push(body.error_message == null ? null : String(body.error_message));
          }
          return Response.json({});
        }
        return Response.json({ started_at: new Date().toISOString() });
      }
      return Response.json([]);
    }

    if (url.includes("koreabaseball.com")) {
      const isPitcher = url.includes("PitcherBasic");
      switch (kbo) {
        case "503":
          return new Response(ERROR_BODY, { status: 503 });
        case "204":
          return new Response(null, { status: 204 });
        case "empty":
          return new Response(EMPTY_TABLE_HTML, { status: 200 });
        case "timeout":
          throw Object.assign(new Error("The operation was aborted due to timeout"), {
            name: "TimeoutError",
          });
        case "partial-row": {
          // 200 이지만 안내문 행(셀 부족·팀명 없음) 혼입 → 수정 전엔 0/".000" 레코드로 upsert 됐다.
          const bad = "<tr><td>등록된 기록이 없습니다.</td></tr>";
          const good = isPitcher ? pitcherRow(0) : hitterRow(0);
          return new Response(`<table><tbody>${good}${bad}</tbody></table>`, { status: 200 });
        }
        case "valid-partial":
          return new Response(
            `<table><tbody>${isPitcher ? pitcherRow(0) : hitterRow(0)}</tbody></table>`,
            { status: 200 },
          );
        case "page-boundary":
          return new Response(
            isPitcher ? KBO_PITCHER_HTML : KBO_HITTER_PAGE_BOUNDARY_HTML,
            { status: 200 },
          );
        case "bad-numeric": {
          const row = (isPitcher ? pitcherRow(0) : hitterRow(0)).replace(
            isPitcher ? "2.64" : ".327",
            "N/A",
          );
          return new Response(`<table><tbody>${row}</tbody></table>`, { status: 200 });
        }
        case "one-sort-fails":
          if (isPitcher && url.includes("sort=SV_CN")) {
            return new Response(ERROR_BODY, { status: 503 });
          }
          return new Response(isPitcher ? KBO_PITCHER_HTML : KBO_HITTER_HTML, { status: 200 });
        default:
          return new Response(isPitcher ? KBO_PITCHER_HTML : KBO_HITTER_HTML, { status: 200 });
      }
    }

    if (url.includes("api-gw.sports.naver.com")) {
      const isPitcher = url.includes("playerType=PITCHER");
      switch (naver) {
        case "500":
          return new Response("{}", { status: 500 });
        case "timeout":
          throw Object.assign(new Error("aborted due to timeout"), { name: "TimeoutError" });
        case "empty":
          return Response.json({ success: true, result: { seasonPlayerStats: [] } });
        case "schema":
          return Response.json({ success: false });
        case "truncated":
          // pageSize 무시하고 첫 100명만 반환(war-benchmark 에서 실제 거론 전력)
          return Response.json(isPitcher ? naverPitchers(100) : naverHitters(100));
        case "pagesize-full":
          // pageSize 에 꿉 차게 반환 → 더 받을 게 남았을 수 있음
          return Response.json(isPitcher ? naverPitchers(500) : naverHitters(500));
        case "duplicate-names": {
          const fixture = isPitcher ? naverPitchers(200) : naverHitters(300);
          const rows = fixture.result.seasonPlayerStats;
          rows[1].playerName = rows[0].playerName;
          rows[1].teamName = rows[0].teamName;
          return Response.json(fixture);
        }
        case "team-skew": {
          const fixture = isPitcher ? naverPitchers(200) : naverHitters(300);
          for (const row of fixture.result.seasonPlayerStats) row.teamName = "LG";
          return Response.json(fixture);
        }
        case "bad-inning": {
          const fixture = isPitcher ? naverPitchers(200) : naverHitters(300);
          if (isPitcher) fixture.result.seasonPlayerStats[0].pitcherInning = "not-an-inning";
          return Response.json(fixture);
        }
        default:
          return Response.json(isPitcher ? naverPitchers(200) : naverHitters(329));
      }
    }

    // 텔레그램 알림 등 부수 호출은 무해하게 흡수
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
}

function req() {
  return {
    headers: {
      get: (k: string) =>
        k.toLowerCase() === "authorization" ? `Bearer ${process.env.CRON_SECRET}` : null,
    },
  } as unknown as Parameters<typeof GET>[0];
}

async function run(kbo: KboMode, naver: NaverMode, dbFail = false) {
  upserts = [];
  jobStatuses = [];
  jobMessages = [];
  installFetch(kbo, naver, dbFail);
  const res = await GET(req());
  const body = (await res.json()) as Record<string, never>;
  return { status: res.status, body };
}

const batterUpserts = () => upserts.filter((u) => u.table === "player_stats_batter");
const pitcherUpserts = () => upserts.filter((u) => u.table === "player_stats_pitcher");
const allRows = (us: UpsertCall[]) => us.flatMap((u) => u.rows);

let pass = 0;
function ok(name: string) {
  pass++;
  console.log(`  ✅ ${name}`);
}

async function main() {

  // ── 1. 정상 경로: 타자=Naver(공식 1차)·투수=KBO(공식 1차) → success·경보 없음 ───
  {
    const { status, body } = await run("ok", "ok");
    assert.equal(status, 200);
    assert.equal(body["sources"]["batter"], "naver", "타자 공식 1차는 Naver");
    assert.equal(body["sources"]["pitcher"], "kbo", "투수 공식 1차는 KBO");
    const rows = allRows(batterUpserts());
    assert.ok(rows.length > 0, "타자 upsert 수행");
    assert.ok(
      rows.every((r) => !("pa" in r) && !("sac" in r) && !("sf" in r)),
      "Naver 미커버 컴럼(pa/sac/sf)은 페이로드 제외 → 기존값 보존",
    );
    const p = allRows(pitcherUpserts());
    assert.ok("hbp" in p[0], "투수 KBO 경로 컴럼 유지");
    assert.equal(jobStatuses.at(-1), "success");
    assert.equal(jobMessages.at(-1), null, "공식 1차 수집은 경보 메시지 없음");
    ok("1. 정상 경로: 타자 Naver 1차·투수 KBO 1차 = success(경보 없음)");
  }

  // ── 1b. Naver 타자 실패 → KBO 폴백(40행) 채택 + pa/sac/sf 포함 + warning ────
  {
    const { status, body } = await run("ok", "500");
    assert.equal(status, 200);
    assert.equal(body["sources"]["batter"], "kbo", "Naver 실패 시 KBO 폴백");
    assert.equal(body["sources"]["pitcher"], "kbo", "투수는 1차 KBO 그대로");
    const rows = allRows(batterUpserts());
    assert.ok("pa" in rows[0] && "sac" in rows[0] && "sf" in rows[0], "KBO 경로는 pa/sac/sf 포함");
    assert.equal(rows[0].pa, 432);
    assert.equal(rows[0].sac, 7);
    assert.equal(rows[0].sf, 3);
    assert.equal(jobStatuses.at(-1), "warning", "폴백 수집은 warning");
    assert.ok(
      String(jobMessages.at(-1)).includes("타자 1차(naver) 실패 → kbo 폴백"),
      `경보 메시지에 폴백 종류·방향 명시: ${jobMessages.at(-1)}`,
    );
    ok("1b. Naver 타자 실패 → KBO 40행 폴백(pa/sac/sf 원값) + warning 메시지 명시");
  }

  // ── 2~5. KBO 하드실패(503/204/200-empty/timeout) → 투수 Naver 폴백(타자는 원래 Naver 1차) ──
  for (const mode of ["503", "204", "empty", "timeout"] as KboMode[]) {
    const { status, body } = await run(mode, "ok");
    assert.equal(status, 200, `${mode}: Naver 복구로 200`);
    assert.equal(body["sources"]["batter"], "naver", `${mode}: 타자 Naver`);
    assert.equal(body["sources"]["pitcher"], "naver", `${mode}: 투수 Naver`);
    assert.ok(Number(body["batters"]) > 0 && Number(body["pitchers"]) > 0, `${mode}: 빈 수집 아님`);

    const b = allRows(batterUpserts());
    assert.ok(
      b.every((r) => !("pa" in r) && !("sac" in r) && !("sf" in r)),
      `${mode}: Naver 미커버 컬럼(pa/sac/sf) 페이로드 제외 → 기존값 보존`,
    );
    // TB 파생: H134 + 2B22 + 2×3B1 + 3×HR13 = 197
    assert.equal(b[0].tb, 197, `${mode}: TB 파생 정확`);
    assert.equal(b[0].avg, ".350", `${mode}: avg 앞 0 제거 표기`);

    const p = allRows(pitcherUpserts());
    assert.equal(p[0].era, "2.64", `${mode}: era 표기`);
    assert.equal(p[0].ip, "105 2/3", `${mode}: IP 분수 문자열 보존`);
    assert.equal(p[0].whip, "1.30", `${mode}: whip 표기`);
    assert.equal(p[0].wpct, "0.750", `${mode}: wpct 표기`);
    assert.equal(jobStatuses.at(-1), "warning", `${mode}: 투수 failover 는 warning`);
    assert.ok(
      String(jobMessages.at(-1)).includes("투수 1차(kbo) 실패 → naver 폴백"),
      `${mode}: 경보 메시지에 투수 폴백 명시 (${jobMessages.at(-1)})`,
    );
    assert.ok(
      !String(jobMessages.at(-1)).includes("타자"),
      `${mode}: 타자는 공식 1차(naver) 성공이므로 경보 미포함`,
    );
    ok(`KBO ${mode} → 투수 Naver 복구 + 미커버 컬럼 보존 + 표기계약 유지`);
  }

  // ── 6. KBO partial(안내문 행) → 0/".000" 오염 upsert 금지 ─────────────────
  {
    const { body } = await run("partial-row", "ok");
    assert.equal(body["sources"]["batter"], "naver", "partial 은 KBO 채택 금지");
    const b = allRows(batterUpserts());
    assert.ok(
      b.every((r) => r.name && r.avg !== ".000" && r.games !== 0),
      "partial: 0/빈값 레코드가 upsert 되지 않음",
    );
    const p = allRows(pitcherUpserts());
    assert.ok(
      p.every((r) => r.name && r.era !== "0.00"),
      "partial: 투수도 0값 오염 없음",
    );
    ok("6. KBO partial(셀 부족·미지팀 행) → 0값 오염 없이 Naver 복구");
  }

  // ── 7. 투수 sort 1개만 실패 → Naver 전체 복구 ─────────────────────────────
  {
    const { body } = await run("one-sort-fails", "ok");
    assert.equal(body["sources"]["pitcher"], "naver", "sort 1개 실패는 부분 KBO 채택 금지");
    assert.ok(Number(body["pitchers"]) > 0);
    ok("7. 투수 sort 부분 실패는 Naver 전체 복구");
  }

  // ── 8~11. dual-fail → upsert 미수행 (fail-close, 기존행 보존) ─────────────
  for (const nmode of [
    "500",
    "timeout",
    "empty",
    "schema",
    "truncated",
    "pagesize-full",
  ] as NaverMode[]) {
    const { status } = await run("503", nmode);
    assert.equal(status, 500, `dual-fail(${nmode}): 500 응답`);
    assert.equal(upserts.length, 0, `dual-fail(${nmode}): upsert 0건 → 기존 선수 스탯 보존`);
    assert.equal(jobStatuses.at(-1), "error", `dual-fail(${nmode}): job=error`);
    ok(`KBO 503 + Naver ${nmode} → fail-close (upsert 0건, 기존행 무손상)`);
  }

  // ── 13. Naver 절단 목록은 부분 갱신으로 채택하지 않는다(나머지 선수 stale 방지) ──
  {
    const { status } = await run("503", "truncated");
    assert.equal(status, 500, "절단 목록은 부분 채택 금지");
    assert.equal(upserts.length, 0, "절단 목록으로 상위 100명만 덮어쓰지 않음");
    ok("13. Naver 절단(첫 100명) → 부분 upsert 없이 fail-close");
  }

  // ── 12. Naver playerId가 durable identity로 보존됨 ─────────────────────────
  {
    await run("503", "ok");
    for (const u of [...batterUpserts(), ...pitcherUpserts()]) {
      assert.ok(u.rows.every((r) => r.player_key), "모든 행에 player_key 존재");
      assert.equal(
        new Set(u.rows.map((r) => r.player_key)).size,
        u.rows.length,
        "한 upsert 안의 identity key unique",
      );
    }
    ok("12. Naver playerId를 durable unique identity로 보존");
  }

  // ── 14. 같은 팀 동명이인은 Naver playerId로 별도 행을 유지 ────────────────
  {
    const { status } = await run("503", "duplicate-names");
    assert.equal(status, 200);
    const keys = allRows(batterUpserts())
      .filter((r) => r.name === "타자0" && r.team === "LG")
      .map((r) => r.player_key);
    assert.equal(keys.length, 2);
    assert.equal(new Set(keys).size, 2);
    ok("14. 동일 name+team 동명이인 2명을 playerId로 분리 저장");
  }

  // ── 15. 필수 upsert 실패는 HTTP 500 / ok:false ─────────────────────────────
  {
    const { status, body } = await run("503", "ok", true);
    assert.equal(status, 500);
    assert.equal(body["ok"], false);
    assert.equal(jobStatuses.at(-1), "error");
    ok("15. PostgREST upsert 실패 → non-2xx fail-close");
  }

  // ── 16. valid-looking KBO partial·비수치도 Naver로 전환 ────────────────────
  for (const mode of ["valid-partial", "bad-numeric"] as KboMode[]) {
    const { status, body } = await run(mode, "ok");
    assert.equal(status, 200);
    assert.equal(body["sources"]["batter"], "naver");
    assert.equal(body["sources"]["pitcher"], "naver");
    ok(`16. KBO ${mode} → Naver 전체 복구`);
  }

  // ── 17. Naver 팀 편중·잘못된 이닝은 fail-close ─────────────────────────────
  for (const mode of ["team-skew", "bad-inning"] as NaverMode[]) {
    const { status } = await run("503", mode);
    assert.equal(status, 500);
    assert.equal(upserts.length, 0);
    ok(`17. Naver ${mode} malformed 200 → upsert 0`);
  }

  // ── 18. KBO 30행 페이지 경계는 폴백으로도 채택 금지(31위 이하 stale 방지 계약 유지) ──
  {
    // 타자: Naver(1차) 실패 → KBO 폴백이 30행 단일 페이지 → coverage invalid → dual-fail
    const { status } = await run("page-boundary", "500");
    assert.equal(status, 500, "30행 폴백은 부분 채택 없이 fail-close");
    assert.equal(upserts.length, 0, "30행만으로 상위 30명만 덮어쓰지 않음");
    assert.equal(jobStatuses.at(-1), "error");
    ok("18. KBO 타자 30행 페이지 경계 → 폴백 채택 금지(fail-close, 기존행 보존)");
  }

  globalThis.fetch = realFetch;
  console.log(`\n✅ stats-cron Naver failover 회귀 ${pass}건 전체 통과`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
