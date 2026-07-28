/**
 * game-relay delta(증분) 폴링 헬퍼 스모크.
 * 실시간 손실 0 + 기능(지난 이닝 pitch-by-pitch 보관) 손실 0 을 회귀로 고정한다.
 *
 * 실행: npx tsx scripts/qa/relay-delta-smoke.ts
 */
import {
  filterDeltaInnings,
  mergeDeltaInnings,
  inningKey,
  toDeltaResponse,
  shouldApplyRelayResponse,
  shouldReleaseInFlight,
} from "../../src/lib/game/relay-delta";
import type { InningRelay } from "../../src/app/api/game-relay/route";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) { pass++; }
  else { fail++; console.error(`  ✗ ${name}`); }
}

function inn(inning: number, half: "top" | "bottom", plays: number): InningRelay {
  return {
    inning,
    half,
    teamName: `T${inning}${half}`,
    plays: Array.from({ length: plays }, (_, i) => ({
      batterName: `b${i}`,
      result: "안타",
      type: 1 as InningRelay["plays"][number]["type"],
      pitches: [{ count: "S", type: "직구", speed: 150 } as unknown as NonNullable<InningRelay["plays"][number]["pitches"]>[number]],
    })),
  };
}

// 9회까지 진행된 경기: 초/말 각각.
function fullGame(maxInning: number): InningRelay[] {
  const out: InningRelay[] = [];
  for (let i = 1; i <= maxInning; i++) {
    out.push(inn(i, "top", 3));
    out.push(inn(i, "bottom", 3));
  }
  return out;
}

// ---- filterDeltaInnings (server) ----
{
  const innings = fullGame(9); // 1~9회 초/말 = 18개
  // since<=0 → 전체(full)
  check("since=0 returns full", filterDeltaInnings(innings, 0).length === 18);
  check("since<0 returns full", filterDeltaInnings(innings, -1).length === 18);
  // since=8 → 직전(7)부터: 7,8,9회 = 6개
  const d8 = filterDeltaInnings(innings, 8);
  check("since=8 keeps inning>=7", d8.every((x) => x.inning >= 7));
  check("since=8 count 6", d8.length === 6);
  // since=9 → 8,9회 = 4개 (현재 이닝은 항상 완전 포함)
  const d9 = filterDeltaInnings(innings, 9);
  check("since=9 keeps inning>=8", d9.every((x) => x.inning >= 8));
  check("since=9 includes current inning fully", d9.some((x) => x.inning === 9 && x.half === "bottom"));
  // since=1 → min은 1로 clamp, 전체 유지(과소 방지)
  check("since=1 clamps to 1", filterDeltaInnings(innings, 1).length === 18);
}

// ---- mergeDeltaInnings (client) ----
{
  const cache = new Map<string, InningRelay>();
  // 1) 첫 full 로드
  const merged1 = mergeDeltaInnings(cache, fullGame(7), false);
  check("full load size 14", merged1.length === 14);
  check("cache holds 14", cache.size === 14);

  // 2) delta: 8회 진행 → 서버가 since=7 로 7,8회만 내려줌
  const delta = [inn(7, "top", 3), inn(7, "bottom", 3), inn(8, "top", 2)];
  const merged2 = mergeDeltaInnings(cache, delta, true);
  // 지난 이닝(1~6회)은 유지 + 8회 추가 = 15개
  check("delta merge keeps past innings", merged2.length === 15);
  check("delta merge added inning 8", merged2.some((x) => inningKey(x) === "8-top"));
  check("past inning 1 still present (pitches retained)", merged2.some((x) => x.inning === 1 && x.plays[0].pitches?.length === 1));

  // 3) delta 로 현재 이닝 play 추가(2→3구): 같은 키 교체
  const delta2 = [inn(8, "top", 3)];
  const merged3 = mergeDeltaInnings(cache, delta2, true);
  const eighthTop = merged3.find((x) => inningKey(x) === "8-top");
  check("delta replaces current inning by key", eighthTop?.plays.length === 3);
  check("no duplicate inning key", merged3.filter((x) => inningKey(x) === "8-top").length === 1);

  // 4) full self-heal: 과거 이닝 정정 반영(1회 plays 3→5로 수정된 full)
  const corrected = fullGame(8);
  const fixed = corrected.find((x) => inningKey(x) === "1-top")!;
  fixed.plays = inn(1, "top", 5).plays;
  const merged4 = mergeDeltaInnings(cache, corrected, false);
  const firstTop = merged4.find((x) => inningKey(x) === "1-top");
  check("full self-heal rebuilds cache", cache.size === 16);
  check("full self-heal applies past correction", firstTop?.plays.length === 5);
}

