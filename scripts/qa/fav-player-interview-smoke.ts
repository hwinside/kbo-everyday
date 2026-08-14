/**
 * 최애선수 수훈 인터뷰 알림 smoke.
 * DB/네트워크 없음(deps 주입). 실패 시 exit 1.
 *
 * 이 알림은 감지를 하지 않는다. 기존 postgame-interviews 파이프라인이 이미
 * game_id·player_names를 고신뢰로 확정해 postgame_interviews에 저장한 결과를
 * 받아서, 승리팀 로스터로 kboId를 확정하고 최애선수 팬에게 보낼 뿐이다.
 *
 * 검증 축:
 *  1. 종단 발송: 확정 인터뷰 → kboId 확정 → claim → 대상조회 → sendPush(url·prefKey·title)
 *  2. kboId 미확정(동명이인·로스터 부재) → 미발송
 *  3. 팀 제약: winnerTeamId로 동명이인 분리 (interviewPlayerLinks 재사용)
 *  4. 실패/경계: claim 중복 / 대상 0 / 발송 실패 unclaim / 2인 개별 / 입력 0
 *
 * interviewPlayerLinks는 실 로스터 JSON을 읽으므로, 실재 선수(문보경 LG teamId=1)로
 * 검증한다 — 지어낸 이름이 아니라 화면 링크와 같은 확정 경로를 태운다.
 */
