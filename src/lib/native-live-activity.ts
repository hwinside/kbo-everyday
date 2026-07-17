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
  /** 문자중계 최근 플레이 한 줄(1.0.7+, 옵셔널) — 잠금 카드/홈위젯 large 렌더. */
  lastPlay?: string;
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
  setFavPlayers(opts: { json: string }): Promise<void>;
  setMyTeam(opts: { code: string }): Promise<void>;
  addListener(
    eventName: "liveActivityPushToken",
    listenerFunc: (data: { gameId: string; token: string }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
  addListener(
    eventName: "liveActivityPushToStartToken",
    listenerFunc: (data: {
      token: string;
      /** OS 메이저 버전(빌드 16+) — 서버 p2s input-push-channel 게이트 판정용(스펙 v4). */
      osMajor?: number;
      /** ActivityKit frequentPushesEnabled(진단용, 행동 무변화). */
      frequentPushes?: boolean;
    }) => void,
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
  /** 예정 경기 날짜 라벨(예: "6월 7일 (토)"). 구장 위에 표시. scheduled에서만. */
  dateText?: string;
  /** 예고선발 투수명(원정/홈). scheduled에서만. 미확정이면 빈 문자열("선발 미정" 폴백). */
  awayStarter?: string;
  homeStarter?: string;
  /** 문자중계 최근 플레이 한 줄(1.0.7+, 옵셔널) — live에서만. 홈위젯 large 카드 렌더. */
  lastPlay?: string;
  /** 다음 예정 경기 — live/final 스냅샷일 때만. 위젯이 '경기일 다음날 06:00'에 앱 실행 없이
   *  이 경기로 자동 전환한다(홈 팀카드 06시 규칙). 예정 카드 렌더에 필요한 필드만. */
  next?: WidgetNextGame;
}

/** 다음 예정 경기(라이트) — 위젯 06:00 롤오버 타깃. */
export interface WidgetNextGame {
  gameId: string;
  awayTeamCode: string;
  homeTeamCode: string;
  myTeamCode: string;
  stadium: string;
  startText: string;
  dateText: string;
  awayStarter?: string;
  homeStarter?: string;
}

/** teamId(1-10) → KBO 2자 코드 (gameId·공식 코드 기준). */
export const ID_TO_KBO_CODE: Record<number, string> = {
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
  /** "6월 7일 (토)" 형태 날짜 라벨(예정 경기, 구장 위 표시). */
  dateText?: string;
  /** 예고선발 투수명(원정/홈). 예정 경기에서만 사용. 미확정이면 null → "선발 미정". */
  awayStarter?: string | null;
  homeStarter?: string | null;
  /** 문자중계 최근 플레이 한 줄(1.0.7+, 옵셔널) — live에서만. */
  lastPlay?: string | null;
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

// 앱 빌드 번호(CFBundleVersion) — 서버가 빌드별 LA payload(풀/슬림)를 분기하는 태그.
// 원격 로드 앱이라 npm core 판정이 아닌 window.Capacitor 주입 브릿지의 App 플러그인을
// 우선 사용(레퍼런스: capacitor_remote_load_isnative_false). 실패 시 null(=서버 슬림 폴백).
let appBuildCache: number | null | undefined;
async function getAppBuild(): Promise<number | null> {
  if (appBuildCache !== undefined) return appBuildCache;
  try {
    type AppInfoPlugin = { getInfo: () => Promise<{ build?: string }> };
    const w = window as unknown as {
      Capacitor?: { Plugins?: { App?: AppInfoPlugin } };
    };
    const appPlugin = w.Capacitor?.Plugins?.App;
    const info = await appPlugin?.getInfo();
    const n = info?.build ? parseInt(info.build, 10) : NaN;
    appBuildCache = Number.isFinite(n) ? n : null;
  } catch {
    appBuildCache = null;
  }
  return appBuildCache;
}

async function registerLiveActivityToken(gameId: string, token: string): Promise<void> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const accessToken = session?.access_token;
    if (!accessToken) return;
    const appBuild = await getAppBuild();
    await fetch("/api/live-activity/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ gameId, pushToken: token, ...(appBuild != null ? { appBuild } : {}) }),
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

// W3b: push-to-start 토큰(디바이스 단위, iOS 17.2+)을 서버에 등록 → 최애팀 경기 시작 시
// 앱 미실행 자동 카드. 리스너는 앱 부팅 시 1회 설치(경기룸 진입 무관).
let startTokenListenerReady = false;
// 마지막으로 발급받은 push-to-start 토큰 — 비로그인 부팅 후 로그인(SIGNED_IN) 시 재등록용.
let lastPushToStartToken: string | null = null;
// 네이티브가 토큰과 함께 보고한 메타(osMajor/frequentPushes, 빌드 16+) — 재등록에도 동봉.
let lastPushToStartMeta: { osMajor?: number; frequentPushes?: boolean } = {};

async function registerPushToStartToken(token: string): Promise<void> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const accessToken = session?.access_token;
    if (!accessToken) return; // 비로그인 → 등록 불가(로그인 후 재부팅 시 재시도)
    // appBuild/osMajor(빌드 16+) — 서버 p2s input-push-channel 게이트 판정(os>=18 && build>=16,
    // 미보고 null = 레거시 payload, 스펙 v4 blocker③). frequentPushes는 진단용 보고.
    const appBuild = await getAppBuild();
    const { osMajor, frequentPushes } = lastPushToStartMeta;
    await fetch("/api/live-activity/register-start", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        pushToStartToken: token,
        ...(appBuild != null ? { appBuild } : {}),
        ...(Number.isInteger(osMajor) ? { osMajor } : {}),
        ...(typeof frequentPushes === "boolean" ? { frequentPushes } : {}),
      }),
    });
  } catch {
    /* silent — 등록 실패가 앱에 영향 주지 않게 */
  }
}

