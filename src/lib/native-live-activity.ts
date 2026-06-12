import { registerPlugin, Capacitor } from "@capacitor/core";
import { supabase } from "@/lib/supabase/client";

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
  stadium: string;
  status: "live" | "final";
}

export interface LiveActivityStartData extends LiveActivityState {
  gameId: string;
  awayTeam: string;
  homeTeam: string;
  awayTeamCode: string;
  homeTeamCode: string;
  /** 최애팀 코드(KBO 2자 코드). 강조/컬러용. 미설정/비참여 시 "". */
  myTeamCode: string;
}

interface LiveActivityPlugin {
  start(data: LiveActivityStartData): Promise<{ started: boolean }>;
  update(state: LiveActivityState): Promise<void>;
  end(state?: LiveActivityState): Promise<void>;
  isEnabled(): Promise<{ enabled: boolean }>;
  addListener(
    eventName: "liveActivityPushToken",
    listenerFunc: (data: { gameId: string; token: string }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
}

const LiveActivity = registerPlugin<LiveActivityPlugin>("LiveActivity");

function isNativeIOS(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios";
}

// W3: Activity push token이 발급되면(네이티브 이벤트) 서버에 등록 →
// warmup cron이 그 토큰으로 백그라운드 갱신 푸시를 보낸다. 리스너는 1회만 설치.
let tokenListenerReady = false;

async function registerLiveActivityToken(gameId: string, token: string): Promise<void> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const accessToken = session?.access_token;
    if (!accessToken) return;
    await fetch("/api/live-activity/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ gameId, pushToken: token }),
    });
  } catch {
    /* silent — 등록 실패가 앱에 영향 주지 않게 */
  }
}

function ensureTokenListener(): void {
  if (tokenListenerReady || !isNativeIOS()) return;
  tokenListenerReady = true;
  void LiveActivity.addListener("liveActivityPushToken", ({ gameId, token }) => {
    void registerLiveActivityToken(gameId, token);
  });
}

/** 경기룸 진입 시 호출. 같은 gameId 재호출은 네이티브에서 update로 처리(중복 방지). */
export async function startLiveActivity(data: LiveActivityStartData): Promise<boolean> {
  if (!isNativeIOS()) return false;
  ensureTokenListener();
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
