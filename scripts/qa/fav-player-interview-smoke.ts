/**
 * 최애선수 수훈 인터뷰 알림 smoke.
 * DB/네트워크 없음(deps 주입). 실패 시 exit 1.
 *
 * 발송 모델(삼순 4라운드): 영상당 union audience 1회 발송 + row lease + sent 마커.
 *  - 영상 1건 = 푸시 1회 → video×user 중복 경로가 구조적으로 없음
 *  - lease가 동시 run을 배제, sent 마커가 markSent 실패 후 재발송을 방어
 *  - unclaim 개념 없음 — 실패 복구는 전부 lease 해제(pending 복귀)
 *
 * 삼순 NO-GO 축이 회귀하면 RED:
 *  R4-① in-flight/완료 분리 — 마커 present=회복, error=손대지 않음(released)
 *  R4-② 실패 은폐 금지 — 발송실패/throw/마커불확실 → 전부 released(재시도), sent 전이 금지
 *  R4-③ union audience 1회 발송 — 2인 영상 합집합 dedupe·발송 1회·제목에 두 선수
 *  R2-D kboId 미확정 fail-close
 */
import {
  notifyFavPlayerInterviews,
  INTERVIEW_PREF_KEY,
  type InterviewDeps,
  type PendingInterview,
  type SentMarkerState,
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
    id: "row-1",
    gameId: "20260814SKLG0",
    videoId: "vid-1",
    title: `${P1.name} 수훈선수 인터뷰`,
    playerNames: [P1.name],
    winnerTeamId: 1,
    ...over,
  };
}