/** 앱 부팅 시 1회 — push-to-start 토큰 리스너 설치(W3b). native가 retainUntilConsumed로
 *  버퍼링하므로 listener가 늦게 붙어도 토큰 유실 없음. W3c 토글 off 유저는 서버
 *  register-start 엔드포인트가 저장을 skip(클라/서버 이중 게이트). iOS 외엔 no-op. */
export async function bootstrapLiveActivityPushToStart(): Promise<void> {
  if (startTokenListenerReady || !isNativeIOS()) return;
  startTokenListenerReady = true;
  await LiveActivity.addListener("liveActivityPushToStartToken", ({ token, osMajor, frequentPushes }) => {
    lastPushToStartToken = token;
    lastPushToStartMeta = { osMajor, frequentPushes };
    void registerPushToStartToken(token);
  });
}

/** 로그인 직후(SIGNED_IN) 호출 — 비로그인 부팅 때 등록 skip된 push-to-start 토큰을 재등록.
 *  토큰은 디바이스 단위라 재발급 없이 마지막 값으로 등록 가능. iOS 외/토큰 없으면 no-op. */
export function reregisterPushToStartToken(): void {
  if (!isNativeIOS() || !lastPushToStartToken) return;
  void registerPushToStartToken(lastPushToStartToken);
}

// 풀 카드 최소 빌드 — 서버(live-activity.ts FULL_CARD_MIN_BUILD)와 동일 게이트.
// 웹은 원격 로드라 이 코드가 1.0.6 이하 기기에서도 실행된다 → 포그라운드 start/update
// 경로도 구빌드에선 투수/타자·lastPlay를 비워 보낸다(풀 라이브 프레임 렌더가 스피너 유발,
// 2026-07-07 인시던트). 빌드 확인 실패(null)도 슬림으로 안전 폴백.
const FULL_CARD_MIN_BUILD = 11;

async function slimForOldBuilds<T extends LiveActivityState>(state: T): Promise<T> {
  const build = await getAppBuild();
  if (build != null && build >= FULL_CARD_MIN_BUILD) return state;
  return { ...state, pitcherName: "", batterName: "", lastPlay: "" };
}

