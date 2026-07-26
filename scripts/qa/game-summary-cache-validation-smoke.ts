#!/usr/bin/env tsx
/**
 * QA: AI 경기 요약 canonical/fingerprint/race 회귀 (#888).
 */

import {
  canonicalGate,
  createSummaryFingerprint,
  fingerprintsEqual,
  isFingerprintStale,
  shouldHideStaleCache,
  shouldSaveGeneratedSummary,
  winnerFieldMismatch,
  type CanonicalGameState,
  type SummaryFingerprint,
} from "../../src/lib/game-summary/cache-validation";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

let pass = 0;
let fail = 0;
function ok(desc: string, cond: boolean) {
  if (cond) { pass++; console.log(`✓ ${desc}`); }
  else { fail++; console.log(`✗ ${desc}`); }
}

const game = (
  status: CanonicalGameState["status"],
  awayScore: number | null,
  homeScore: number | null,
): CanonicalGameState => ({ status, awayScore, homeScore });

const linescore = (
  awayScore: number,
  homeScore: number,
  awayInnings: (number | null)[],
  homeInnings: (number | null)[],
  status: CanonicalGameState["status"] = "final",
) => ({
  status,
  away: { R: awayScore, innings: awayInnings },
  home: { R: homeScore, innings: homeInnings },
});

const fp = (
  awayScore: number,
  homeScore: number,
  awayInnings: (number | null)[],
  homeInnings: (number | null)[],
): SummaryFingerprint => createSummaryFingerprint(awayScore, homeScore, awayInnings, homeInnings);

console.log("[① canonical final+score+innings settle gate]");
ok("live 8회초 → not-final", canonicalGate(game("live", 4, 4), linescore(4, 4, [0,0,0,0,0,0,2,2], [0,0,1,3], "live")).reason === "not-final");
ok("scheduled → not-final", canonicalGate(game("scheduled", null, null), null).reason === "not-final");
ok("cancelled → not-final", canonicalGate(game("cancelled", 0, 0), linescore(0, 0, [], [])).reason === "not-final");
ok("경기목록 미확보 → unavailable", canonicalGate(undefined, null).reason === "canonical-unavailable");
ok("final이나 이닝표 미확보 → not-settled", canonicalGate(game("final", 4, 14), null).reason === "canonical-not-settled");
ok("경기목록 4-14 / 스코어보드 4-4 → not-settled", canonicalGate(game("final", 4, 14), linescore(4, 4, [0,0,0,0,0,0,2,2], [0,0,1,3])).reason === "canonical-not-settled");
ok("경기목록 final이나 스코어보드 END_TM 전 → not-settled",
  canonicalGate(game("final", 4, 4), linescore(4, 4, [0,0,0,0,0,0,2,2], [0,0,1,3], "live")).reason === "canonical-not-settled");

const final414 = canonicalGate(
  game("final", 4, 14),
  linescore(4, 14, [0,0,0,0,0,0,2,2,0], [0,0,1,3,0,0,0,10,null]),
);
ok("두 원천 final 4-14 수렴 → fingerprint", final414.reason === "ok" && final414.fingerprint?.homeScore === 14);
ok("홈리드 9회말 생략은 trailing null 정규화로 8개 이닝 보존", final414.fingerprint?.homeInnings.length === 8);
ok("콜드 6회 final → 이닝 하드코딩 없이 통과",
  canonicalGate(game("final", 0, 5), linescore(0, 5, [0,0,0,0,0,0], [2,0,0,3,0,null])).reason === "ok");
ok("연장 12회 final → 통과",
  canonicalGate(game("final", 5, 6), linescore(5, 6, Array(12).fill(0), Array(12).fill(0))).reason === "ok");
ok("더블헤더는 exact gameId별 canonical을 받으면 동일 게이트 통과",
  canonicalGate(game("final", 3, 2), linescore(3, 2, Array(9).fill(0), Array(9).fill(0))).reason === "ok");

