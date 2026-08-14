/**
 * 최애선수 수훈 인터뷰 알림 smoke — 감지 + 실제 발송 오케스트레이션.
 * DB/네트워크 없음(deps 주입). 실패 시 exit 1.
 *
 * 검증 축:
 *  1. 감지 양성: 공식 채널 + "수훈"+"인터뷰" 제목 + 선수 태깅 + fresh
 *  2. 감지 음성: 커뮤니티 / 제목 부분일치 / 태깅 없음 / stale / 미래 / team_id 없음 / 중복
 *  3. 선수 cap: 태깅 3명 → 2명까지만
 *  4. kstDateStr UTC→KST 날짜 경계
 *  5. pickGameIdForTeam: away/home/무경기/더블헤더
 *  6. 종단 발송 경로: claim→audience→sendPush(url·prefKey·title)→요약
 *  7. 실패 처리: claim 중복 skip / 스코어보드 실패 시 claim 안 함 / 전일 폴백 /
 *     alias 불일치 skip / 발송 실패 unclaim / 대상 0
 */
import {
  detectInterviewCandidates,
  notifyFavPlayerInterviews,
  kstDateStr,
  pickGameIdForTeam,
  INTERVIEW_FRESH_MS,
  INTERVIEW_PREF_KEY,
  type InterviewDeps,
} from "../../src/lib/notifications/fav-player-interview";
import type { VideoUpsertRow } from "../../src/lib/video/videos-repo";
import type { PlayerAlias } from "../../src/lib/video/player-tagger";
import type { KboRawGame } from "../../src/types/api";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS ${name}`);
  else { failures++; console.error(`  FAIL ${name}`); }
}

const NOW = Date.parse("2026-08-14T13:30:00Z"); // KST 22:30 — 경기 종료 후
const fresh = new Date(NOW - 30 * 60 * 1000).toISOString();

function row(over: Partial<VideoUpsertRow> = {}): VideoUpsertRow {
  return {
    video_id: "vid-base",
    team_id: "LG",
    player_ids: ["55555"],
    title: "오늘의 수훈선수 인터뷰",
    published_at: fresh,
    source_type: "official_long",
    is_short_candidate: false,
    noise_flags: [],
    ...over,
  };
}
const ALIASES: PlayerAlias[] = [
  { kbo_id: "55555", name: "문보경", team: "LG", aliases: [] },
  { kbo_id: "77777", name: "박동원", team: "LG", aliases: [] },
  { kbo_id: "99999", name: "양의지", team: "두산", aliases: [] },
];
const g = (id: string, away: string, home: string) =>
  ({ G_ID: id, AWAY_NM: away, HOME_NM: home }) as KboRawGame;

interface Calls {
  claims: string[]; unclaims: string[]; dates: string[];
  sends: { userIds: string[]; title: string; body: string; url: string; prefKey: string }[];
}
/**
 * deps 팔은 항상 호출을 기록한다. 오버라이드는 *반환값*만 바꾸고 추적은 유지 —
 * 오버라이드가 추적까지 덮어쓰면 게이트가 항상 빈 배열을 보고 false-green이 된다.
 */
interface DepsOverrides {
  claim?: (eventId: string) => boolean;
  games?: (date: string) => KboRawGame[] | null;
  audience?: (kboId: string) => string[];
  sendOk?: boolean;
}
function makeDeps(over: DepsOverrides = {}): { deps: InterviewDeps; calls: Calls } {
  const calls: Calls = { claims: [], unclaims: [], dates: [], sends: [] };
  const deps: InterviewDeps = {
    claimEvent: async (id) => { calls.claims.push(id); return over.claim ? over.claim(id) : true; },
    unclaimEvent: async (id) => { calls.unclaims.push(id); },
    fetchGamesByDate: async (date) => {
      calls.dates.push(date);
      return over.games ? over.games(date) : [g("20260814LGOB0", "LG", "두산")];
    },
    fetchFavoritePlayerFanIds: async (kboId) => (over.audience ? over.audience(kboId) : ["user-1", "user-2"]),
    sendPush: async (userIds, payload, prefKey) => {
      calls.sends.push({ userIds, ...payload, prefKey });
      return { ok: over.sendOk ?? true };
    },
  };
  return { deps, calls };
}

console.log("[1] 감지 양성");
{
  const out = detectInterviewCandidates([row()], NOW);
  check("공식+수훈+인터뷰+fresh → 후보 1", out.length === 1);
  check("teamShortName 전달", out[0]?.teamShortName === "LG");
  check("playerIds 전달", out[0]?.playerIds[0] === "55555");
  check("official_short도 허용",
    detectInterviewCandidates([row({ source_type: "official_short" })], NOW).length === 1);
}

console.log("[2] 감지 음성");
{
  check("커뮤니티 채널 제외",
    detectInterviewCandidates([row({ source_type: "community_long" })], NOW).length === 0);
  check("'수훈'만 있는 제목 제외",
    detectInterviewCandidates([row({ title: "수훈선수 하이라이트 모음" })], NOW).length === 0);
  check("'인터뷰'만 있는 제목 제외",
    detectInterviewCandidates([row({ title: "시즌 결산 인터뷰" })], NOW).length === 0);
  check("선수 태깅 없음 제외",
    detectInterviewCandidates([row({ player_ids: [] })], NOW).length === 0);
  check("freshness 창 밖 제외",
    detectInterviewCandidates([row({
      published_at: new Date(NOW - INTERVIEW_FRESH_MS - 60_000).toISOString(),
    })], NOW).length === 0);
  check("미래 timestamp 제외",
    detectInterviewCandidates([row({
      published_at: new Date(NOW + 10 * 60 * 1000).toISOString(),
    })], NOW).length === 0);
  check("team_id 없음 제외",
    detectInterviewCandidates([row({ team_id: "" })], NOW).length === 0);
  check("깨진 published_at 제외",
    detectInterviewCandidates([row({ published_at: "not-a-date" })], NOW).length === 0);
  check("중복 video_id는 1건만",
    detectInterviewCandidates([row(), row()], NOW).length === 1);
}

console.log("[3] 선수 cap");
{
  const out = detectInterviewCandidates([row({ player_ids: ["1", "2", "3"] })], NOW);
  check("3명 태깅 → 2명 cap", out[0]?.playerIds.length === 2);
}

console.log("[4] kstDateStr 날짜 경계");
{
  check("UTC 13:30 → KST 같은 날", kstDateStr(Date.parse("2026-08-14T13:30:00Z")) === "20260814");
  check("UTC 15:30(KST 00:30) → 익일", kstDateStr(Date.parse("2026-08-14T15:30:00Z")) === "20260815");
  check("UTC 14:59(KST 23:59) → 같은 날", kstDateStr(Date.parse("2026-08-14T14:59:00Z")) === "20260814");
}

console.log("[5] pickGameIdForTeam");
{
  const games = [g("A1", "LG", "두산"), g("B1", "KT", "SSG")];
  check("away 매칭", pickGameIdForTeam(games, "LG") === "A1");
  check("home 매칭", pickGameIdForTeam(games, "두산") === "A1");
  check("무경기 → null", pickGameIdForTeam(games, "한화") === null);
  check("더블헤더 → 후행 경기",
    pickGameIdForTeam([g("DH1", "LG", "두산"), g("DH2", "LG", "두산")], "LG") === "DH2");
}

async function main() {
console.log("[6] 종단 발송 경로");
{
  const { deps, calls } = makeDeps();
  const s = await notifyFavPlayerInterviews([row()], ALIASES, deps, NOW);
  check("sent=1", s.sent === 1 && s.candidates === 1);
  check("claim event_id 형식", calls.claims[0] === "interview#vid-base#55555");
  check("발송 1회", calls.sends.length === 1);
  check("딥링크 = 경기페이지", calls.sends[0]?.url === "/games/20260814LGOB0");
  check("prefKey 전달(토글 필터)", calls.sends[0]?.prefKey === INTERVIEW_PREF_KEY);
  check("제목에 선수명", calls.sends[0]?.title.includes("문보경"));
  check("본문 = 영상 제목", calls.sends[0]?.body === "오늘의 수훈선수 인터뷰");
  check("대상 유저 전달", calls.sends[0]?.userIds.length === 2);
  check("unclaim 없음", calls.unclaims.length === 0);
}

console.log("[7] 실패/경계 처리");
{
  const dup = makeDeps({ claim: () => false });
  const s1 = await notifyFavPlayerInterviews([row()], ALIASES, dup.deps, NOW);
  check("중복 claim → 미발송", s1.sent === 0 && s1.skippedClaimed === 1 && dup.calls.sends.length === 0);

  const noGame = makeDeps({ games: () => [] });
  const s2 = await notifyFavPlayerInterviews([row()], ALIASES, noGame.deps, NOW);
  check("경기 없음 → 미발송·claim 안 함",
    s2.skippedNoGame === 1 && noGame.calls.claims.length === 0);

  const fetchFail = makeDeps({ games: () => null });
  const s3 = await notifyFavPlayerInterviews([row()], ALIASES, fetchFail.deps, NOW);
  check("스코어보드 실패 → claim 안 함(다음 cron 재시도)",
    s3.skippedNoGame === 1 && fetchFail.calls.claims.length === 0);

  // 자정 넘겨 업로드: KST 00:20 발행 → 당일엔 경기 없고 전일에 있음
  const lateMs = Date.parse("2026-08-14T15:20:00Z"); // KST 8/15 00:20
  const prevDay = makeDeps({
    games: (date) => (date === "20260814" ? [g("20260814LGOB0", "LG", "두산")] : []),
  });
  const s4 = await notifyFavPlayerInterviews(
    [row({ published_at: new Date(lateMs).toISOString() })], ALIASES, prevDay.deps, lateMs + 60_000,
  );
  check("자정 넘긴 업로드 → 전일 경기로 폴백",
    s4.sent === 1 && prevDay.calls.dates.includes("20260815") && prevDay.calls.dates.includes("20260814"));

  const mismatch = makeDeps();
  const s5 = await notifyFavPlayerInterviews(
    [row({ player_ids: ["99999"] })], ALIASES, mismatch.deps, NOW, // 양의지=두산인데 LG 영상
  );
  check("alias 소속 불일치 → 미발송",
    s5.skippedAliasMismatch === 1 && mismatch.calls.sends.length === 0 && mismatch.calls.claims.length === 0);

  const unknown = makeDeps();
  const s6 = await notifyFavPlayerInterviews([row({ player_ids: ["00000"] })], ALIASES, unknown.deps, NOW);
  check("alias 미상 → 미발송", s6.skippedAliasMismatch === 1 && unknown.calls.sends.length === 0);

  const sendFail = makeDeps({ sendOk: false });
  const s7 = await notifyFavPlayerInterviews([row()], ALIASES, sendFail.deps, NOW);
  check("발송 실패 → unclaim(재시도 가능)",
    s7.failed === 1 && s7.sent === 0 && sendFail.calls.unclaims[0] === "interview#vid-base#55555");

  const noAudience = makeDeps({ audience: () => [] });
  const s8 = await notifyFavPlayerInterviews([row()], ALIASES, noAudience.deps, NOW);
  check("대상 0 → 발송 없음·unclaim 없음",
    s8.skippedNoAudience === 1 && noAudience.calls.sends.length === 0 && noAudience.calls.unclaims.length === 0);

  const multi = makeDeps();
  const s9 = await notifyFavPlayerInterviews(
    [row({ player_ids: ["55555", "77777"] })], ALIASES, multi.deps, NOW,
  );
  check("2인 태깅 → 선수별 개별 claim·발송",
    s9.sent === 2 && multi.calls.claims.length === 2 && multi.calls.sends.length === 2);

  const empty = makeDeps();
  const s10 = await notifyFavPlayerInterviews([], ALIASES, empty.deps, NOW);
  check("후보 0 → 스코어보드 fetch 없음",
    s10.candidates === 0 && empty.calls.dates.length === 0);

  const cached = makeDeps();
  await notifyFavPlayerInterviews(
    [row({ video_id: "v1" }), row({ video_id: "v2" })], ALIASES, cached.deps, NOW,
  );
  check("같은 날짜 스코어보드 1회만 fetch", cached.calls.dates.length === 1);
}

}

void main().then(() => {
  if (failures > 0) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nall checks passed");
});
