/**
 * 도루·출루율·장타율·OPS 를 **앱과 같은 숫자**로 답하는가 — 소스 정합 게이트.
 *
 * ⚠️ 이 게이트가 생긴 이유 (하린아빠 2026-08-04 20:42).
 *   "도루 OPS가 왜 없어?" / "우리가 다 제공하고 있는 데이터인데"
 *
 * 나는 `player_stats_batter` 테이블만 보고 "sb·ops 컬럼이 없으니 답할 수 없다"고 보고했다.
 * 틀렸다. 앱은 이미 이 값을 화면에 보여주고 있었다 — 선수 상세(`도루`·`OPS`), 팀 기록,
 * 타이틀 탭이 전부 `/api/stats` 를 쓴다.
 *
 * ⚠️ 그리고 **두 번째로 틀렸다**(삼순 3차 P0-3). 나는 그 정본을 `stats-2026-batters.json`
 * 이라고 썼지만, `/api/stats` 는 static row 를 그대로 주지 않는다 — live 크롤 결과 위에
 * 전페이지 Runner map 을 마지막에 덮어쓴다(`applyRunnerStats`).
 *   Production 실측 2026-08-04: 이주형(`50167`) `sb` — static `4` vs 앱 서빙 `0`.
 * static 을 읽으면 **봇 4 / 앱 0** 이다. 이 기능의 유일한 계약이 정면으로 깨진다.
 * DB 에는 sb 컬럼이 없어 교차검증으로도 검출 불가였다.
 *
 * 그래서 이 게이트의 핵심 계약은 **"봇은 앱이 서빙하는 그 값을 읽는다"** 이다:
 *   · 정본 소스가 `/api/stats` 응답이다 (static JSON 직접 읽기 금지)
 *   · static 과 서빙값이 다를 때 **서빙값**을 답한다
 *   · 조회 실패·신선도 불명이면 static 으로 폴백하지 않고 fail-close 한다
 *
 * 실행: npm run qa:genius-served-metrics
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import batterSnapshot from "../../src/lib/constants/stats-2026-batters.json";
import {
  BATTER_METRICS,
  isServedOnlyMetric,
  resolveSeasonRecordIntent,
  resolveSeasonRecord,
  SERVED_ONLY_BATTER_METRICS,
  type SeasonRecordRow,
} from "../../src/lib/baseball-qa/stats/season-record";
import {
  crossCheckServedAgainstDb,
  createServedRecordFetcher,
  fetchServedBatterRows,
} from "../../src/lib/baseball-qa/stats/served-record";

let pass = 0;
const failures: string[] = [];
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    pass += 1;
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failures.push(`${name}: ${(error as Error).message}`);
    console.error(`  ❌ ${name}: ${(error as Error).message}`);
  }
}

interface StaticRow { name: string; team: string; kboId: string; [k: string]: unknown }
const STATIC_ROWS = batterSnapshot as unknown as StaticRow[];

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const SERVED_SRC = readFileSync(
  path.join(REPO_ROOT, "src/lib/baseball-qa/stats/served-record.ts"),
  "utf8",
);
const SERVER_SRC = readFileSync(
  path.join(REPO_ROOT, "src/lib/baseball-qa/server.ts"),
  "utf8",
);

/** `/api/stats` 응답 형태 그대로. 실제 production payload 키를 쓴다. */
function servedPayload(rows: Array<Record<string, unknown>>, updatedAt = new Date().toISOString()) {
  return {
    stats: rows,
    type: "batter",
    count: rows.length,
    source: "live",
    runnerSource: "live",
    updatedAt,
  };
}

