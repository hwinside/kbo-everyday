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
import { answerQuestion, type QaDeps } from "../../src/lib/baseball-qa/pipeline";
import { loadRosterPlayers } from "../../src/lib/baseball-qa/roster/load-roster-players";
import { calcBatterSaberFromStats } from "../../src/lib/utils/sabermetrics-calc";

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

/** `/api/stats` 응답 형태 그대로. 실제 production payload 키를 쓴다.
 *
 * ⚠️ full=1 응답은 **리그 전체 명단**이어야 완전성 계약을 통과한다(#1159). 1~2행짜리
 * 픽스처는 운영에서 존재할 수 없는 형태라 그대로 두면 계약이 아니라 픽스처를 검증하게 된다.
 * `overrides` 로 준 행만 갈아끼우고 나머지는 실제 명단으로 채운다. */
function servedPayload(
  overrides: Array<Record<string, unknown>>,
  updatedAt = new Date().toISOString(),
) {
  const byId = new Map<string, Record<string, unknown>>();
  for (const row of STATIC_ROWS as unknown as Array<Record<string, unknown>>) {
    byId.set(String(row.kboId), row);
  }
  const extras: Array<Record<string, unknown>> = [];
  for (const row of overrides) {
    const id = String(row.kboId);
    if (byId.has(id)) byId.set(id, row);
    else extras.push(row);
  }
  const rows = [...byId.values(), ...extras];
  return {
    stats: rows,
    type: "batter",
    count: rows.length,
    source: "live",
    runnerSource: "live",
    updatedAt,
  };
}
/** 완전성 계약 자체를 깨는 픽스처(운영에서는 부분 응답 = 조회 실패). */
function partialPayload(rows: Array<Record<string, unknown>>, updatedAt = new Date().toISOString()) {
  return { stats: rows, type: "batter", count: rows.length, source: "live", runnerSource: "live", updatedAt };
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

  /**
   * ⚠️ 위 두 검사는 **소스 문자열**이다 — 삼순 #1100 6차 P0: 소스만 보면
   * `server.ts` 배선을 지워도 게이트가 GREEN 이다. 그래서 **실제 `makeDeps()` 를
   * 호출해** 주입물이 존재하는지를 직접 확인한다. supabase admin 모듈이
   * import 시점에 env 를 요구하므로 더미 env 를 채우고 dynamic import 한다.
   */
  await check("production makeDeps() 가 실제로 served/team fetcher 를 물고 나온다", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://gate.invalid.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY ||= "gate-dummy";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "gate-dummy";
    const mod = await import("../../src/lib/baseball-qa/server");
    assert.equal(typeof mod.makeDeps, "function", "makeDeps 를 직접 태울 수 없다");
    const deps = mod.makeDeps(1, null) as QaDeps;
    assert.equal(
      typeof deps.fetchServedRecord, "function",
      "production deps 에 fetchServedRecord 가 없다 — 도루/OPS/WAR 기능이 0 이다",
    );
    assert.equal(
      typeof deps.fetchSeasonRecord, "function",
      "production deps 에 fetchSeasonRecord 가 없다 — 교차검증이 불가능하다",
    );
    assert.ok(deps.fetchTeamRecord, "production deps 에 fetchTeamRecord 가 없다 — 구단 수치 기능이 0 이다");
    assert.equal(
      typeof deps.fetchTeamRecord!.fetchStandings, "function",
      "fetchStandings 주입이 끊겼다",
    );
    assert.equal(
      typeof deps.fetchTeamRecord!.fetchTeamRecords, "function",
      "fetchTeamRecords 주입이 끊겼다",
    );
    assert.equal(deps.enablePlayerRag, true, "production 이 선수 RAG 를 꺼놓았다");
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
  await check("같은 kboId 가 2행이면 답하지 않는다 (payload 단계 fail-close)", async () => {
    // #1159 이후 중복 identity 는 payload 완전성 계약에서 먼저 거절된다 —
    // 종전(행을 넘겨 resolveSeasonRecord 가 inconsistent) 보다 더 앞에서 닫히지만
    // 계약의 뜻은 같다: **중복이면 답하지 않는다**.
    await assert.rejects(
      () => withFetch(
        async () => jsonResponse({
          ...servedPayload([servedRow]),
          stats: [...servedPayload([servedRow]).stats, { ...servedRow }],
          count: servedPayload([servedRow]).stats.length + 1,
        }),
        () => fetchServedBatterRows(subject.kboId),
      ),
      "중복 identity payload 로 값을 돌려줬다",
    );
    // 하류 판정기도 종전 계약을 그대로 유지한다(중복 행 → inconsistent).
    const dup = [servedRow, { ...servedRow }].map((row) => ({
      ...row, kbo_id: subject.kboId, player_key: subject.kboId,
      name: subject.name, team: subject.team, updated_at: new Date().toISOString(),
    }));
    const outcome = resolveSeasonRecord(
      dup as never,
      { table: "batter", metric: "sb", label: "도루", kind: "count" },
      subject.kboId,
      Date.now(),
      subject.name,
      subject.team,
    );
    assert.equal(outcome.kind, "inconsistent");
  });
  await check("부분 응답(리그 전체가 아님)은 조회 실패로 닫는다 (#1159 완전성)", async () => {
    await assert.rejects(
      () => withFetch(
        async () => jsonResponse(partialPayload([servedRow])),
        () => fetchServedBatterRows(subject.kboId),
      ),
      "1행짜리 부분 응답으로 값을 돌려줬다",
    );
  });

  // ── ④ 조회 실패는 fail-close — static 폴백 금지 ─────────────────────────
  for (const [label, stub] of [
    ["HTTP 500", async () => jsonResponse({}, 500)],
    ["stats 배열 없음", async () => jsonResponse({ updatedAt: new Date().toISOString(), type: "batter", count: 0 })],
    ["updatedAt 없음", async () => jsonResponse({ ...servedPayload([servedRow]), updatedAt: undefined })],
    ["updatedAt 파싱 불가", async () => jsonResponse({ ...servedPayload([servedRow]), updatedAt: "nope" })],
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
    // WAR — 저장 컬럼이 아니라 기본 스탯에서 파생되는 값(`calcBatterSaber`).
    // 앱은 선수 상세·기록실·세이버 카드에서 이미 보여주고 있었다.
    ["김도영 WAR 알려줘", "batter/war"],
    ["김도영 war 얼마야?", "batter/war"],
    // ⚠️ bare `wRC` 는 **거절**이다 — wRC ≠ wRC+ 고 우린 wRC+ 만 계산한다.
    // 같은 값으로 답하면 다른 지표를 속여 답하는 것이다(삼순 #1100 8차 P0-1).
    ["김도영 wRC 얼마야", "untrusted_metric"],
    ["김도영 wRC+ 알려줘", "batter/wrc_plus"],
    ["김도영 wRC 플러스 얼마야", "batter/wrc_plus"],
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

  // ── ⑧ 종단 행동: deps 조립 → answerQuestion → served fetch → DB 교차 → 최종 답변 ────
  //
  // ⚠️ 왜 필요한가 (삼순 #1100 4차 P0-4):
  // 위 검사들은 모듈 단위만 봤다. 그래서 `useServed` 를 항상 false 로 만드는 mutation 에서도
  // 31/31 · full prebuild exit 0 이었다 — 기능이 죽어도 게이트가 GREEN 이었다는 뜻이다.
  // 이제 production 이 쓰는 seam 과 같은 주입으로 `answerQuestion()` 을 돌려 **최종 답변**까지 본다.
  const servedAnswerRun = async (
    overrides: Partial<QaDeps> = {},
    question = `${subject.name} 도루 몇 개야?`,
  ) => {
    const logs: string[] = [];
    let llmCalls = 0;
    const deps: QaDeps = {
      loadGlossary: async () => [],
      // 로스터도 실제 배포 함수로 읽는다(자체 fixture 금지 — 삼순 8차 P0-2).
      loadPlayers: loadRosterPlayers,
      getCache: async () => null,
      setCache: async () => {},
      callLlm: async () => {
        llmCalls += 1;
        return { text: '{"status":"ANSWER","answer":"야구 룰 답변이에요."}', inputTokens: 1, outputTokens: 1 };
      },
      reserveDaily: async (_u, limit) => ({ allowed: true, remaining: limit - 1 }),
      log: async (entry) => { logs.push(entry.matchPath); },
      // ⚠️ production(`server.ts makeDeps`)이 켜는 플래그. 빠뜨리면 선수 후보 자체가 안 잡혀
      // 기록 경로에 도달조차 못 한다(실측: 이 한 줄이 없어서 history_hold 로 끝났다).
      enablePlayerRag: true,
      // ⬇️ production 과 동일한 seam. 이걸 지우거나 무력화하는 mutation 은 RED 가 돼야 한다.
      fetchServedRecord: createServedRecordFetcher(),
      fetchSeasonRecord: async () => [dbRow()],
      ...overrides,
    };
    const result = await withFetch(
      async () => jsonResponse(servedPayload([servedRow])),
      () => answerQuestion("u-served-e2e", question, deps),
    );
    return { result, logs, llmCalls };
  };

  /**
   * ⚠️ 종단 질문이 **도루 하나뿐**이면, factory 가 `war`·`wrc_plus` 만 strip 하는
   * 회귀를 잡지 못한다(삼순 #1100 8차 P0-4). 파생 지표도 같은 종단으로 태운다.
   */
  for (const [label, question, expected] of [
    ["WAR", `${subject.name} WAR 알려줘`, String(servedSeasonRow.war)],
    ["wRC+", `${subject.name} wRC+ 알려줘`, String(servedSeasonRow.wrc_plus)],
  ] as const) {
    await check(`종단: ${label} 질문이 화면과 같은 파생값으로 답해진다`, async () => {
      const { result, logs, llmCalls } = await servedAnswerRun({}, question);
      assert.equal(result.source, "kbo_structured", `source=${result.source} (기록 경로를 안 탐)`);
      assert.ok(
        result.answer?.includes(expected),
        `답변에 ${label} 값 ${expected} 이 없다: ${result.answer}`,
      );
      assert.equal(llmCalls, 0, `${label} 질문을 LLM 으로 보냈다(환각 경로)`);
      assert.deepEqual(logs, ["kbo_structured"], `match_path 불일치: ${logs.join(",")}`);
    });
  }

  await check("종단: 도루 질문이 앱 서빙값으로 답해진다", async () => {
    const { result, logs, llmCalls } = await servedAnswerRun();
    assert.equal(result.source, "kbo_structured", `source=${result.source} (기록 경로를 안 탐)`);
    assert.ok(
      result.answer?.includes(String(servedSb)),
      `답변에 앱 서빙값 ${servedSb} 이 없다: ${result.answer}`,
    );
    assert.ok(
      !result.answer?.includes(`${staticSb}개`),
      `static 값 ${staticSb} 을 답했다 — 앱과 다른 숫자`,
    );
    assert.equal(llmCalls, 0, "기록 질문을 LLM 으로 보냈다(환각 경로)");
    assert.deepEqual(logs, ["kbo_structured"], `match_path 불일치: ${logs.join(",")}`);
  });

  await check("종단: served 주입이 끊기면 값을 답하지 않는다", async () => {
    const { result } = await servedAnswerRun({ fetchServedRecord: undefined });
    assert.notEqual(result.source, "kbo_structured", "주입이 없는데 수치를 답했다");
    assert.ok(!result.answer?.includes(String(servedSb)), "주입이 없는데 값이 나갔다");
  });

  await check("종단: DB 교차검증이 갈라지면 답하지 않는다", async () => {
    const { result } = await servedAnswerRun({
      fetchSeasonRecord: async () => [{ ...dbRow(), hr: Number(servedSeasonRow.hr) + 5 }],
    });
    assert.notEqual(result.source, "kbo_structured", "두 소스가 갈라졌는데 답했다");
  });

  // 실제 server.makeDeps가 조립한 fetcher를 그대로 태운다. 모듈별 seam을 테스트가 직접
  // 재조립하면 server.ts 주입을 제거해도 GREEN이었던 5차 P0를 다시 만든다.
  await check("production server → answerQuestion → served 종단이 실제 값으로 답한다", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "gate-placeholder";
    process.env.SUPABASE_SERVICE_ROLE_KEY ||= "gate-placeholder";
    const { makeDeps: makeServerDeps } = await import("../../src/lib/baseball-qa/server");
    const wired = makeServerDeps(9_110_000);
    assert.equal(typeof wired.fetchServedRecord, "function", "server.makeDeps의 served 주입이 끊겼다");

    const logs: string[] = [];
    let llmCalls = 0;
    const deps: QaDeps = {
      ...wired,
      loadGlossary: async () => [],
      loadPlayers: loadRosterPlayers,
      getCache: async () => null,
      setCache: async () => {},
      callLlm: async () => {
        llmCalls += 1;
        return { text: '{"status":"ANSWER","answer":"999"}', inputTokens: 1, outputTokens: 1 };
      },
      reserveDaily: async (_u, limit) => ({ allowed: true, remaining: limit - 1 }),
      log: async (entry) => { logs.push(entry.matchPath); },
      fetchSeasonRecord: async () => [dbRow()],
      // 핵심: fetchServedRecord는 wired 값을 덮지 않는다.
    };
    const result = await withFetch(
      async () => jsonResponse(servedPayload([servedRow])),
      () => answerQuestion("u-server-wiring", `${subject.name} 도루 몇 개야?`, deps),
    );
    assert.equal(result.source, "kbo_structured");
    assert.ok(result.answer?.includes(String(servedSb)), `server 종단 답변=${result.answer}`);
    assert.equal(llmCalls, 0);
    assert.deepEqual(logs, ["kbo_structured"]);
  });

  /**
   * production 진입점 결속을 **AST 로** 고정한다 (삼순 #1100 7차 P0-1).
   *
   * ⚠️ 종전은 파일 전체 대상 정규식 1개였다. 그러면 파일 아무 데나 죽은 decoy 호출
   * (`answerQuestion(userId, question, makeDeps(messageId, picked))`)를 하나 남겨두고
   * 실제 호출만 다른 deps 로 바꿔도 GREEN 이다.
   * 그래서 **`processBaseballQaQuestion` 함수 본문 안**으로 범위를 좁히고,
   * 그 안의 `answerQuestion` 호출이 **유일**하며 3번째 인자가 `makeDeps(...)` 호출임을
   * 구문 트리에서 직접 확인한다. 바깥 decoy 는 세지 않고, 안쪽을 바꾸면 즉시 RED 다.
   */
  await check("processBaseballQaQuestion 본문이 makeDeps 로 answerQuestion 을 호출한다(AST)", async () => {
    const ts = (await import("typescript")).default;
    const sf = ts.createSourceFile(
      "server.ts", SERVER_SRC, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS,
    );
    let target: import("typescript").FunctionDeclaration | undefined;
    sf.forEachChild((node) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === "processBaseballQaQuestion") {
        target = node;
      }
    });
    assert.ok(target?.body, "processBaseballQaQuestion 함수를 찾지 못했다");

    const calls: import("typescript").CallExpression[] = [];
    const walk = (node: import("typescript").Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "answerQuestion"
      ) {
        calls.push(node);
      }
      node.forEachChild(walk);
    };
    walk(target!.body!);

    assert.equal(
      calls.length, 1,
      `본문 안 answerQuestion 호출이 ${calls.length}개 — 정확히 1개여야 한다(decoy 분기 금지)`,
    );
    const depsArg = calls[0].arguments[2];
    assert.ok(depsArg, "answerQuestion 에 deps 인자가 없다");
    assert.ok(
      ts.isCallExpression(depsArg) &&
      ts.isIdentifier(depsArg.expression) &&
      depsArg.expression.text === "makeDeps",
      "deps 가 makeDeps(...) 호출이 아니다 — production 조립을 우회했다",
    );
  });

  // ── ⑨ allowlist 선언 정합 ───────────────────────────────────────────────
  await check("SERVED_ONLY 지표가 전부 BATTER_METRICS 에 선언돼 있다", () => {
    for (const metric of SERVED_ONLY_BATTER_METRICS) {
      assert.ok(metric in BATTER_METRICS, `${metric} 이 BATTER_METRICS 에 없다`);
      assert.equal(isServedOnlyMetric(metric), true);
    }
  });
  // ⚠️ WAR 이 서빙 전용 목록에서 빠지면 `김도영 WAR` 이 다시 "못 답한다" 안내로 죽는다.
  // 하린아빠 2026-08-04 20:42 "우리가 다 제공하고 있는 데이터인데" 의 재발 방지선이다.
  await check("WAR 이 서빙 전용 지표로 선언돼 있다", () => {
    assert.equal(isServedOnlyMetric("war"), true, "WAR 이 서빙 전용에서 빠졌다");
    assert.ok("war" in BATTER_METRICS, "WAR 이 BATTER_METRICS 에 없다");
    const intent = resolveSeasonRecordIntent("김도영 WAR 알려줘");
    assert.equal(
      intent.kind === "query" ? intent.query.metric : intent.kind, "war",
      "WAR 질문이 기록 조회로 매칭되지 않는다",
    );
  });
  // 화면과 같은 산식으로 만든 값인가 — 봇만 다른 숫자를 말하면 이 기능의 계약이 깨진다.
  await check("WAR·wRC+가 화면과 같은 공용 helper로 계산된다", () => {
    const expected = calcBatterSaberFromStats(servedSeasonRow);
    assert.ok(expected, "공용 helper가 표본을 계산하지 못했다");
    assert.equal(
      Number((servedSeasonRow as Record<string, unknown>).war), expected.WAR,
      `봇 WAR 이 화면 산식과 다르다 — 봇 ${(servedSeasonRow as Record<string, unknown>).war} vs 화면 ${expected.WAR}`,
    );
    assert.equal(
      Number((servedSeasonRow as Record<string, unknown>).wrc_plus), expected.wRC_plus,
      `봇 wRC+가 화면 산식과 다르다 — 봇 ${(servedSeasonRow as Record<string, unknown>).wrc_plus} vs 화면 ${expected.wRC_plus}`,
    );
  });
  await check("wRC+가 서빙 전용 지표로 선언돼 실제답 경로를 탄다", () => {
    assert.equal(isServedOnlyMetric("wrc_plus"), true);
    assert.ok("wrc_plus" in BATTER_METRICS);
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