/** 경기룸 진입 시 호출. 같은 gameId 재호출은 네이티브에서 update로 처리(중복 방지). */
export async function startLiveActivity(data: LiveActivityStartData): Promise<boolean> {
  if (!isNativeIOS()) return false;
  // W3c: "잠금화면 실시간 중계" off면 카드를 아예 시작하지 않는다(토큰도 발급 안 됨).
  if (!(await isLiveActivityEnabled())) return false;
  await ensureTokenListener();
  try {
    const res = await LiveActivity.start(await slimForOldBuilds(data));
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
    await LiveActivity.update(await slimForOldBuilds(state));
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

/** 최애선수 목록을 iOS 위젯 App Group(fav_players)에 동기화 — 선수 카드 위젯 선택 목록용.
 *  안드는 GameNotification.setFavPlayers를 쓰므로, 이 경로는 iOS 네이티브 전용(그 외 no-op). */
export async function syncIosWidgetFavPlayers(players: unknown[]): Promise<void> {
  if (!isNativeIOS()) return;
  try {
    await LiveActivity.setFavPlayers({ json: JSON.stringify(players ?? []) });
  } catch {
    /* silent — 부가 기능 */
  }
}

/** 최애팀 코드를 iOS 위젯 App Group(my_team)에 직접 동기화 — 팀순위 위젯 하이라이트용.
 *  스냅샷(myTeamCode)은 경기/다음경기 흐름에서만 갱신되어 오프데이·팀변경 직후 stale일 수
 *  있어, 최애팀 변경 시점에 곧장 기록하는 별도 경로. 안드는 GameNotification.setMyTeam 사용. */
export async function syncIosWidgetMyTeam(code: string): Promise<void> {
  if (!isNativeIOS() || !code) return;
  try {
    await LiveActivity.setMyTeam({ code });
  } catch {
    /* silent — 부가 기능 */
  }
}

/** 홈 화면이 가진 최애팀 경기를 홈 위젯에 기록.
 *  라이브 경기가 없을 때 *최애팀 다음 예정 경기*가 위젯에 뜨게 하는 핵심 fallback 경로
 *  (안드로이드/앱 홈 MY TEAM 카드와 동일 컨셉). live/final도 그대로 표현. */
export async function writeHomeWidgetSnapshot(
  myTeamId: number | null,
  game: HomeWidgetGame,
  nextGame?: HomeWidgetGame | null,
): Promise<void> {
  if (!isNativeIOS()) return;
  const inningNum = game.inning ? parseInt(game.inning, 10) || 1 : 1;
  const myTeamCode = myTeamId ? ID_TO_KBO_CODE[myTeamId] ?? "" : "";
  // 다음 예정 경기(nextGame)가 주어지면 상태 무관(예정 포함) 함께 실어 위젯 06:00 자동 전환을
  // 준비한다. 예정 스냅샷이 백그라운드서 종료로 바뀌어도 WidgetSnapshotStore가 same-gameId
  // next를 보존하므로 롤오버 타깃이 유지된다(삼순 ①).
  const next: WidgetNextGame | undefined =
    nextGame
      ? {
          gameId: nextGame.gameId,
          awayTeamCode: ID_TO_KBO_CODE[nextGame.awayTeamId] ?? "",
          homeTeamCode: ID_TO_KBO_CODE[nextGame.homeTeamId] ?? "",
          myTeamCode,
          stadium: nextGame.stadium,
          startText: nextGame.time,
          dateText: nextGame.dateText ?? "",
          awayStarter: nextGame.awayStarter ?? "",
          homeStarter: nextGame.homeStarter ?? "",
        }
      : undefined;
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
    dateText: game.status === "scheduled" ? (game.dateText ?? "") : "",
    awayStarter: game.status === "scheduled" ? (game.awayStarter ?? "") : "",
    lastPlay: game.status === "live" ? (game.lastPlay ?? "") : "",
    homeStarter: game.status === "scheduled" ? (game.homeStarter ?? "") : "",
    next,
  });
}