// ---- toDeltaResponse (fresh ↔ cache-hit 패리티, 삼순 blocker ①) ----
{
  const full = { gameId: "g1", innings: fullGame(9), currentInning: 9, updatedAt: "t0" };

  // since<=0 → full 그대로(partial 미설정)
  const asFull = toDeltaResponse(full, 0);
  check("toDeltaResponse since=0 keeps full innings", asFull.innings.length === 18);
  check("toDeltaResponse since=0 no partial flag", asFull.partial !== true);

  // since>0 → filter + partial:true
  const asDelta = toDeltaResponse(full, 8);
  check("toDeltaResponse since=8 filters innings", asDelta.innings.length === 6);
  check("toDeltaResponse since=8 sets partial", asDelta.partial === true);
  check("toDeltaResponse keeps live fields", asDelta.currentInning === 9 && asDelta.updatedAt === "t0");

  // 입력 객체 불변(캐시 오염 방지) — responseCache 에 저장된 full 을 손대면 안 된다.
  check("toDeltaResponse does not mutate input innings", full.innings.length === 18);
  check("toDeltaResponse does not mutate input partial", (full as { partial?: boolean }).partial === undefined);

  // fresh 경로와 cache-hit 경로는 동일 full+since 에 대해 동일 delta 를 내야 한다.
  // (두 경로 모두 route 에서 같은 toDeltaResponse 를 호출하므로 계약 동등성을 고정)
  const freshLike = toDeltaResponse(full, 7);
  const cacheHitLike = toDeltaResponse({ ...full }, 7);
  check("fresh vs cache-hit innings parity", freshLike.innings.length === cacheHitLike.innings.length);
  check("fresh vs cache-hit partial parity", freshLike.partial === cacheHitLike.partial);
  check(
    "fresh vs cache-hit key set parity",
    freshLike.innings.map(inningKey).join(",") === cacheHitLike.innings.map(inningKey).join(","),
  );
}

// ---- 요청 fencing (삼순 blocker ②: gameId 전환 교차 오염 / late-body) ----
// 실행형 회귀. 훅의 seq 토큰 fencing 만을 결정론적으로 재현(dev-server 불필요).
// 시나리오: `A pending → B full 먼저 → A release → B 유지`.
{
  // 훅 ref 상태를 그대로 모사. gameId A 요청이 발급되어 in-flight.
  let currentSeq = 0;
  let activeGameId = "A";
  let mounted = true;

  // A 요청 발급 (inFlight 가드 통과 후 mySeq 증가)
  const aSeq = ++currentSeq; // 1
  check("A request seq = 1", aSeq === 1);

  // gameId A→B 전환: reset effect 가 seq 를 올려 A 무효화 + activeGameId=B
  currentSeq++; // reset bump → 2
  activeGameId = "B";
  // B full 이 막힘없이 즉시 시작: 새 요청 발급
  const bSeq = ++currentSeq; // 3
  check("B request starts immediately with fresh seq", bSeq === 3 && bSeq !== aSeq);

  // (b) 늦게 끝난 A 의 late-body 는 setData 하면 안 된다(seq 불일치 + gameId 불일치)
  check(
    "late A body is NOT applied (stale seq + gameId)",
    shouldApplyRelayResponse({
      mounted,
      requestSeq: aSeq,
      currentSeq,
      requestGameId: "A",
      activeGameId,
    }) === false,
  );
  // (a) 늦게 끝난 A 의 finally 는 B 의 공용 in-flight 을 clear 하면 안 된다
  check("late A finally does NOT release B in-flight", shouldReleaseInFlight(aSeq, currentSeq) === false);

  // B 본문은 정상 적용되고(B 유지) B 가 자신의 in-flight 을 clear 한다
  check(
    "B body IS applied (current seq + active gameId)",
    shouldApplyRelayResponse({
      mounted,
      requestSeq: bSeq,
      currentSeq,
      requestGameId: "B",
      activeGameId,
    }) === true,
  );
  check("B finally releases its own in-flight", shouldReleaseInFlight(bSeq, currentSeq) === true);

  // 마운트 해제 후 도착한 응답은 seq·gameId 가 맞아도 적용 안 함
  mounted = false;
  check(
    "unmounted response is NOT applied even when seq/gameId match",
    shouldApplyRelayResponse({
      mounted,
      requestSeq: bSeq,
      currentSeq,
      requestGameId: "B",
      activeGameId,
    }) === false,
  );
}

console.log(`relay-delta-smoke: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
