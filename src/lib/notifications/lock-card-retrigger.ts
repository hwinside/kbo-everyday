"use client";

// 마이페이지 "잠금화면 카드 다시 표시" — 유저가 잠금화면 카드(나우바/상단 알림/LA)를 실수로
// 지웠을 때 수동 재노출 트리거 (건의함 feedback:4369ee5a).
// - iOS: #671 인앱 autostart 경로 재사용(라이브 or 시작 30분 내 예정 최애팀 경기 start).
// - Android: 승격(Live Update) 카드의 스와이프 억제 기록을 리셋(setLiveUpdateOptIn이
//   suppression을 함께 지움, vc12+) 후 현재 경기 데이터로 즉시 재게시. 이후 매분 FCM 틱이
//   정상 갱신을 이어받는다.
// 양 플랫폼 모두 웹(원격 로드) 전용 변경 — 네이티브 재빌드 불필요.
// 결과는 started/none/failed 3분리(삼순 #680 blocker②) — 실패를 성공/경기없음으로 오안내 금지.
// prefs는 strict 조회(fail-closed, 삼순 재리뷰 blocker) — 자동 시작 경로의 fail-open과 달리
// 토큰 없음/non-OK/예외를 전부 failed로 닫아 "서버 OFF → 재생성 금지" 계약을 실패 경로에서도 보장.

import { supabase } from "@/lib/supabase/client";
import { isAndroid, isIOS } from "@/lib/capacitor/platform";
import { getMyTeamId } from "@/lib/store/myteam";
import {
  ID_TO_KBO_CODE,
  retriggerMyTeamLiveActivity,
  setLiveActivityEnabledCache,
} from "@/lib/native-live-activity";
import {
  getLiveUpdateStateStrict,
  setLiveUpdateOptIn,
  startGameNotification,
} from "@/lib/capacitor/game-notification";
import {
  decideAndroidSuppressionStep,
  pickMyTeamStartableGame,
  retriggerAllowedByPref,
  type StrictPrefResult,
} from "@/lib/notifications/la-autostart-policy";

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

/** started = 재표시 요청 성공 / none = 대상 경기 없음(라이브·시작 30분 내 예정 부재) /
 *  failed = prefs OFF·조회 실패·네트워크·브릿지·권한 등 — UI가 재시도 안내로 구분. */
export type RetriggerResult = "started" | "none" | "failed";

/** 서버 prefs.live_activity strict 조회 — 수동 재노출 전용(삼순 #680 재리뷰 blocker).
 *  자동 시작 경로(isLiveActivityEnabled)의 fail-open 캐시와 달리 토큰 없음/non-OK/예외를
 *  전부 "failed"로 닫는다. 성공 조회 시 클라 게이트 캐시를 정확값으로 동기화(iOS start
 *  내부 게이트와 일관). */
export async function fetchLiveActivityPrefStrict(): Promise<StrictPrefResult> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    if (!token) return "failed";
    const res = await fetch("/api/push/prefs", { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return "failed";
    const { prefs } = await res.json();
    const enabled = prefs?.live_activity !== false;
    setLiveActivityEnabledCache(enabled);
    return enabled ? "enabled" : "disabled";
  } catch {
    return "failed";
  }
}

/** 잠금화면 카드 수동 재노출. 비네이티브는 failed(버튼이 네이티브 전용이라 실제론 미도달). */
export async function retriggerLockScreenCard(): Promise<RetriggerResult> {
  // strict OFF 방어(iOS/Android 공통 진입부, fail-closed) — UI 게이트 레이스/우회 호출에도
  // 서버 OFF 유저 재생성 금지. disabled/조회 실패 모두 failed(문구가 설정·권한 확인 안내).
  if (!retriggerAllowedByPref(await fetchLiveActivityPrefStrict())) return "failed";
  if (isIOS) {
    const outcome = await retriggerMyTeamLiveActivity();
    if (outcome === "started") return "started";
    if (outcome === "none") return "none";
    return "failed"; // failed | skipped(in-flight 등) — 재시도 안내
  }
  if (!isAndroid) return "failed";
  const myTeamId = getMyTeamId();
  const myTeamCode = myTeamId ? ID_TO_KBO_CODE[myTeamId] ?? "" : "";
  if (!myTeamCode) return "none";
  let games: LiveGameLite[] = [];
  try {
    const res = await fetch("/api/game-live");
    if (!res.ok) return "failed";
    const data = (await res.json()) as { games?: LiveGameLite[] };
    games = data.games ?? [];
  } catch {
    return "failed";
  }
  const picked = pickMyTeamStartableGame(games, myTeamCode, Date.now());
  if (!picked) return "none";
  // 승격 카드 상태 strict 조회 — 브릿지 실패(null)는 suppression 상태 불명이라 failed
  // (모른 채 재게시하면 네이티브 post()가 조용히 suppress → 성공 오안내). opt-in이면
  // 스와이프 Unpin 억제(suppressed_game_id) 리셋 — opt-in 값은 현재 상태(true) 그대로
  // 재기록. 리셋 실패도 같은 이유로 failed. 미지원/opt-out은 일반 상단 알림 경로라
  // 억제 개념 없음 → 재게시만.
  const step = decideAndroidSuppressionStep(await getLiveUpdateStateStrict());
  if (step === "failed") return "failed";
  if (step === "reset") {
    const reset = await setLiveUpdateOptIn(true);
    if (!reset) return "failed";
  }
  const g = picked.game;
  const path = `/games/${g.gameId}`;
  // 서버 android-widget-live.ts payload와 동일 문구 구성. 브릿지 성공 = "요청 접수"
  // (네이티브 post()가 권한 미허용을 삼키므로 게시 확정은 아님 — UI 문구도 요청 수준).
  const posted =
    picked.kind === "live"
      ? await startGameNotification(
          `${g.awayName} ${g.awayScore} : ${g.homeScore} ${g.homeName}`,
          g.inning > 0 ? `${g.inning}회${g.isTop ? "초" : "말"}` : "경기 진행 중",
          path,
        )
      : await startGameNotification(
          `⚾ ${g.awayName} vs ${g.homeName}`,
          "곧 경기 시작! 잠금화면에서 실시간 중계를 확인하세요",
          path,
        );
  return posted ? "started" : "failed";
}