type FetchStub = (input: unknown, init?: unknown) => Promise<Response>;
const realFetch = globalThis.fetch;
function withFetch<T>(stub: FetchStub, fn: () => Promise<T>): Promise<T> {
  globalThis.fetch = stub as typeof globalThis.fetch;
  return fn().finally(() => { globalThis.fetch = realFetch; });
}
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function main() {
  // ── ① 정본 소스가 `/api/stats` 다 (static 직접 읽기 금지) ────────────────
  await check("served-record 가 static 타자 JSON 을 import 하지 않는다", () => {
    // ⚠️ 단순 문자열 포함으로 보면 **주석에 적은 사고 경위**까지 위반으로 잡는다(실측).
    // 사실상의 계약은 "이 모듈이 static JSON 을 **읽는가**"이므로 import 구문만 본다.
    const importsStatic =
      /import\s[^;]*from\s*["'][^"']*stats-2026-batters[^"']*["']/.test(SERVED_SRC) ||
      /require\(\s*["'][^"']*stats-2026-batters[^"']*["']\s*\)/.test(SERVED_SRC) ||
      /import\(\s*["'][^"']*stats-2026-batters[^"']*["']\s*\)/.test(SERVED_SRC);
    assert.equal(
      importsStatic, false,
      "정본 소스가 static JSON 으로 되돌아갔다 — 앱 서빙값과 갈라진다(이주형 sb 4 vs 0)",
    );
  });
  await check("served-record 가 /api/stats 를 조회한다", () => {
    assert.ok(/\/api\/stats\?type=batter&full=1/.test(SERVED_SRC), "서빙 엔드포인트 결속이 없다");
  });
  await check("server.ts 가 createServedRecordFetcher 를 주입한다", () => {
    assert.ok(
      /fetchServedRecord:\s*createServedRecordFetcher\(\)/.test(SERVER_SRC),
      "production 주입이 끊겼다",
    );
    assert.ok(
      /import\s*\{\s*createServedRecordFetcher\s*\}\s*from\s*"@\/lib\/baseball-qa\/stats\/served-record"/.test(SERVER_SRC),
      "production import 가 seam 을 가리키지 않는다",
    );
  });

  // ── ② static 과 서빙값이 다르면 **서빙값**을 답한다 (P0-3 핵심) ──────────
  const subject = STATIC_ROWS.find((r) => Number(r.sb) > 0)!;
  const staticSb = Number(subject.sb);
  const servedSb = staticSb + 7; // static 과 반드시 다른 값
  const servedRow = { ...subject, sb: servedSb };

  await check("서빙값이 static 과 다르면 서빙값을 읽는다(앱과 같은 숫자)", async () => {
    const rows = await withFetch(
      async () => jsonResponse(servedPayload([servedRow])),
      () => fetchServedBatterRows(subject.kboId),
    );
    assert.equal(rows.length, 1);
    assert.equal(
      Number(rows[0].sb), servedSb,
      `static 값(${staticSb})을 읽었다 — 앱이 서빙하는 값(${servedSb})과 다르다`,
    );
  });

  await check("production seam 도 같은 값을 돌려준다", async () => {
    const fetcher = createServedRecordFetcher();
    const rows = await withFetch(
      async () => jsonResponse(servedPayload([servedRow])),
      () => fetcher(subject.kboId),
    );
    assert.equal(Number(rows[0].sb), servedSb);
  });

  // ── ③ kboId exact — 이름 조회 금지(동명이인) ────────────────────────────
  await check("kboId exact 로 찾는다(같은 이름 다른 id 는 섞이지 않는다)", async () => {
    const impostor = { ...subject, kboId: "99999999", team: "롯데", sb: 999 };
    const rows = await withFetch(
      async () => jsonResponse(servedPayload([servedRow, impostor])),
      () => fetchServedBatterRows(subject.kboId),
    );
    assert.equal(rows.length, 1, `동명이인이 ${rows.length}행 섞였다`);
    assert.equal(rows[0].kbo_id, subject.kboId);
    assert.equal(rows[0].player_key, subject.kboId);
  });
  await check("없는 kboId 는 빈 배열(추측 금지)", async () => {
    const rows = await withFetch(
      async () => jsonResponse(servedPayload([servedRow])),
      () => fetchServedBatterRows("00000000"),
    );
    assert.deepEqual(rows, []);
  });
  await check("같은 kboId 가 2행이면 그대로 넘겨 fail-close 시킨다", async () => {
    const rows = await withFetch(
      async () => jsonResponse(servedPayload([servedRow, { ...servedRow }])),
      () => fetchServedBatterRows(subject.kboId),
    );
    assert.equal(rows.length, 2);
    const outcome = resolveSeasonRecord(
      rows,
      { table: "batter", metric: "sb", label: "도루", kind: "count" },
      subject.kboId,
      Date.now(),
      subject.name,
      subject.team,
    );
    assert.equal(outcome.kind, "inconsistent");
  });

  // ── ④ 조회 실패는 fail-close — static 폴백 금지 ─────────────────────────
  for (const [label, stub] of [
    ["HTTP 500", async () => jsonResponse({}, 500)],
    ["stats 배열 없음", async () => jsonResponse({ updatedAt: new Date().toISOString() })],
    ["updatedAt 없음", async () => jsonResponse({ stats: [servedRow] })],
    ["updatedAt 파싱 불가", async () => jsonResponse({ stats: [servedRow], updatedAt: "nope" })],
    ["네트워크 실패", async () => { throw new Error("network down"); }],
  ] as Array<[string, FetchStub]>) {
    await check(`${label} → 예외(static 으로 폴백하지 않는다)`, async () => {
      await assert.rejects(
        () => withFetch(stub, () => fetchServedBatterRows(subject.kboId)),
        `${label} 인데 값을 돌려줬다 — 앱과 다른 숫자를 답하게 된다`,
      );
    });
  }

  // ── ⑤ 신선도: 서빙 응답 시각으로 stale 판정한다 ─────────────────────────
  await check("서빙 응답 시각이 updated_at 으로 실린다", async () => {
    const at = "2026-08-04T13:27:14.005Z";
    const rows = await withFetch(
      async () => jsonResponse(servedPayload([servedRow], at)),
      () => fetchServedBatterRows(subject.kboId),
    );
    assert.equal(rows[0].updated_at, at);
  });
  await check("오래된 서빙값은 stale 로 닫힌다", async () => {
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const rows = await withFetch(
      async () => jsonResponse(servedPayload([servedRow], old)),
      () => fetchServedBatterRows(subject.kboId),
    );
    const outcome = resolveSeasonRecord(
      rows,
      { table: "batter", metric: "sb", label: "도루", kind: "count" },
      subject.kboId,
      Date.now(),
      subject.name,
      subject.team,
    );
    assert.equal(outcome.kind, "stale");
  });

  // ── ⑥ 질문 → 지표 매칭 ─────────────────────────────────────────────────
  const intentOf = (q: string) => {
    const i = resolveSeasonRecordIntent(q);
    return i.kind === "query" ? `${i.query.table}/${i.query.metric}` : i.kind;
  };
  for (const [question, expected] of [
    ["박해민 도루 몇 개야?", "batter/sb"],
    ["김도영 도루 알려줘", "batter/sb"],
    ["김도영 출루율 얼마야", "batter/obp"],
    ["구자욱 장타율 알려줘", "batter/slg"],
    ["문보경 OPS 알려줘", "batter/ops"],
  ] as const) {
    await check(`매칭 "${question}" → ${expected}`, () => {
      assert.equal(intentOf(question), expected);
    });
  }

  // ⚠️ `도루 실패`는 도루(sb)가 아니라 도루자(cs)다. `도루` 패턴이 먼저 매칭되면 오답이 된다.
  // 그리고 `실패 몇 개`가 투수 **패전**(`패 몇 개`)으로 새던 회귀도 여기서 잡는다(실측).
  for (const question of ["황성빈 도루 실패 몇 개야?", "박해민 도루자 몇 개야?"]) {
    await check(`경계 "${question}" → batter/cs`, () => {
      assert.equal(intentOf(question), "batter/cs");
    });
  }
  await check("투수 패전은 회귀 없음", () => {
    assert.equal(intentOf("류현진 몇 패"), "pitcher/losses");
    assert.equal(intentOf("김광현 패 몇 개"), "pitcher/losses");
  });
  await check("장타율이 타율로 새지 않는다", () => {
    assert.equal(intentOf("문보경 장타율 알려줘"), "batter/slg");
    assert.equal(intentOf("문보경 타율 알려줘"), "batter/avg");
  });

  // ── ⑦ 교차검증: identity·겹치는 지표가 갈라지면 답하지 않는다 ───────────
  const servedSeasonRow = await withFetch(
    async () => jsonResponse(servedPayload([servedRow])),
    () => fetchServedBatterRows(subject.kboId),
  ).then((r) => r[0]);
  const dbRow = (): SeasonRecordRow => ({
    player_key: subject.kboId, kbo_id: subject.kboId,
    name: subject.name, team: subject.team,
    updated_at: new Date().toISOString(),
    games: servedSeasonRow.games, ab: servedSeasonRow.ab, hits: servedSeasonRow.hits,
    hr: servedSeasonRow.hr, rbi: servedSeasonRow.rbi, runs: servedSeasonRow.runs,
    doubles: servedSeasonRow.doubles, triples: servedSeasonRow.triples, tb: servedSeasonRow.tb,
  });
  await check("두 소스가 같으면 통과", () => {
    assert.equal(crossCheckServedAgainstDb(servedSeasonRow, [dbRow()]).kind, "ok");
  });
  await check("겹치는 지표가 어긋나면 거부(앱과 다른 숫자 방지)", () => {
    const bad = { ...dbRow(), hr: Number(servedSeasonRow.hr) + 1 };
    const r = crossCheckServedAgainstDb(servedSeasonRow, [bad]);
    assert.equal(r.kind, "mismatch");
    assert.equal(r.kind === "mismatch" && r.metric, "hr");
  });
  await check("DB 행이 없으면 거부(확인 못 한 상태로 답하지 않는다)", () => {
    assert.equal(crossCheckServedAgainstDb(servedSeasonRow, []).kind, "no_db_row");
  });
  await check("DB 행이 2개면 거부", () => {
    assert.equal(crossCheckServedAgainstDb(servedSeasonRow, [dbRow(), dbRow()]).kind, "no_db_row");
  });
  await check("identity 가 다르면 거부", () => {
    const other = { ...dbRow(), kbo_id: "77777777", player_key: "77777777" };
    assert.equal(crossCheckServedAgainstDb(servedSeasonRow, [other]).kind, "mismatch");
  });

  // ── ⑧ allowlist 선언 정합 ───────────────────────────────────────────────
  await check("SERVED_ONLY 지표가 전부 BATTER_METRICS 에 선언돼 있다", () => {
    for (const metric of SERVED_ONLY_BATTER_METRICS) {
      assert.ok(metric in BATTER_METRICS, `${metric} 이 BATTER_METRICS 에 없다`);
      assert.equal(isServedOnlyMetric(metric), true);
    }
  });
  await check("DB 지표는 서빙 전용으로 분류되지 않는다", () => {
    for (const metric of ["avg", "hr", "rbi", "games"]) {
      assert.equal(isServedOnlyMetric(metric), false, `${metric} 을 서빙 전용으로 오분류`);
    }
  });

  if (failures.length > 0) {
    console.error(`\n❌ genius served metrics: PASS=${pass} FAIL=${failures.length}`);
    process.exit(1);
  }
  console.log(`\n✅ genius served metrics: ${pass} PASS (앱 서빙값 정합 + kboId exact + fail-close)`);
}

main().catch((error) => {
  console.error("❌ genius served metrics FAIL:", error);
  process.exit(1);
});
