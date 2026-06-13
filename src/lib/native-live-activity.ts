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
  writeWidgetSnapshot(input: WidgetSnapshotInput): Promise<void>;
  addListener(
    eventName: "liveActivityPushToken",
    listenerFunc: (data: { gameId: string; token: string }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
}

/** 홈 화면 위젯(KBOHomeWidget) App Group 스냅샷. 라이브/예정/종료 모두 표현 가능.
 *  라이브 경기가 없을 때 홈 화면이 최애팀 다음 경기(scheduled)를 기록하는 fallback 경로. */
export interface WidgetSnapshotInput {
  gameId: string;
  awayTeamCode: string;
  homeTeamCode: string;
  myTeamCode: string;
  status: "live" | "final" | "scheduled" | "cancelled";
  awayScore?: number;
  homeScore?: number;
  inning?: number;
  isTopInning?: boolean;
  outs?: number;
  onFirst?: boolean;
  onSecond?: boolean;
  onThird?: boolean;
  pitcherName?: string;
  batterName?: string;
  stadium?: string;
  /** 예정 경기 표시용 시각(예: "18:30"). live/final이면 생략. */
  startText?: string;
}

/** teamId(1-10) → KBO 2자 코드 (gameId·공식 코드 기준). */
const ID_TO_KBO_CODE: Record<number, string> = {
  1: "LG", 2: "OB", 3: "KT", 4: "SK", 5: "NC",
  6: "HT", 7: "LT", 8: "SS", 9: "HH", 10: "WO",
};

/** 홈 화면이 가진 최애팀 경기(HomeGame 형태) → 홈 위젯 스냅샷 기록용 입력. */
export interface HomeWidgetGame {
  gameId: string;
  awayTeamId: number;
  homeTeamId: number;
  status: "live" | "final" | "scheduled" | "cancelled";
  awayScore: number;
  homeScore: number;
  /** "7회초" 형태(라이브) 또는 null. */
  inning: string | null;
  isTop: boolean;
  outs: number;
  runner1b: boolean;
  runner2b: boolean;
  runner3b: boolean;
  currentPitcher: string | null;
  currentBatter: string | null;
  stadium: string;
  /** "18:30" 형태 시작 시각(예정 경기 표시용). */
  time: string;
}

const LiveActivity = registerPlugin<LiveActivityPlugin>("LiveActivity");

function isNativeIOS(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios";
}

// W3c 토글("잠금화면 실시간 중계") 클라 게이트. 서버 prefs를 세션당 1회 fetch해 캐시한다.
// off면 startLiveActivity/updateLiveActivity를 아예 호출하지 않아 잠금화면 카드가 뜨지 않는다.
// (서버 push 제외 + register skip은 백스톱.) 마이페이지 토글이 setLiveActivityEnabledCache로
// 즉시 캐시를 갱신한다.
let liveActivityPrefCache: boolean | null = null;

async function isLiveActivityEnabled(): Promise<boolean> {
  if (liveActivityPrefCache !== null) return liveActivityPrefCache;
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    if (!token) {
      liveActivityPrefCache = true; // 비로그인 → 기본 on (토큰 등록 자체가 로그인 필요라 무해)
      return true;
    }
    const res = await fetch("/api/push/prefs", { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) {
      const { prefs } = await res.json();
      liveActivityPrefCache = prefs?.live_activity !== false; // 디폴트 on
    } else {
      liveActivityPrefCache = true;
    }
  } catch {
    liveActivityPrefCache = true;
  }
  return liveActivityPrefCache;
}

/** 마이페이지 토글이 즉시 클라 캐시를 갱신 → 다음 start/update 게이트에 반영. */
export function setLiveActivityEnabledCache(enabled: boolean): void {
  liveActivityPrefCache = enabled;
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

async function ensureTokenListener(): Promise<void> {
  if (tokenListenerReady || !isNativeIOS()) return;
  tokenListenerReady = true;
  // start() 호출 전에 listener 설치를 await → ActivityKit push token이 빨리 나와도
  // 이벤트를 받을 준비가 된 뒤 start 하도록(삼순 W3a NO-GO). native는 retainUntilConsumed로 이중 방어.
  await LiveActivity.addListener("liveActivityPushToken", ({ gameId, token }) => {
    void registerLiveActivityToken(gameId, token);
  });
}

/** 경기룸 진입 시 호출. 같은 gameId 재호출은 네이티브에서 update로 처리(중복 방지). */
export async function startLiveActivity(data: LiveActivityStartData): Promise<boolean> {
  if (!isNativeIOS()) return false;
  // W3c: "잠금화면 실시간 중계" off면 카드를 아예 시작하지 않는다(토큰도 발급 안 됨).
  if (!(await isLiveActivityEnabled())) return false;
  await ensureTokenListener();
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
  // W3c: 토글 off면 갱신도 건너뛴다(캐시 기준 — start가 이미 fetch/세팅, 토글이 즉시 갱신).
  if (liveActivityPrefCache === false) return;
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

/** 홈 화면 위젯 스냅샷 직접 기록(저수준). iOS 네이티브 외엔 no-op. */
export async function writeWidgetSnapshot(input: WidgetSnapshotInput): Promise<void> {
  if (!isNativeIOS()) return;
  try {
    await LiveActivity.writeWidgetSnapshot(input);
  } catch {
    /* silent — 위젯 갱신 실패가 앱에 영향 주지 않게 */
  }
}

/** 홈 화면이 가진 최애팀 경기를 홈 위젯에 기록.
 *  라이브 경기가 없을 때 *최애팀 다음 예정 경기*가 위젯에 뜨게 하는 핵심 fallback 경로
 *  (안드로이드/앱 홈 MY TEAM 카드와 동일 컨셉). live/final도 그대로 표현. */
export async function writeHomeWidgetSnapshot(
  myTeamId: number | null,
  game: HomeWidgetGame,
): Promise<void> {
  if (!isNativeIOS()) return;
  const inningNum = game.inning ? parseInt(game.inning, 10) || 1 : 1;
  await writeWidgetSnapshot({
    gameId: game.gameId,
    awayTeamCode: ID_TO_KBO_CODE[game.awayTeamId] ?? "",
    homeTeamCode: ID_TO_KBO_CODE[game.homeTeamId] ?? "",
    myTeamCode: myTeamId ? ID_TO_KBO_CODE[myTeamId] ?? "" : "",
    status: game.status,
    awayScore: game.awayScore,
    homeScore: game.homeScore,
    inning: inningNum,
    isTopInning: game.isTop,
    outs: game.outs,
    onFirst: game.runner1b,
    onSecond: game.runner2b,
    onThird: game.runner3b,
    pitcherName: game.currentPitcher ?? "",
    batterName: game.currentBatter ?? "",
    stadium: game.stadium,
    startText: game.status === "scheduled" ? game.time : "",
  });
}
