/**
 * Regression smoke — 세레머니 발동 지연 fix(PR #899)의 per-inning last-good
 * 스냅샷 폴백을 production 함수로 직접 고정한다 (삼순 NO-GO 반영).
 *
 * 배경(버그)
 * ---------
 * relay event id = `${gameId}-${type}-${inningKey}-${batter}-${cumIdx}` 이고
 * cumIdx 는 game-wide 누적이다. 이닝 fetch 타임아웃 때 그 이닝을 `[]` 로 바꾸면
 * 뒤 이닝의 동일(타자,type) 이벤트 번호가 흔들리고(예: 5회 안타 `-2`→`-1`),
 * 복구되면 다시 `-2` 로 되돌아가 새 id 로 인식돼 세레머니가 중복 발화한다.
 *
 * 고정 대상
 * ---------
 *  (a) 과거 이닝 timeout(스냅샷 보유) → 뒤 이닝 play id 불변 → 복구 중복 0
 *  (b) 현재 이닝 timeout(스냅샷 보유) → 기존 relay(이닝/타석) 보존 (UI 안 사라짐)
 *  (c) route 최대 wall-clock bound(모든 fetch 에 AbortSignal.timeout) production wiring
 *
 * ⚠️ parseInningRelays 는 입력을 newest-first 로 가정하고 내부 reverse 한다.
 *    combineRelayInningsNewestFirst 도 이닝 배열을 reverse 후 flat 한다.
 *    fixture 는 production 이 저장하는 형태(이닝별 newest-first bundle)로 만든다.
 */

// route.ts 는 import 시 supabase admin 싱글톤을 즉시 생성한다(모듈 사이드이펙트).
// 순수함수만 검증하므로 실제 연결이 필요 없다 → 더미 env 를 import 전에 주입.
process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://smoke.local";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "smoke-anon-key";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { NaverTextRelay as _NaverTextRelay } from "@/app/api/game-relay/route";

