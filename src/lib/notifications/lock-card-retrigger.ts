"use client";

// 마이페이지 "잠금화면 카드 다시 표시" — 유저가 잠금화면 카드(나우바/상단 알림/LA)를 실수로
// 지웠을 때 수동 재노출 트리거 (건의함 feedback:4369ee5a).
// - iOS: #671 인앱 autostart 경로 재사용(라이브 or 시작 30분 내 예정 최애팀 경기 start).
// - Android: 승격(Live Update) 카드의 스와이프 억제 기록을 리셋(setLiveUpdateOptIn이
//   suppression을 함께 지움, vc12+) 후 현재 경기 데이터로 즉시 재게시. 이후 매분 FCM 틱이
//   정상 갱신을 이어받는다. 구빌드(메서드 부재)는 브릿지가 조용히 실패 → 다음 틱 자연 복구.
// 양 플랫폼 모두 웹(원격 로드) 전용 변경 — 네이티브 재빌드 불필요.

import { isAndroid, isIOS } from "@/lib/capacitor/platform";
import { getMyTeamId } from "@/lib/store/myteam";
import { ID_TO_KBO_CODE, retriggerMyTeamLiveActivity } from "@/lib/native-live-activity";
import {
  getLiveUpdateState,
  setLiveUpdateOptIn,
  startGameNotification,
} from "@/lib/capacitor/game-notification";
import { pickMyTeamStartableGame } from "@/lib/notifications/la-autostart-policy";

/** /api/game-live 응답의 재게시에 필요한 필드만 (AutoStartCandidateGame 상위집합). */
interface LiveGameLite {
  gameId: string;
  awayName: string;
  homeName: string;
  awayScore: number;
  homeScore: number;
  inning: number;
  isTop: boolean;
  isLive: boolean;
  status?: string;
  time?: string;
}

export type RetriggerResult = "started" | "none";

/**
 * 잠금화면 카드 수동 재노출. "started" = 카드 재게시 성공,
 * "none" = 대상 경기 없음(라이브·시작 30분 내 예정 최애팀 경기 부재)/비네이티브.
 */
export async function retriggerLockScreenCard(): Promise<RetriggerResult> {
  if (isIOS) {
    return (await retriggerMyTeamLiveActivity()) ? "started" : "none";
  }
  if (!isAndroid) return "none";
  const myTeamId = getMyTeamId();
  const myTeamCode = myTeamId ? ID_TO_KBO_CODE[myTeamId] ?? "" : "";
  if (!myTeamCode) return "none";
  let games: LiveGameLite[] = [];
  try {
    const res = await fetch("/api/game-live");
    if (!res.ok) return "none";
    const data = (await res.json()) as { games?: LiveGameLite[] };
    games = data.games ?? [];
  } catch {
    return "none";
  }
  const picked = pickMyTeamStartableGame(games, myTeamCode, Date.now());
  if (!picked) return "none";
  // 승격 카드 opt-in 유저: 스와이프 Unpin 억제(suppressed_game_id)를 리셋 — opt-in 값은
  // 현재 상태(true) 그대로 재기록. opt-out 유저는 일반 상단 알림 경로라 억제 자체가 없음.
  const lu = await getLiveUpdateState();
  if (lu.supported && lu.enabled) await setLiveUpdateOptIn(true);
  const g = picked.game;
  const path = `/games/${g.gameId}`;
  if (picked.kind === "live") {
    // 서버 android-widget-live.ts 라이브 payload와 동일 문구 구성.
    await startGameNotification(
      `${g.awayName} ${g.awayScore} : ${g.homeScore} ${g.homeName}`,
      g.inning > 0 ? `${g.inning}회${g.isTop ? "초" : "말"}` : "경기 진행 중",
      path,
    );
  } else {
    await startGameNotification(
      `⚾ ${g.awayName} vs ${g.homeName}`,
      "곧 경기 시작! 잠금화면에서 실시간 중계를 확인하세요",
      path,
    );
  }
  return "started";
}
