/**
 * 최애선수 수훈 인터뷰 알림 smoke.
 * DB/네트워크 없음(deps 주입). 실패 시 exit 1.
 *
 * 이 알림은 감지를 하지 않는다. 기존 postgame-interviews 파이프라인이 이미
 * game_id·player_names를 고신뢰로 확정해 postgame_interviews에 저장한 결과를
 * 받아서, 승리팀 로스터로 kboId를 확정하고 최애선수 팬에게 보낼 뿐이다.
 *
 * 삼순 NO-GO 4축이 회귀하면 RED가 되도록 박아둔다:
 *  A. durable retry — 발송 실패 행은 markNotified 되지 않아 다음 run이 재입력
 *  B. audience/sendPush throw 후에도 claim 해제(잔류 시 영구 유실)
 *  C. 한 영상에서 같은 유저 중복 푸시 금지(video×user)
 *  D. kboId 미확정 fail-close
 */
import {
  notifyFavPlayerInterviews,
  INTERVIEW_PREF_KEY,
  type InterviewDeps,
  type PendingInterview,
} from "../../src/lib/notifications/fav-player-interview";
import { interviewPlayerLinks } from "../../src/lib/video/postgame-interviews-route-policy";
import { PREF_KEYS, DEFAULT_PREFS } from "../../src/lib/notifications/prefs";
import * as fs from "node:fs";
import * as path from "node:path";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  PASS ${name}`);
  else { failures++; console.error(`  FAIL ${name}`); }
}

/** 실 로스터에서 해당 팀 소속으로 이름이 유일한 선수 — fixture를 실측에 결속. */
function uniquePlayers(teamId: number, count: number) {
  const roster = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../../src/lib/constants/players-roster.json"), "utf8"),
  ) as { name: string; kboId: string; teamId: number }[];
  const seen = new Map<string, number>();
  for (const p of roster) if (p.teamId === teamId) seen.set(p.name, (seen.get(p.name) ?? 0) + 1);
  const out: { name: string; kboId: string }[] = [];
  for (const p of roster) {
    if (out.length >= count) break;
    if (p.teamId !== teamId || seen.get(p.name) !== 1) continue;
    if (interviewPlayerLinks([p.name], teamId)[0]?.kboId === p.kboId) {
      out.push({ name: p.name, kboId: p.kboId });
    }
  }
  if (out.length < count) throw new Error(`roster: need ${count} unique players for team ${teamId}`);
  return out;
}
const [P1, P2] = uniquePlayers(1, 2); // LG

function iv(over: Partial<PendingInterview> = {}): PendingInterview {
  return {
    gameId: "20260814SKLG0",
    videoId: "vid-1",
    title: `${P1.name} 수훈선수 인터뷰`,
    playerNames: [P1.name],
    winnerTeamId: 1,
    ...over,
  };
}

interface Calls {
  claims: string[]; unclaims: string[]; marked: string[][];
  sends: { userIds: string[]; title: string; body: string; url: string; prefKey: string }[];
}
interface Over {
  pending?: PendingInterview[];
  claim?: (id: string) => boolean;
  audience?: (kboId: string) => string[];
  audienceThrow?: boolean;
  sendOk?: boolean;
  sendThrow?: boolean;
}
function makeDeps(over: Over = {}): { deps: InterviewDeps; calls: Calls } {
  const calls: Calls = { claims: [], unclaims: [], marked: [], sends: [] };
  const deps: InterviewDeps = {
    fetchPendingInterviews: async () => over.pending ?? [iv()],
    markNotified: async (ids) => { calls.marked.push(ids); },
    claimEvent: async (id) => { calls.claims.push(id); return over.claim ? over.claim(id) : true; },
    unclaimEvent: async (id) => { calls.unclaims.push(id); },
    fetchFavoritePlayerFanIds: async (kboId) => {
      if (over.audienceThrow) throw new Error("audience boom");
      return over.audience ? over.audience(kboId) : ["u1", "u2"];
    },
    sendPush: async (userIds, payload, prefKey) => {
      calls.sends.push({ userIds, ...payload, prefKey });
      if (over.sendThrow) throw new Error("send boom");
      return { ok: over.sendOk ?? true };
    },
  };
  return { deps, calls };
}

async function main() {
  console.log(`[fixture] LG unique players = ${P1.name}(${P1.kboId}), ${P2.name}(${P2.kboId})`);

  console.log("[0] 토글 키 계약");
  {
    check("PREF_KEYS에 등록", (PREF_KEYS as readonly string[]).includes(INTERVIEW_PREF_KEY));
    check("기본 on", DEFAULT_PREFS[INTERVIEW_PREF_KEY] === true);
  }

  console.log("[1] 종단 발송 경로");
  {
    const { deps, calls } = makeDeps();
    const s = await notifyFavPlayerInterviews(deps);
    check("sent=1", s.sent === 1 && s.pending === 1);
    check("claim event_id = interview#{videoId}#{kboId}", calls.claims[0] === `interview#vid-1#${P1.kboId}`);
    check("딥링크 = 경기페이지", calls.sends[0]?.url === "/games/20260814SKLG0");
    check("prefKey 전달(토글 필터)", calls.sends[0]?.prefKey === INTERVIEW_PREF_KEY);
    check("제목에 선수명", calls.sends[0]?.title.includes(P1.name));
    check("본문 = 인터뷰 제목", calls.sends[0]?.body === `${P1.name} 수훈선수 인터뷰`);
    check("성공 시 markNotified", calls.marked[0]?.includes("vid-1") === true && s.settled === 1);
    check("unclaim 없음", calls.unclaims.length === 0);
  }

  console.log("[2-A] durable retry (삼순 NO-GO ①)");
  {
    // 발송 실패한 행은 처리완료로 찍히면 안 된다 — 찍히면 다음 run이 재입력 못 해 영구 유실.
    const f = makeDeps({ sendOk: false });
    const s = await notifyFavPlayerInterviews(f.deps);
    check("발송 실패 → markNotified 안 함(다음 run 재입력)",
      s.failed === 1 && s.settled === 0 && f.calls.marked.length === 0);
    check("발송 실패 → unclaim(선수 단위 재시도 가능)",
      f.calls.unclaims[0] === `interview#vid-1#${P1.kboId}`);

    // 2건 중 1건만 실패하면 성공한 행만 확정된다.
    const mixed = makeDeps({
      pending: [iv({ videoId: "ok-1" }), iv({ videoId: "bad-1", playerNames: [P2.name] })],
      sendOk: true,
    });
    // P2만 실패시키기 위해 sendPush를 래핑
    const origSend = mixed.deps.sendPush;
    mixed.deps.sendPush = async (u, p, k) => {
      const r = await origSend(u, p, k);
      return p.title.includes(P2.name) ? { ok: false } : r;
    };
    const s2 = await notifyFavPlayerInterviews(mixed.deps);
    check("부분 실패 → 성공 행만 확정",
      s2.settled === 1 && mixed.calls.marked[0]?.includes("ok-1") === true
      && mixed.calls.marked[0]?.includes("bad-1") === false);
  }

  console.log("[2-B] 예외 경로 claim 해제 (삼순 NO-GO ②)");
  {
    const a = makeDeps({ audienceThrow: true });
    const s = await notifyFavPlayerInterviews(a.deps);
    check("audience throw → unclaim(잔류 금지)",
      a.calls.unclaims[0] === `interview#vid-1#${P1.kboId}` && s.failed === 1);
    check("audience throw → markNotified 안 함", a.calls.marked.length === 0 && s.settled === 0);

    const t = makeDeps({ sendThrow: true });
    const s2 = await notifyFavPlayerInterviews(t.deps);
    check("sendPush throw → unclaim",
      t.calls.unclaims[0] === `interview#vid-1#${P1.kboId}` && s2.failed === 1);
    check("sendPush throw → markNotified 안 함", t.calls.marked.length === 0);
  }

  console.log("[2-C] video×user 중복 방지 (삼순 NO-GO ③)");
  {
    // 한 영상에 2명, 유저가 둘 다 최애 → 같은 영상으로 두 번 가면 안 된다.
    const d = makeDeps({
      pending: [iv({ playerNames: [P1.name, P2.name] })],
      audience: () => ["dup-user", "solo"],
    });
    const s = await notifyFavPlayerInterviews(d.deps);
    const allRecipients = d.calls.sends.flatMap((x) => x.userIds);
    const dupCount = allRecipients.filter((u) => u === "dup-user").length;
    check("같은 유저에게 한 영상 1회만", dupCount === 1);
    check("중복 제외 카운트 기록", s.skippedDuplicateUser >= 1);
    check("두 선수 각각 claim", d.calls.claims.length === 2);
  }

  console.log("[2-D] kboId 미확정 fail-close (삼순 NO-GO ④축 관련)");
  {
    const u = makeDeps({ pending: [iv({ playerNames: ["존재하지않는선수XYZ"] })] });
    const s = await notifyFavPlayerInterviews(u.deps);
    check("미확정 → 미발송·claim 없음",
      s.sent === 0 && s.skippedUnresolved === 1 && u.calls.claims.length === 0);
    check("미확정만 있는 행도 처리완료(재시도 무의미)", s.settled === 1);

    const w = makeDeps({ pending: [iv({ winnerTeamId: null })] });
    const s2 = await notifyFavPlayerInterviews(w.deps);
    check("winnerTeamId 없음 → 미확정", s2.skippedUnresolved === 1 && w.calls.sends.length === 0);

    const x = makeDeps({ pending: [iv({ winnerTeamId: 2 })] });
    const s3 = await notifyFavPlayerInterviews(x.deps);
    check("이름이 승리팀 소속 아니면 미발송", s3.skippedUnresolved === 1 && x.calls.sends.length === 0);
  }

  console.log("[3] 경계 처리");
  {
    const dup = makeDeps({ claim: () => false });
    const s1 = await notifyFavPlayerInterviews(dup.deps);
    check("중복 claim → 미발송", s1.sent === 0 && s1.skippedClaimed === 1 && dup.calls.sends.length === 0);

    const noAud = makeDeps({ audience: () => [] });
    const s2 = await notifyFavPlayerInterviews(noAud.deps);
    check("대상 0 → 발송·unclaim 없음",
      s2.skippedNoAudience === 1 && noAud.calls.sends.length === 0 && noAud.calls.unclaims.length === 0);
    check("대상 0 → 처리완료", s2.settled === 1);

    const empty = makeDeps({ pending: [] });
    const s3 = await notifyFavPlayerInterviews(empty.deps);
    check("미발송 0 → no-op", s3.pending === 0 && empty.calls.sends.length === 0 && empty.calls.marked.length === 0);
  }
}

void main().then(() => {
  if (failures > 0) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nall checks passed");
});