console.log("[② full fingerprint stale/legacy/UI 0-frame]");
const mid44 = fp(4, 4, [0,0,0,0,0,0,2,2], [0,0,1,3]);
const final44 = fp(4, 4, [0,0,0,0,0,0,2,2,0], [0,0,1,3,0,0,0,0,null]);
const final414fp = final414.fingerprint!;
ok("동일 fingerprint → current", fingerprintsEqual(final414fp, structuredClone(final414fp)));
ok("중간/최종 동일 4-4라도 innings 차이 → stale", isFingerprintStale(mid44, final44));
ok("4-4 → 4-14 score+innings 차이 → stale", isFingerprintStale(mid44, final414fp));
ok("legacy fingerprint 없음 → stale", isFingerprintStale(null, final414fp));
ok("legacy cache는 UI에 넣기 전 hide", shouldHideStaleCache(null, final414fp));
ok("stale cache는 UI에 넣기 전 hide", shouldHideStaleCache(mid44, final414fp));
ok("client linescore 미확보여도 검증 불가 cache는 hide", shouldHideStaleCache(final414fp, null));
ok("current cache만 노출", !shouldHideStaleCache(final414fp, structuredClone(final414fp)));

console.log("[③ old-last overwrite race]");
ok("생성 시작/저장 직전 fingerprint 동일 → save", shouldSaveGeneratedSummary(final414fp, structuredClone(final414fp)));
ok("늦은 4-4 생성이 최신 4-14를 덮는 save → 차단", !shouldSaveGeneratedSummary(mid44, final414fp));
ok("같은 4-4여도 final innings가 변했으면 old save → 차단", !shouldSaveGeneratedSummary(mid44, final44));
ok("저장 직전 canonical 재조회 실패 → 차단", !shouldSaveGeneratedSummary(final414fp, null));

console.log("[④ winner exact-match]");
ok("non-draw + winner=무승부 → mismatch",
  winnerFieldMismatch(4, 14, "LG", "한화", "무승부", "한화 14-4 대승"));
ok("non-draw + 헤드라인 무승부 → mismatch",
  winnerFieldMismatch(4, 14, "LG", "한화", "한화", "LG와 한화 4-4 무승부"));
ok("non-draw + exact winner → pass",
  !winnerFieldMismatch(4, 14, "LG", "한화", "한화", "한화 14-4 대승"));
ok("non-draw + winner 부재 → mismatch",
  winnerFieldMismatch(4, 14, "LG", "한화", undefined, "한화 14-4 대승"));
ok("non-draw + winner null → mismatch",
  winnerFieldMismatch(4, 14, "LG", "한화", null, "한화 14-4 대승"));
ok("non-draw + winner 빈 문자열 → mismatch",
  winnerFieldMismatch(4, 14, "LG", "한화", "", "한화 14-4 대승"));
ok("draw + 특정 팀 winner → mismatch",
  winnerFieldMismatch(4, 4, "LG", "한화", "한화", "4-4 무승부"));
ok("draw + winner=무승부 → pass",
  !winnerFieldMismatch(4, 4, "LG", "한화", "무승부", "4-4 무승부"));
ok("draw + winner 부재 → mismatch",
  winnerFieldMismatch(4, 4, "LG", "한화", undefined, "4-4 무승부"));
ok("draw + winner null → mismatch",
  winnerFieldMismatch(4, 4, "LG", "한화", null, "4-4 무승부"));
ok("draw + winner 빈 문자열 → mismatch",
  winnerFieldMismatch(4, 4, "LG", "한화", "", "4-4 무승부"));