import {
  notifyFavPlayerInterviews,
  INTERVIEW_PREF_KEY,
  type InterviewDeps,
  type StoredInterview,
} from "../../src/lib/notifications/fav-player-interview";
import { interviewPlayerLinks } from "../../src/lib/video/postgame-interviews-route-policy";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS ${name}`);
  else { failures++; console.error(`  FAIL ${name}`); }
}

// 실 로스터에서 LG(teamId=1) 소속으로 이름이 유일한 선수를 골라 fixture 신뢰도를 실측에 결속.
function findUniqueLgPlayer(): { name: string; kboId: string; teamId: number } {
  const roster = JSON.parse(
    require("fs").readFileSync(
      require("path").join(__dirname, "../../src/lib/constants/players-roster.json"), "utf8",
    ),
  ) as { name: string; kboId: string; teamId: number }[];
  const byName = new Map<string, number>();
  for (const p of roster) if (p.teamId === 1) byName.set(p.name, (byName.get(p.name) ?? 0) + 1);
  for (const p of roster) {
    if (p.teamId === 1 && byName.get(p.name) === 1) {
      // interviewPlayerLinks가 확정하는지 교차 확인
      const link = interviewPlayerLinks([p.name], 1)[0];
      if (link?.kboId === p.kboId) return { name: p.name, kboId: p.kboId, teamId: 1 };
    }
  }
  throw new Error("no unique LG player found in roster");
}
const LG = findUniqueLgPlayer();

function iv(over: Partial<StoredInterview> = {}): StoredInterview {
  return {
    gameId: "20260814SKLG0",
    videoId: "vid-1",
    title: `${LG.name} 수훈선수 인터뷰`,
    playerNames: [LG.name],
    winnerTeamId: 1,
    ...over,
  };
}

interface Calls {
  claims: string[]; unclaims: string[];
  sends: { userIds: string[]; title: string; body: string; url: string; prefKey: string }[];
}
interface Over { claim?: (id: string) => boolean; audience?: (kboId: string) => string[]; sendOk?: boolean; }
function makeDeps(over: Over = {}): { deps: InterviewDeps; calls: Calls } {
  const calls: Calls = { claims: [], unclaims: [], sends: [] };
  const deps: InterviewDeps = {
    claimEvent: async (id) => { calls.claims.push(id); return over.claim ? over.claim(id) : true; },
    unclaimEvent: async (id) => { calls.unclaims.push(id); },
    fetchFavoritePlayerFanIds: async (kboId) => (over.audience ? over.audience(kboId) : ["u1", "u2"]),
    sendPush: async (userIds, payload, prefKey) => {
      calls.sends.push({ userIds, ...payload, prefKey });
      return { ok: over.sendOk ?? true };
    },
  };
  return { deps, calls };
}

async function main() {
  console.log(`[fixture] LG unique player = ${LG.name} (${LG.kboId})`);

  console.log("[1] 종단 발송 경로");
  {
    const { deps, calls } = makeDeps();
    const s = await notifyFavPlayerInterviews([iv()], deps);
    check("sent=1", s.sent === 1 && s.interviews === 1);
    check("claim event_id = interview#{videoId}#{kboId}", calls.claims[0] === `interview#vid-1#${LG.kboId}`);
    check("발송 1회", calls.sends.length === 1);
    check("딥링크 = 경기페이지", calls.sends[0]?.url === "/games/20260814SKLG0");
    check("prefKey 전달(토글 필터)", calls.sends[0]?.prefKey === INTERVIEW_PREF_KEY);
    check("제목에 선수명", calls.sends[0]?.title.includes(LG.name));
    check("본문 = 인터뷰 제목", calls.sends[0]?.body === `${LG.name} 수훈선수 인터뷰`);
    check("대상 유저 전달", calls.sends[0]?.userIds.length === 2);
    check("unclaim 없음", calls.unclaims.length === 0);
  }

  console.log("[2] kboId 미확정 → 미발송");
  {
    // 로스터에 없는 이름 → interviewPlayerLinks가 kboId=null → 발송 안 함
    const { deps, calls } = makeDeps();
    const s = await notifyFavPlayerInterviews(
      [iv({ playerNames: ["존재하지않는선수XYZ"] })], deps,
    );
    check("미확정 → 미발송·claim 없음",
      s.sent === 0 && s.skippedUnresolved === 1 && calls.claims.length === 0 && calls.sends.length === 0);
    // winnerTeamId=null → 팀으로 좁힐 수 없어 확정 불가
    const t2 = makeDeps();
    const s2 = await notifyFavPlayerInterviews([iv({ winnerTeamId: null })], t2.deps);
    check("winnerTeamId 없음 → 미확정",
      s2.skippedUnresolved === 1 && t2.calls.sends.length === 0);
  }

  console.log("[3] 팀 제약(interviewPlayerLinks 재사용)");
  {
    // LG 선수 이름을 다른 팀(teamId=2) 승리로 넣으면 확정 안 됨
    const { deps, calls } = makeDeps();
    const s = await notifyFavPlayerInterviews([iv({ winnerTeamId: 2 })], deps);
    check("이름이 승리팀 소속이 아니면 미발송", s.skippedUnresolved === 1 && calls.sends.length === 0);
  }

  console.log("[4] 실패/경계 처리");
  {
    const dup = makeDeps({ claim: () => false });
    const s1 = await notifyFavPlayerInterviews([iv()], dup.deps);
    check("중복 claim → 미발송", s1.sent === 0 && s1.skippedClaimed === 1 && dup.calls.sends.length === 0);

    const noAud = makeDeps({ audience: () => [] });
    const s2 = await notifyFavPlayerInterviews([iv()], noAud.deps);
    check("대상 0 → 발송·unclaim 없음",
      s2.skippedNoAudience === 1 && noAud.calls.sends.length === 0 && noAud.calls.unclaims.length === 0);

    const fail = makeDeps({ sendOk: false });
    const s3 = await notifyFavPlayerInterviews([iv()], fail.deps);
    check("발송 실패 → unclaim(재시도 가능)",
      s3.failed === 1 && s3.sent === 0 && fail.calls.unclaims[0] === `interview#vid-1#${LG.kboId}`);

    const empty = makeDeps();
    const s4 = await notifyFavPlayerInterviews([], empty.deps);
    check("입력 0 → 발송 없음", s4.interviews === 0 && empty.calls.sends.length === 0);
  }

  console.log("[5] 2인 인터뷰 → 확정된 선수만 개별 발송");
  {
    // 실재 유일 LG 선수 + 미확정 이름 혼합 → 확정 1명만
    const { deps, calls } = makeDeps();
    const s = await notifyFavPlayerInterviews(
      [iv({ playerNames: [LG.name, "존재하지않는선수XYZ"] })], deps,
    );
    check("확정 1명 발송 + 미확정 1명 skip",
      s.sent === 1 && s.skippedUnresolved === 1 && calls.sends.length === 1);
  }
}

void main().then(() => {
  if (failures > 0) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nall checks passed");
});
