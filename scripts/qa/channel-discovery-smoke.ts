/**
 * Smoke/regression — 자동 채널 발굴 순수 로직.
 *
 * 검증 대상(src/lib/video/channel-discovery.ts):
 *  · isKboRelevantTitle — Latin 약어 경계 매칭(concert→NC 오탐 차단), 마스코트/용어 positive,
 *    정치·종교 negative 차단
 *  · buildDiscoveryQueries — 팀·선수 빈도 상위 + generic, ≤8, dedupe, 데이터 없을 때 fallback
 *  · evaluateChannelCandidate — KBO 8+/숏츠 3+/30일 게이트, duration 미상=숏츠 아님(fail-closed)
 *  · decideMode — 첫 2회 shadow
 *  · pickActivations — pass만, 빈도 desc, 최대 5
 *
 * 실행: npx tsx scripts/qa/channel-discovery-smoke.ts  (npm run qa:channel-discovery)
 */
import "./_smoke-env";
import {
  isKboRelevantTitle,
  buildDiscoveryQueries,
  evaluateChannelCandidate,
  decideMode,
  pickActivations,
  isQuotaSignal,
  resolveMaxActivations,
  MAX_ACTIVATIONS_CAP,
  type RecentVideo,
  type ScoredCandidate,
} from "@/lib/video/channel-discovery";

let fail = 0;
function ok(name: string, cond: boolean) {
  console.log(`${cond ? "✅" : "❌"} ${name}`);
  if (!cond) fail++;
}

// ── isKboRelevantTitle ─────────────────────────────────────────────
ok("KBO 관련: 팀 마스코트", isKboRelevantTitle("두산 베어스 끝내기 홈런 모음"));
ok("KBO 관련: Latin 약어 경계(NC 다이노스)", isKboRelevantTitle("NC 다이노스 역전 3점포"));
ok("KBO 관련: 야구 용어만", isKboRelevantTitle("장외 만루홈런 실화냐"));
ok("KBO 관련: 야구 키워드", isKboRelevantTitle("프로야구 명장면 TOP10"));

ok("오탐 차단: 영단어 속 'nc'(concert)", !isKboRelevantTitle("BTS concert highlight dance"));
ok("오탐 차단: 영단어 속 'lg'(algorithm)", !isKboRelevantTitle("best sorting algorithm tutorial"));
ok("negative 차단: 종교(하나님)", !isKboRelevantTitle("하나님의 평가기준 투수편"));
ok("negative 차단: 정치(대통령)", !isKboRelevantTitle("대통령 시구 논란 총선"));
ok("비-야구 일반 제목", !isKboRelevantTitle("오늘의 요리 레시피 김치찌개"));
ok(
  "야구 시장 예외는 통과(FA시장)",
  isKboRelevantTitle("FA시장 최대어 김하성 이적 삼성 유력"),
);

// ── buildDiscoveryQueries ──────────────────────────────────────────
const fedTitles = [
  "LG 트윈스 오지환 결승 홈런",
  "LG 트윈스 문성주 3안타",
  "LG 김현수 시즌 20호",
  "두산 베어스 김재환 만루포",
  "삼성 라이온즈 구자욱 멀티히트",
  "박해민 호수비 모음",
  "박해민 도루 스틸",
];
const roster = ["오지환", "문성주", "김현수", "김재환", "구자욱", "박해민", "김"];
const q = buildDiscoveryQueries(fedTitles, roster, 8);
ok("queries ≤ 8", q.length <= 8 && q.length > 0);
ok("queries dedupe(중복 없음)", new Set(q).size === q.length);
ok("최다 팀 LG 우선 포함", q.some((s) => s.includes("LG 트윈스")));
ok("빈도 상위 선수(박해민 2회) 포함", q.some((s) => s.startsWith("박해민")));
ok("2자 이름(김) 제외", !q.some((s) => s.startsWith("김 ")));
ok("generic fallback 포함", q.some((s) => /KBO|프로야구|크보|짤/.test(s)));

const emptyQ = buildDiscoveryQueries([], [], 8);
ok("fed 없음 → generic fallback 채움", emptyQ.length > 0 && emptyQ.length <= 8);

ok("maxQueries 하드상한 8", buildDiscoveryQueries(fedTitles, roster, 50).length <= 8);

// ── evaluateChannelCandidate ───────────────────────────────────────
const NOW = new Date("2026-07-19T00:00:00Z");
function vid(title: string, daysAgo: number, dur: number | null): RecentVideo {
  return {
    title,
    publishedAt: new Date(NOW.getTime() - daysAgo * 86400000).toISOString(),
    durationSeconds: dur,
  };
}
// 통과: KBO 10/10, 숏츠(≤70초) 4개, 최근 2일
const passVids: RecentVideo[] = [
  vid("LG 트윈스 홈런", 1, 45),
  vid("두산 베어스 삼진쇼", 2, 30),
  vid("KIA 타이거즈 역전", 3, 60),
  vid("삼성 라이온즈 도루", 4, 68),
  vid("롯데 자이언츠 만루", 5, 200),
  vid("한화 이글스 완봉", 6, 300),
  vid("NC 다이노스 끝내기", 7, 400),
  vid("키움 히어로즈 타점", 8, 250),
  vid("SSG 랜더스 병살", 9, 260),
  vid("KT 위즈 선발 호투", 10, 280),
];
const passEval = evaluateChannelCandidate(passVids, { now: NOW });
ok("게이트 통과(KBO 10, 숏츠 4)", passEval.pass);
ok("통과 kboCount=10", passEval.kboCount === 10);
ok("통과 shortCount=4", passEval.shortCount === 4);