interface Calls {
  markedSent: string[][]; released: string[][]; markerChecks: string[]; markerInserts: string[];
  audience: string[];
  sends: Array<{
    userIds: string[]; title: string; body: string; url: string; prefKey: string;
    data: { notification_id: string }; collapseKey: string; apnsCollapseId: string;
  }>; 
}
interface Over {
  leased?: PendingInterview[];
  marker?: (gameId: string, videoId: string) => SentMarkerState;
  markerThrow?: boolean;
  markerInsertOk?: boolean;
  audience?: (kboId: string) => string[];
  audienceThrow?: boolean;
  sendOk?: boolean;
  sendThrow?: boolean;
}
function makeDeps(over: Over = {}): { deps: InterviewDeps; calls: Calls } {
  const calls: Calls = {
    markedSent: [], released: [], markerChecks: [], markerInserts: [], audience: [], sends: [],
  };
  const deps: InterviewDeps = {
    leasePendingInterviews: async () => over.leased ?? [iv()],
    markSent: async (ids) => { calls.markedSent.push(ids); },
    releaseLease: async (ids) => { calls.released.push(ids); },
    hasSentMarker: async (gameId, videoId) => {
      calls.markerChecks.push(`${gameId}#${videoId}`);
      if (over.markerThrow) throw new Error("marker boom");
      return over.marker ? over.marker(gameId, videoId) : "absent";
    },
    insertSentMarker: async (gameId, videoId) => {
      calls.markerInserts.push(`${gameId}#${videoId}`);
      return over.markerInsertOk ?? true;
    },
    fetchFavoritePlayerFanIds: async (kboId) => {
      calls.audience.push(kboId);
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
    check("상수 리터럴 정확", INTERVIEW_PREF_KEY === "fav_player_interview");
  }

  console.log("[1] 종단 발송 경로");
  {
    const { deps, calls } = makeDeps();
    const s = await notifyFavPlayerInterviews(deps);
    check("sent=1", s.sent === 1 && s.leased === 1);
    check("복합키 마커 선확인", calls.markerChecks[0] === "20260814SKLG0#vid-1");
    check("발송 1회", calls.sends.length === 1);
    check("딥링크 = 경기페이지", calls.sends[0]?.url === "/games/20260814SKLG0");
    check("prefKey 전달(토글 필터)", calls.sends[0]?.prefKey === INTERVIEW_PREF_KEY);
    const stableId = "interview#20260814SKLG0#vid-1";
    check("안정 notification id(복합키)", calls.sends[0]?.data.notification_id === stableId);
    check("Android/iOS provider dedupe id", calls.sends[0]?.collapseKey === stableId
      && calls.sends[0]?.apnsCollapseId === stableId);
    check("제목에 선수명", calls.sends[0]?.title.includes(P1.name));
    check("성공 → 복합키 마커 기록", calls.markerInserts[0] === "20260814SKLG0#vid-1");
    check("성공 → sent 전이(row id)", calls.markedSent[0]?.[0] === "row-1" && s.sent === 1);
    check("release 없음", calls.released.length === 0);
  }

  console.log("[R4-①] in-flight/완료 분리 — sent 마커");
  {
    // 직전 run이 발송 후 markSent 전에 죽음 → 마커 present → 재발송 없이 sent 회복
    const p = makeDeps({ marker: () => "present" });
    const s = await notifyFavPlayerInterviews(p.deps);
    check("마커 present → 재발송 없이 sent 회복",
      s.recoveredFromMarker === 1 && p.calls.sends.length === 0
      && p.calls.markedSent[0]?.[0] === "row-1");

    // 마커 조회 오류 → absent로 단정하면 이중발송 → 손대지 않고 release
    const e = makeDeps({ marker: () => "error" });
    const s2 = await notifyFavPlayerInterviews(e.deps);
    check("마커 error → 발송·sent 전이 금지, release",
      s2.released === 1 && e.calls.sends.length === 0
      && e.calls.markedSent.length === 0 && e.calls.released[0]?.[0] === "row-1");

    const t = makeDeps({ markerThrow: true });
    const s3 = await notifyFavPlayerInterviews(t.deps);
    check("마커 throw → releaseLease 실호출",
      s3.released === 1 && t.calls.released[0]?.includes("row-1") === true
      && t.calls.sends.length === 0);

    // 마커 기록 실패 — 발송은 성공했으므로 sent 전이는 하되 관측 카운트
    const w = makeDeps({ markerInsertOk: false });
    const s4 = await notifyFavPlayerInterviews(w.deps);
    check("마커 기록 실패 → sent 전이 + 관측 카운트",
      s4.sent === 1 && s4.markerWriteFailures === 1 && w.calls.markedSent.length === 1);
  }

  console.log("[R4-②] 실패 은폐 금지 — 전부 release(재시도)");
  {
    const f = makeDeps({ sendOk: false });
    const s = await notifyFavPlayerInterviews(f.deps);
    check("발송 실패 → release·sent 전이 금지",
      s.released === 1 && f.calls.markedSent.length === 0 && f.calls.released[0]?.[0] === "row-1");
    check("발송 실패 → 마커 기록 안 함", f.calls.markerInserts.length === 0);

    const t = makeDeps({ sendThrow: true });
    const s2 = await notifyFavPlayerInterviews(t.deps);
    // counter가 아니라 실제 releaseLease 호출에 row id가 담겼는지를 본다 —
    // counter만 보면 "released++만 하고 해제 안 함" 변이가 GREEN으로 샐(mutation M7 실측).
    check("sendPush throw → releaseLease 실호출",
      s2.released === 1 && t.calls.released[0]?.includes("row-1") === true
      && t.calls.markedSent.length === 0);

    const a = makeDeps({ audienceThrow: true });
    const s3 = await notifyFavPlayerInterviews(a.deps);
    check("audience throw → releaseLease 실호출·발송 없음",
      s3.released === 1 && a.calls.released[0]?.includes("row-1") === true
      && a.calls.sends.length === 0 && a.calls.markedSent.length === 0);

    // 부분 실패 — 2행 중 1행만 실패하면 성공 행만 sent
    const mixed = makeDeps({
      leased: [
        iv({ id: "ok-row", videoId: "ok-vid" }),
        iv({ id: "bad-row", videoId: "bad-vid" }),
      ],
      marker: (_gameId, vid) => (vid === "bad-vid" ? "error" : "absent"),
    });
    const s4 = await notifyFavPlayerInterviews(mixed.deps);
    check("부분 실패 → 성공 행만 sent, 실패 행은 release",
      mixed.calls.markedSent[0]?.includes("ok-row") === true
      && mixed.calls.markedSent[0]?.includes("bad-row") === false
      && mixed.calls.released[0]?.includes("bad-row") === true && s4.sent === 1);
  }

  console.log("[R4-③] union audience 1회 발송");
  {
    // 2인 영상 + 두 선수 팬에 공통 유저 → 푸시 1회, 수신자 합집합(중복 없음)
    const d = makeDeps({
      leased: [iv({ playerNames: [P1.name, P2.name] })],
      audience: (kboId) => (kboId === P1.kboId ? ["shared", "p1fan"] : ["shared", "p2fan"]),
    });
    const s = await notifyFavPlayerInterviews(d.deps);
    check("영상당 발송 1회", d.calls.sends.length === 1 && s.sent === 1);
    const recipients = d.calls.sends[0]?.userIds ?? [];
    check("합집합 수신(3명, shared 1회)",
      recipients.length === 3
      && recipients.filter((u) => u === "shared").length === 1
      && recipients.includes("p1fan") && recipients.includes("p2fan"));
    check("두 선수 audience 모두 조회",
      d.calls.audience.includes(P1.kboId) && d.calls.audience.includes(P2.kboId));
    check("제목에 두 선수명", d.calls.sends[0]?.title.includes(P1.name) === true
      && d.calls.sends[0]?.title.includes(P2.name) === true);
  }

  console.log("[R2-D] kboId 미확정 fail-close");
  {
    const u = makeDeps({ leased: [iv({ playerNames: ["존재하지않는선수XYZ"] })] });
    const s = await notifyFavPlayerInterviews(u.deps);
    check("전원 미확정 → 발송 없음·sent 종결(재시도 무의미)",
      s.sent === 0 && s.settledUnresolved === 1 && u.calls.sends.length === 0
      && u.calls.markedSent[0]?.[0] === "row-1");

    // 2인 중 1인만 확정 → 확정 선수 팬에게만, 발송은 1회
    const half = makeDeps({ leased: [iv({ playerNames: [P1.name, "존재하지않는선수XYZ"] })] });
    const s2 = await notifyFavPlayerInterviews(half.deps);
    check("부분 확정 → 확정 선수만으로 1회 발송",
      s2.sent === 1 && half.calls.sends.length === 1
      && half.calls.audience.length === 1 && half.calls.audience[0] === P1.kboId);

    const w = makeDeps({ leased: [iv({ winnerTeamId: null })] });
    const s3 = await notifyFavPlayerInterviews(w.deps);
    check("winnerTeamId 없음 → 미확정 종결", s3.settledUnresolved === 1 && w.calls.sends.length === 0);

    const x = makeDeps({ leased: [iv({ winnerTeamId: 2 })] });
    const s4 = await notifyFavPlayerInterviews(x.deps);
    check("이름이 승리팀 소속 아니면 미발송", s4.settledUnresolved === 1 && x.calls.sends.length === 0);
  }

  console.log("[3] 경계 처리");
  {
    const noAud = makeDeps({ audience: () => [] });
    const s = await notifyFavPlayerInterviews(noAud.deps);
    check("대상 0 → 발송 없음·sent 종결",
      s.settledNoAudience === 1 && noAud.calls.sends.length === 0
      && noAud.calls.markedSent[0]?.[0] === "row-1");

    const empty = makeDeps({ leased: [] });
    const s2 = await notifyFavPlayerInterviews(empty.deps);
    check("lease 0 → no-op",
      s2.leased === 0 && empty.calls.sends.length === 0
      && empty.calls.markedSent.length === 0 && empty.calls.released.length === 0);
  }
}

void main().then(() => {
  if (failures > 0) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nall checks passed");
});
