import { registerPlugin, Capacitor } from "@capacitor/core";

// Live Activity 네이티브 브리지 (W2) — 잠금화면 라이브 스코어 카드.
// 경기룸 진입 시 game-live 데이터로 start, 폴링으로 update, 종료 시 end.
// iOS 네이티브 앱에서만 동작(웹/Android는 no-op).

export interface LiveActivityState {
  awayScore: number;
  homeScore: number;
  inning: number;
  isTopInning: boolean;
  balls: number;
  strikes: number;
  outs: number;
  onFirst: boolean;
  onSecond: boolean;
  onThird: boolean;
  pitcherName: string;
  batterName: string;
  status: "live" | "final";
}

export interface LiveActivityStartData extends LiveActivityState {
  gameId: string;
  awayTeam: string;
  homeTeam: string;
  awayTeamCode: string;
  homeTeamCode: string;
}

interface LiveActivityPlugin {
  start(data: LiveActivityStartData): Promise<{ started: boolean }>;
  update(state: LiveActivityState): Promise<void>;
  end(state?: LiveActivityState): Promise<void>;
  isEnabled(): Promise<{ enabled: boolean }>;
}

const LiveActivity = registerPlugin<LiveActivityPlugin>("LiveActivity");

function isNativeIOS(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios";
}

/** 경기룸 진입 시 호출. 같은 gameId 재호출은 네이티브에서 update로 처리(중복 방지). */
export async function startLiveActivity(data: LiveActivityStartData): Promise<boolean> {
  if (!isNativeIOS()) return false;
  try {
    const res = await LiveActivity.start(data);
    return res?.started ?? false;
  } catch (e) {
    console.warn("[live-activity] start failed", e);
    return false;
  }
}

/** 진행 중 상태 갱신(포그라운드 폴링). */
export async function updateLiveActivity(state: LiveActivityState): Promise<void> {
  if (!isNativeIOS()) return;
  try {
    await LiveActivity.update(state);
  } catch {
    /* silent — 카드 갱신 실패가 앱에 영향 주지 않게 */
  }
}

/** 경기 종료 — 최종 스코어로 15분 유지 후 자동 제거(네이티브).
 *  finalState 필드는 top-level로 전달(Swift parseState가 top-level을 읽음 — 삼순 W2-②). */
export async function endLiveActivity(finalState?: LiveActivityState): Promise<void> {
  if (!isNativeIOS()) return;
  try {
    await LiveActivity.end(finalState);
  } catch {
    /* silent */
  }
}