type NaverTextRelay = _NaverTextRelay;

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  const {
    parseInningRelays,
    combineRelayInningsNewestFirst,
    resolveInningWithSnapshot,
  } = await import("@/app/api/game-relay/route");
  const { generateRelayEvents } = await import("@/lib/relay-event-generator");

  const GAME_ID = "20260726SSLG0";

  /** 이닝 1개 raw bundle: 헤더 + 안타 1개. 네이버는 newest-first 이므로
   *  타석(나중 발생)이 헤더(이닝 시작)보다 앞에 온다. */
  function inningBundle(inning: number, half: "초" | "말", team: string, batter: string): NaverTextRelay[] {
    const header: NaverTextRelay = { title: `${inning}회${half} ${team} 공격`, titleStyle: "0" };
    const atbat = {
      title: "",
      titleStyle: "8",
      textOptions: [{ seqno: 1, type: 13, text: `${batter} : 우익수 앞 안타` }],
    } as unknown as NaverTextRelay;
    return [atbat, header]; // newest-first
  }

  /** allTextRelays(이닝별 bundle 배열, index0=1회) → relay event id 목록. */
  function idsFrom(allTextRelays: NaverTextRelay[][]): string[] {
    const combined = combineRelayInningsNewestFirst(allTextRelays);
    const innings = parseInningRelays(combined);
    return generateRelayEvents(GAME_ID, innings, null).map((e) => e.id);
  }

  // 시나리오: 2회초·5회초 모두 동일 타자 "김성윤" 안타.
  const batter = "김성윤";
  const inn2 = inningBundle(2, "초", "삼성", batter);
  const inn5 = inningBundle(5, "초", "삼성", batter);
  const emptyInn = (): NaverTextRelay[] => [];
  const rawFull: NaverTextRelay[][] = [emptyInn(), inn2, emptyInn(), emptyInn(), inn5];

  // ---- baseline: 전 이닝 정상 fetch ----
  const fullIds = idsFrom(rawFull);
  const hitIds = fullIds.filter((id) => id.includes("at_bat_hit"));
  const fifthId = hitIds.find((id) => id.endsWith("-2"));
  check(
    "baseline: 5회 동일타자 안타 = cumIdx 2 (-2 suffix)",
    !!fifthId && hitIds.length === 2,
    `hitIds=${JSON.stringify(hitIds)}`,
  );

  // ---- (a) 과거 이닝(2회) timeout + 스냅샷 보유 → id 불변 ----
  const cacheWarm = new Map<string, NaverTextRelay[]>();
  // warm-up: 전 이닝 성공 → 스냅샷 적재
  rawFull.forEach((raw, idx) => resolveInningWithSnapshot(cacheWarm, `${GAME_ID}-${idx + 1}`, raw));

  // 다음 poll: 2회(index1) 만 timeout(null)
  let degradedA = false;
  const resolvedA = rawFull.map((raw, idx) => {
    const key = `${GAME_ID}-${idx + 1}`;
    const fetched = idx === 1 ? null : raw; // 2회 timeout
    const r = resolveInningWithSnapshot(cacheWarm, key, fetched);
    if (r.degraded) degradedA = true;
    return r.relays;
  });
  const idsA = idsFrom(resolvedA).filter((id) => id.includes("at_bat_hit"));
  check("(a) 과거이닝 timeout+스냅샷 → degraded=true", degradedA);
  check(
    "(a) 과거이닝 timeout+스냅샷 → 5회 안타 id 불변(-2)",
    JSON.stringify(idsA) === JSON.stringify(hitIds),
    `got=${JSON.stringify(idsA)} want=${JSON.stringify(hitIds)}`,
  );

  // 복구: 2회 다시 성공 → id 동일 → dedupe 로 중복 0
  const resolvedRecover = rawFull.map((raw, idx) =>
    resolveInningWithSnapshot(cacheWarm, `${GAME_ID}-${idx + 1}`, raw).relays,
  );
  const idsRecover = idsFrom(resolvedRecover).filter((id) => id.includes("at_bat_hit"));
  check(
    "(a) 복구 후 id 동일 → 신규(중복) 이벤트 0",
    JSON.stringify(idsRecover) === JSON.stringify(idsA),
    `recover=${JSON.stringify(idsRecover)}`,
  );

  // ---- 대조군: 스냅샷 없이(cold) 2회 timeout → id 흔들림(버그 재현) ----
  const cacheCold = new Map<string, NaverTextRelay[]>();
  const resolvedCold = rawFull.map((raw, idx) => {
    const fetched = idx === 1 ? null : raw; // 2회 timeout, 스냅샷 없음
    return resolveInningWithSnapshot(cacheCold, `${GAME_ID}-${idx + 1}`, fetched).relays;
  });
  const idsCold = idsFrom(resolvedCold).filter((id) => id.includes("at_bat_hit"));
  check(
    "대조군: 스냅샷 없으면 5회 안타가 -1 로 흔들림(=폴백이 방지하는 버그)",
    idsCold.length === 1 && idsCold[0].endsWith("-1"),
    `cold=${JSON.stringify(idsCold)}`,
  );

  // ---- (b) 현재 이닝(5회) timeout + 스냅샷 보유 → 이닝/타석 보존 ----
  // 5회 timeout(null), 스냅샷은 warm 상태에 이미 있음
  const resolvedB = rawFull.map((raw, idx) => {
    const fetched = idx === 4 ? null : raw; // 5회(현재) timeout
    return resolveInningWithSnapshot(cacheWarm, `${GAME_ID}-${idx + 1}`, fetched).relays;
  });
  const inningsB = parseInningRelays(combineRelayInningsNewestFirst(resolvedB));
  const fifthInning = inningsB.find((i) => i.inning === 5 && i.half === "top");
  check(
    "(b) 현재이닝 timeout+스냅샷 → 5회 이닝/타석 보존(UI 안 사라짐)",
    !!fifthInning && fifthInning.plays.length > 0,
    `fifth=${JSON.stringify(fifthInning?.plays?.length ?? null)}`,
  );

  // 대조: 스냅샷 없이 5회 timeout → 5회 소실(빈 폴백)
  const resolvedBcold = rawFull.map((raw, idx) => {
    const fetched = idx === 4 ? null : raw;
    return resolveInningWithSnapshot(new Map(), `${GAME_ID}-${idx + 1}`, fetched).relays;
  });
  const inningsBcold = parseInningRelays(combineRelayInningsNewestFirst(resolvedBcold));
  check(
    "(b) 대조: 스냅샷 없으면 5회 소실(폴백 필요 입증)",
    !inningsBcold.find((i) => i.inning === 5 && i.plays.length > 0),
  );

  // resolveInningWithSnapshot 순수 계약 4종 (unrecoverable 포함)
  const c = new Map<string, NaverTextRelay[]>();
  const s1 = resolveInningWithSnapshot(c, "g-1", inn2);
  check("pure: 성공 fetch → degraded=false·unrecoverable=false + 캐시 적재", !s1.degraded && !s1.unrecoverable && c.get("g-1") === inn2);
  const s2 = resolveInningWithSnapshot(c, "g-1", null);
  check("pure: 실패+스냅샷 → 스냅샷 반환 + degraded=true·unrecoverable=false", s2.degraded && !s2.unrecoverable && s2.relays === inn2);
  const s3 = resolveInningWithSnapshot(c, "g-2", null);
  check("pure: 실패+스냅샷없음 → [] + degraded=true·unrecoverable=true", s3.degraded && s3.unrecoverable && s3.relays.length === 0);
  const s4 = resolveInningWithSnapshot(c, "g-3", []);
  check("pure: 성공-빈배열(정상 미시작 이닝) → degraded=false·unrecoverable=false", !s4.degraded && !s4.unrecoverable && s4.relays.length === 0);

  // (3) monotonic/completeness guard: fetched 가 스냅샷보다 짧으면(transient
  //     truncation) 덮어쓰지 않고 스냅샷 유지(append-only 전제).
  const cm = new Map<string, NaverTextRelay[]>();
  const long2 = [...inn2, { title: "", titleStyle: "8", textOptions: [{ seqno: 2, type: 13, text: "두번째 : 안타" }] } as unknown as NaverTextRelay];
  resolveInningWithSnapshot(cm, "g-m", long2);            // 길이 3 스냅샷 적재
  const shorter = resolveInningWithSnapshot(cm, "g-m", inn2); // 길이 2 (짧음)
  check(
    "pure: 짧은 fetch → 스냅샷 유지·degraded=true (truncation 덮어쓰기 방지)",
    shorter.degraded && shorter.relays === long2 && cm.get("g-m") === long2,
  );
  const equalOrLonger = resolveInningWithSnapshot(cm, "g-m", long2);
  check("pure: 동일/긴 fetch → adopt·degraded=false", !equalOrLonger.degraded && cm.get("g-m") === long2);

  // ---- (d) executed production policy: resolveAllInnings 결과 계약 ----
  // 삼순 요구: source-regex 대신 실제 production 함수를 실행해 outcome 을 고정.
  const { resolveAllInnings } = await import("@/app/api/game-relay/route");

  // d-1) cold/no-snapshot 이닝 실패 → anyUnrecoverable=true (GET 이 503 단락)
  const coldOut = resolveAllInnings(new Map(), GAME_ID, [inn2, null, inn5]);
  check("(d-1) cold/no-snapshot 실패 → anyUnrecoverable=true", coldOut.anyUnrecoverable);

  // d-2) warm(스냅샷 보유) 이닝 실패 → degraded=true, unrecoverable=false, relays 보존
  const warmCache = new Map<string, NaverTextRelay[]>();
  resolveAllInnings(warmCache, GAME_ID, [inn2, inn2, inn5]); // 전 이닝 스냅샷 적재
  const warmOut = resolveAllInnings(warmCache, GAME_ID, [inn2, null, inn5]); // 2회 실패
  check(
    "(d-2) warm 실패 → degraded=true·unrecoverable=false + 2회 relays 보존",
    warmOut.anyDegraded && !warmOut.anyUnrecoverable && warmOut.relays[1].length > 0,
  );

  // d-3) malformed 200(textRelays 배열 아님)은 라우트에서 null 로 변환됨을 가정.
  //      resolveAllInnings 입력이 null 이면 cold 에선 unrecoverable, warm 에선 degraded.
  const malCold = resolveAllInnings(new Map(), GAME_ID, [null]);
  check("(d-3) malformed inning1(cold) → unrecoverable", malCold.anyUnrecoverable);

  // (2) 라우트가 malformed textRelays 를 null 로 분류하는지 소스 계약(Array.isArray)
  const here0 = dirname(fileURLToPath(import.meta.url));
  const routeSrc0 = readFileSync(resolve(here0, "../../src/app/api/game-relay/route.ts"), "utf8");
  check(
    "(2) malformed textRelays(Array.isArray 아님)를 null(=failure)로 분류",
    /Array\.isArray\(\s*(?:relays|firstRelaysRaw)\s*\)\s*\?\s*(?:relays|firstRelaysRaw)\s*:\s*null/.test(routeSrc0),
  );
  // 2026-08-11 relay 관측성 PR: 실패 경로가 직접 NextResponse 503 반환 대신
  // RelayUpstreamError(503, body) 를 throw 하고 GET 말미에서 그 status 로 응답한다.
  // 계약(실패 = non-2xx, empty 200 금지)은 동일 — 검사식만 새 구조를 따라간다.
  check(
    "(1) firstRes non-ok → non-2xx(503) (empty 200 아님)",
    /if\s*\(\s*!firstRes\.ok\s*\)\s*\{[\s\S]*?throw new RelayUpstreamError\(503,[\s\S]*?\}/.test(routeSrc0),
  );
  check(
    "(1) outer catch(timeout/network/JSON) → non-2xx(503) (empty 200 아님)",
    /throw new RelayUpstreamError\(503,\s*\{\s*error:\s*`relay_upstream_\$\{reason\}`\s*\}\)/.test(routeSrc0) &&
      // GET 말미가 typed error 를 그 status 그대로 응답으로 변환하는 배선 확인
      /e instanceof RelayUpstreamError[\s\S]*?status:\s*e\.status/.test(routeSrc0) &&
      !/catch\s*\(e\)[\s\S]*?innings:\s*\[\][\s\S]*?status:\s*200/.test(routeSrc0),
  );
  check(
    "(d) anyInningUnrecoverable → non-2xx(503) 단락 + publish/cache 안 함",
    /if\s*\(\s*anyInningUnrecoverable\s*\)\s*\{[\s\S]*?throw new RelayUpstreamError\(503,[\s\S]*?relay_upstream_unrecoverable[\s\S]*?\}/.test(routeSrc0),
  );
  // 클라(useGameRelay)가 non-2xx 를 기존 data 유지로 처리하는지 계약 고정
  const hookSrc = readFileSync(resolve(here0, "../../src/lib/hooks/useGameRelay.ts"), "utf8");
  check(
    "(d) 클라: direct/combined 모두 relay 2xx일 때만 apply → non-2xx는 기존 data 유지",
    /if\s*\(\s*res\.ok\s*\)\s*applyRelay\(/.test(hookSrc)
      && /if\s*\(\s*envelope\.ok\s*\)\s*applyRelay\(/.test(hookSrc),
  );

  // ---- (c) route 최대 wall-clock bound production wiring ----
  const routeSrc = routeSrc0;
  const timeoutCount = (routeSrc.match(/AbortSignal\.timeout\(/g) || []).length;
  check(
    "(c) 모든 upstream fetch 에 AbortSignal.timeout wiring (inning1 + inning2..N + record ≥3)",
    timeoutCount >= 3,
    `count=${timeoutCount}`,
  );
  const hasInningBound = /RELAY_INNING_TIMEOUT_MS\s*=\s*[\d_]+/.test(routeSrc);
  const boundVal = Number((routeSrc.match(/RELAY_INNING_TIMEOUT_MS\s*=\s*([\d_]+)/)?.[1] || "0").replace(/_/g, ""));
  check(
    "(c) RELAY_INNING_TIMEOUT_MS 유한·상한(≤10s) 고정",
    hasInningBound && boundVal > 0 && boundVal <= 10_000,
    `bound=${boundVal}`,
  );
  check(
    "(c) degraded 응답은 캐시하지 않음(!anyInningDegraded 가드)",
    /if\s*\(\s*!anyInningDegraded\s*\)\s*\{\s*[\r\n\s]*setCachedResponse/.test(routeSrc),
  );

  console.log(`\n relay-inning-snapshot: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