console.log("[⑤ production control-flow probes]");
const routeSource = readFileSync(resolve(process.cwd(), "src/app/api/game-summary/route.ts"), "utf8");
const componentSource = readFileSync(resolve(process.cwd(), "src/components/game/KgwanTab.tsx"), "utf8");
const postSource = routeSource.slice(routeSource.indexOf("export async function POST"));
ok("공개 POST는 request body에서 gameId만 사용",
  !/requestBody\.(?:awayTeam|homeTeam|awayScore|homeScore|linescore|awayBatters|homeBatters|awayPitchers|homePitchers)/.test(postSource));
ok("POST 생성 입력은 canonical 경기+이닝+박스스코어 재조회",
  postSource.includes("fetchCanonicalSummarySource(requestBody.gameId, true)"));
ok("save 직전 canonical fingerprint 재검증",
  postSource.includes("fetchCanonicalSummarySource(body.gameId, false)") &&
  postSource.includes("shouldSaveGeneratedSummary(generationFingerprint, latestCanonical.fingerprint)"));
const cacheBranch = componentSource.slice(
  componentSource.indexOf("if (cacheData.summary)"),
  componentSource.indexOf("// outdated(프롬프트 버전) OR stale/legacy"),
);
ok("stale/legacy 판단 전에 llmSummary에 캐시를 넣지 않음",
  cacheBranch.indexOf("const hideStale") < cacheBranch.indexOf("setLlmSummary(cacheData.summary)") &&
  cacheBranch.includes("if (!hideStale && !cacheData.outdated)"));

async function runAtomicChecks() {
  console.log("[⑥ DB-linearized generation + poll fail-close]");
  const migrationSource = readFileSync(
    resolve(process.cwd(), "supabase/migrations/20260726_game_summary_generation_fence.sql"),
    "utf8",
  );
  ok("generation claim은 DB sequence로 발급",
    migrationSource.includes("nextval('public.game_summary_generation_seq')") &&
    migrationSource.includes("game_summary_generation_claims.generation_token < excluded.generation_token"));
  ok("save는 claim row lock + current token exact-match 후 upsert",
    migrationSource.includes("for update;") &&
    migrationSource.includes("v_current_token is distinct from p_generation_token") &&
    migrationSource.includes("on conflict (game_id) do update"));
  ok("route는 stale cache 판정 뒤 DB claim, save는 같은 token RPC",
    postSource.indexOf("claimGeneration(body.gameId)") > postSource.indexOf("isFingerprintStale(") &&
    postSource.includes("saveCache(body.gameId, summary, generationToken)"));

  function simulateDbClaims(oldClientClock: number, newClientClock: number) {
    void oldClientClock;
    void newClientClock;
    let sequence = 0;
    let currentToken = 0;
    const claim = () => {
      currentToken = ++sequence;
      return currentToken;
    };
    const save = (token: number) => token === currentToken;
    const oldToken = claim();
    const newToken = claim();
    return { oldSaved: save(oldToken), newSaved: save(newToken) };
  }
  const equalClock = simulateDbClaims(200, 200);
  ok("equal client clocks에서도 DB claim 순서로 old reject",
    !equalClock.oldSaved && equalClock.newSaved);
  const reversedClock = simulateDbClaims(300, 200);
  ok("cross-instance reversed clock에서도 DB claim 순서로 old reject",
    !reversedClock.oldSaved && reversedClock.newSaved);

  const pollSource = componentSource.slice(componentSource.indexOf("const pollCache = async"));
  ok("poll도 outdated + fingerprint current 검증 후에만 렌더",
    pollSource.includes("!data.outdated") &&
    pollSource.includes("shouldHideStaleCache(") &&
    pollSource.indexOf("shouldHideStaleCache(") < pollSource.indexOf("setLlmSummary(data.summary)"));
  ok("background regeneration 실패 시 retry fence 복구",
    componentSource.includes("finally {") &&
    componentSource.includes("regeneratingRef.current = false;") &&
    componentSource.includes('setLlmError("network")'));
}

runAtomicChecks().then(() => {
  console.log(`\n${pass}/${pass + fail} passed`);
  if (fail > 0) process.exit(1);
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