// 탈락: 숏츠 부족(2개)
const fewShorts = passVids.map((v, i) => ({ ...v, durationSeconds: i < 2 ? 40 : 500 }));
ok("탈락: 숏츠 2개<3", !evaluateChannelCandidate(fewShorts, { now: NOW }).pass);

// 탈락: KBO 관련 부족
const lowKbo: RecentVideo[] = [
  ...passVids.slice(0, 5),
  vid("여행 브이로그 제주도", 1, 40),
  vid("게임 실황 롤", 2, 45),
  vid("먹방 챌린지", 3, 50),
  vid("메이크업 튜토리얼", 4, 55),
  vid("댄스 커버 kpop", 5, 60),
];
ok("탈락: KBO 5/10<8", !evaluateChannelCandidate(lowKbo, { now: NOW }).pass);

// 탈락: 최근 업로드 30일 초과
const stale = passVids.map((v) => ({
  ...v,
  publishedAt: new Date(NOW.getTime() - 40 * 86400000).toISOString(),
}));
ok("탈락: 마지막 업로드 40일 전", !evaluateChannelCandidate(stale, { now: NOW }).pass);

// 탈락: 표본 부족(5개)
ok("탈락: 표본 5개<8", !evaluateChannelCandidate(passVids.slice(0, 5), { now: NOW }).pass);

// fail-closed: duration 전부 미상 → 숏츠 0
const noDur = passVids.map((v) => ({ ...v, durationSeconds: null }));
ok("fail-closed: duration 미상=숏츠 0", evaluateChannelCandidate(noDur, { now: NOW }).shortCount === 0);
ok("fail-closed: duration 미상 → 탈락", !evaluateChannelCandidate(noDur, { now: NOW }).pass);

// ── decideMode ─────────────────────────────────────────────────────
ok("run 0회 → shadow", decideMode(0) === "shadow");
ok("run 1회 → shadow", decideMode(1) === "shadow");
ok("run 2회 → active", decideMode(2) === "active");
ok("run 5회 → active", decideMode(5) === "active");

// ── pickActivations ────────────────────────────────────────────────
function sc(id: string, seen: number, pass: boolean): ScoredCandidate {
  return {
    channelId: id,
    channelName: id,
    seenCount: seen,
    evaluation: {
      pass,
      considered: 10,
      kboCount: pass ? 9 : 5,
      shortCount: pass ? 4 : 1,
      recentUploadAt: NOW.toISOString(),
      withinRecent: true,
      reason: "",
    },
  };
}
const pool = [
  sc("a", 3, true),
  sc("b", 5, true),
  sc("c", 1, false),
  sc("d", 2, true),
  sc("e", 4, true),
  sc("f", 6, true),
  sc("g", 1, true),
];
const picked = pickActivations(pool, 5);
ok("활성 최대 5개", picked.length === 5);
ok("pass만 선정", picked.every((p) => p.evaluation.pass));
ok("빈도 desc 정렬(f 최상위)", picked[0].channelId === "f");
ok("탈락 후보(c) 제외", !picked.some((p) => p.channelId === "c"));
ok("한도 밖(가장 낮은 g) 제외", !picked.some((p) => p.channelId === "g"));

// ── isQuotaSignal (삼순 4번: HTTP status + reason + message 변형) ─────────────
ok("quota: HTTP 403", isQuotaSignal({ status: 403 }));
ok("quota: HTTP 429", isQuotaSignal({ status: 429 }));
ok("quota: reason quotaExceeded", isQuotaSignal({ status: 200, reasons: ["quotaExceeded"] }));
ok("quota: reason dailyLimitExceeded", isQuotaSignal({ reasons: ["dailyLimitExceeded"] }));
ok("quota: reason userRateLimitExceeded", isQuotaSignal({ reasons: ["userRateLimitExceeded"] }));
ok(
  "quota: message 변형 'exceeded your quota'",
  isQuotaSignal({ status: 200, message: "The request cannot be completed because you have exceeded your quota." }),
);
ok("quota: message 'rate limit'", isQuotaSignal({ message: "User rate limit exceeded" }));
ok("non-quota: 400 badRequest", !isQuotaSignal({ status: 400, reasons: ["badRequest"], message: "invalid parameter" }));
ok("non-quota: 200 정상", !isQuotaSignal({ status: 200, reasons: [], message: undefined }));
ok("non-quota: 404", !isQuotaSignal({ status: 404, message: "not found" }));
ok("quota: reasons에 null 섞여도 안전", isQuotaSignal({ reasons: [null, undefined, "quotaExceeded"] }));

// ── resolveMaxActivations (삼순 4번: 최대 5 하드 clamp) ─────────────────
ok("clamp: 미설정 → 5", resolveMaxActivations(undefined) === 5);
ok("clamp: '3' → 3", resolveMaxActivations("3") === 3);
ok("clamp: '100' → 5(하드 상한)", resolveMaxActivations("100") === MAX_ACTIVATIONS_CAP);
ok("clamp: '0' → 5", resolveMaxActivations("0") === 5);
ok("clamp: '-2' → 5", resolveMaxActivations("-2") === 5);
ok("clamp: 'abc' → 5", resolveMaxActivations("abc") === 5);
ok("clamp: '5' → 5", resolveMaxActivations("5") === 5);
// pickActivations는 넘겨받은 max를 넘지 않음(하드 clamp된 값으로 호출됨)
ok(
  "pickActivations: max=5 clamp된 값으로 5개 제한",
  pickActivations(
    Array.from({ length: 9 }, (_, i) => sc(`z${i}`, 10 - i, true)),
    resolveMaxActivations("999"),
  ).length === 5,
);

console.log(`\n${fail === 0 ? "🟢 ALL PASS" : `🔴 ${fail} FAILED`}`);
process.exit(fail === 0 ? 0 : 1);
