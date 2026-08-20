import { registerPlugin, Capacitor } from "@capacitor/core";
import { isIosNativeRuntime } from "@/lib/capacitor/platform";
import { supabase } from "@/lib/supabase/client";
import { getMyTeamId } from "@/lib/store/myteam";
import { parseGameIdCodes, pickMyTeamStartableGame } from "@/lib/notifications/la-autostart-policy";
import { createSignatureCache, createSingleFlight, shouldCacheRegisterResponse } from "@/lib/client-dedupe";

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
  // scheduled = 경기 시작 30분 전 예정 카드(인앱 autostart 복구 경로, 삼순 blocker② 보완①).
  // 네이티브 parseState가 build12+부터 .scheduled를 파싱하므로 재아카이브 불필요.
  status: "live" | "final" | "scheduled";
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
  /** 예정 카드 시작 시각 "HH:MM" (scheduled 전용, 네이티브 startTime). */
  startTime?: string;
  /** 예고 선발(원정/홈) — scheduled 전용. */
  awayStarter?: string;
  homeStarter?: string;
}

interface LiveActivityPlugin {
  start(data: LiveActivityStartData): Promise<{ started: boolean }>;
  update(state: LiveActivityState): Promise<void>;
  end(state?: LiveActivityState): Promise<void>;
  isEnabled(): Promise<{ enabled: boolean }>;
  writeWidgetSnapshot(input: WidgetSnapshotInput): Promise<void>;
  setFavPlayers(opts: { json: string }): Promise<void>;
  setMyTeam(opts: { code: string }): Promise<void>;
  getWidgetTapMode(): Promise<{ mode: string; refreshSupported: boolean }>;
  setWidgetTapMode(opts: { mode: "open" | "refresh" }): Promise<void>;
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

// ── register-start dedupe 캐시 ──────────────────────────────────────────────
// push-to-start 토큰은 디바이스 단위라 매 부팅 같은 값이 재보고되고, 발사되는
// register-start가 Edge Request/Fluid CPU 상위 축이다(observability 실측 240K/2h).
// 동일 signature(유저·토큰·빌드·os·frequentPushes)를 TTL 내 "서버가 실제 저장"한
// 적 있으면 skip. 서버가 W3c 토글 off로 skip한 응답({skipped})은 캐시하지 않아
// 토글 on 복귀 후 다음 토큰 이벤트에서 정상 저장된다(기존 의미론 보존).
const startRegCache = createSignatureCache("kbo-la-start-reg-v1", 24 * 60 * 60 * 1000); // 24h
const startRegFlight = createSingleFlight<void>(); // 동일 signature 동시 호출 합치기

async function registerPushToStartToken(token: string): Promise<void> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const accessToken = session?.access_token;
    const userId = session?.user?.id;
    if (!accessToken || !userId) return; // 비로그인 → 등록 불가(로그인 후 재부팅 시 재시도)
    // appBuild/osMajor(빌드 16+) — 서버 p2s input-push-channel 게이트 판정(os>=18 && build>=16,
    // 미보고 null = 레거시 payload, 스펙 v4 blocker③). frequentPushes는 진단용 보고.
    const appBuild = await getAppBuild();
    const { osMajor, frequentPushes } = lastPushToStartMeta;
    const sig = JSON.stringify({ u: userId, t: token, b: appBuild ?? null, o: osMajor ?? null, f: frequentPushes ?? null });
    if (startRegCache.has(sig)) return;
    await startRegFlight.run(sig, async () => {
      if (startRegCache.has(sig)) return; // flight 대기 중 선행 성공 반영
      const res = await fetch("/api/live-activity/register-start", {
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
      // 서버가 저장을 skip한 경우({success, skipped:"live_activity_off"})는 캐시 금지 —
      // 토글 on 복귀 후에도 skip이 이어져 토큰 미저장 상태가 고정되는 것을 막는다.
      const body: unknown = res.ok ? await res.json().catch(() => null) : null;
      if (shouldCacheRegisterResponse(res.ok, body)) startRegCache.put(sig);
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

// 원격 로드 dual-instance 우회 — registerPlugin(정적 core) 호출 실패 시 주입 브릿지
// (window.Capacitor.Plugins.LiveActivity) 직접 호출로 대체(getAppBuild App 플러그인 패턴 미러).
interface InjectedTapModePlugin {
  getWidgetTapMode?: () => Promise<{ mode?: string; refreshSupported?: boolean; reason?: string }>;
  setWidgetTapMode?: (opts: { mode: "open" | "refresh" }) => Promise<void>;
}

/** 위젯 탭 '새로고침만' 미지원 사유 — none(지원) | ios_version(iOS<17) | app_update(구빌드 메서드 부재).
 *  카드가 사유별로 다른 안내 문구를 노출한다(삼순 #904 왕복2 ②: 안드 구빌드에 iOS 문구 오노출 방지). */
export type WidgetTapModeReason = "none" | "ios_version" | "app_update";
function injectedLiveActivity(): InjectedTapModePlugin | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as {
    Capacitor?: { Plugins?: { LiveActivity?: InjectedTapModePlugin } };
  }).Capacitor?.Plugins?.LiveActivity;
}

/** iOS 홈 위젯 탭 동작 모드 조회 — mode('open'|'refresh', 기본 open) + refreshSupported(위젯
 *  새로고침 인텐트 = iOS 17+). 비iOS/구빌드(메서드 부재)는 open + refreshSupported false.
 *  게이트는 정적 isNativeIOS 대신 isIosNativeRuntime() — 원격 로드 앱 web 오판 방지(삼순 #833). */
export async function getIosWidgetTapMode(): Promise<{ mode: "open" | "refresh"; refreshSupported: boolean; reason: WidgetTapModeReason }> {
  if (!isIosNativeRuntime()) return { mode: "open", refreshSupported: false, reason: "none" };
  // 성공 응답: iOS는 OS 버전 게이트라 미지원 사유 = ios_version(응답 reason 우선).
  const fromSuccess = (r?: { mode?: string; refreshSupported?: boolean; reason?: string }) => {
    const refreshSupported = r?.refreshSupported === true;
    // iOS 미지원은 오직 OS 버전(iOS<17) 사유 — 성공 응답이면 항상 ios_version.
    const reason: WidgetTapModeReason = refreshSupported ? "none" : "ios_version";
    return { mode: (r?.mode === "refresh" ? "refresh" : "open") as "open" | "refresh", refreshSupported, reason };
  };
  try {
    return fromSuccess(await LiveActivity.getWidgetTapMode());
  } catch {
    // dual-instance 우회: 주입 브릿지 직접 호출
    const inj = injectedLiveActivity();
    if (inj?.getWidgetTapMode) {
      try {
        return fromSuccess(await inj.getWidgetTapMode());
      } catch {
        /* fall through → fail-closed */
      }
    }
    // 메서드 부재 = 구 iOS 빌드 → 앱 업데이트 안내(iOS 버전 문제 아님, 삼순 ②)
    return { mode: "open", refreshSupported: false, reason: "app_update" };
  }
}

/** iOS 홈 위젯 탭 동작 모드 저장(App Group widget_tap_mode). 성공 여부 반환(저장 실패 시
 *  카드 롤백용, 삼순 ④). 구빌드/브릿지 실패는 주입 브릿지 폴백 후 false. */
export async function setIosWidgetTapMode(mode: "open" | "refresh"): Promise<boolean> {
  if (!isIosNativeRuntime()) return false;
  try {
    await LiveActivity.setWidgetTapMode({ mode });
    return true;
  } catch {
    const inj = injectedLiveActivity();
    if (inj?.setWidgetTapMode) {
      try {
        await inj.setWidgetTapMode({ mode });
        return true;
      } catch {
        /* fall through */
      }
    }
    return false; // 구빌드/브릿지 실패 → 카드 롤백
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

// ── 재설치/첫 실행 인앱 자동 시작 (삼순 1.0.9(16) 5조건 재판정 blocker②) ──
// #667 서버 감지는 p2s 토큰 *값이 바뀐* 재설치만 커버한다. iOS가 재설치에도 동일 토큰을
// 재발급하면 기존 claim/구독이 p2s 재발송을 계속 차단 → 카드가 영영 안 뜬다(서버 단독
// 구분 불가, #667 명기 한계). 해결 = 첫 실행/로그인/최애팀 설정/포그라운드 복귀 시점에
// 현재 *라이브 중인 최애팀 경기*를 인앱 start로 직접 보장 — p2s claim 상태와 무관하게
// 카드가 뜬다. 네이티브 start()가 같은 gameId는 update로 dedupe(중복 카드 없음), build16+
// && iOS18+ && active 채널이면 `.channel` 구독 시작, 그 외 `.token` 폴백(기존 체인 재사용).
// 원격 로드 웹 번들이라 배포 즉시 기존 설치 빌드 전체 적용(재아카이브 불필요).

/** /api/game-live 응답의 필요 필드만 (useLiveGame LiveGameData 부분집합). */
interface AutoStartGame {
  gameId: string;
  awayName: string;
  homeName: string;
  awayScore: number;
  homeScore: number;
  inning: number;
  isTop: boolean;
  balls: number;
  strikes: number;
  outs: number;
  runner1b: boolean;
  runner2b: boolean;
  runner3b: boolean;
  currentPitcher: string | null;
  currentBatter: string | null;
  stadium: string;
  isLive: boolean;
  status: string; // "scheduled" | "live" | "final" | "cancelled"
  time: string;   // "HH:MM" 시작 시각
  awayStarterName: string | null;
  homeStarterName: string | null;
}
// 선택/파싱은 순수 판정 모듈(la-autostart-policy.ts)에서 — qa:la-autostart 스모크 대상.

let autoStartInFlight = false;
let autoStartLastAttemptMs = 0;
/** 성공한 `${myTeamCode}|${gameId}` — 같은 세션 내 재시작 fetch 생략(네이티브 dedupe의 앞단 절약). */
let autoStartDoneKey: string | null = null;

/** 인앱 자동/수동 start 결과 — UI 안내 분리용(삼순 #680 blocker②).
 *  started = start 성공 또는 이미 같은 대상 성공(dedupe) / none = 대상 경기 없음(최애팀
 *  미설정 포함) / failed = fetch·start 실패·토글 off·ActivityKit 비활성 / skipped = 비네이티브·
 *  in-flight·스로틀(재시도 안내 대상). */
export type AutoStartOutcome = "started" | "none" | "failed" | "skipped";

/**
 * 라이브(또는 시작 30분 이내 예정) 최애팀 경기가 있으면 인앱 Live Activity를 시작한다.
 * 부팅/SIGNED_IN/최애팀 설정(team-changed)/포그라운드 복귀/재노출 버튼에서 호출.
 * - `bypassThrottle=true`(team-changed·manual-retrigger): 60초 스로틀 무시 — 부팅/포그라운드
 *   선행 시도 실패가 명시 요청 직후 start를 막으면 안 된다(삼순 blocker② 보완②).
 *   in-flight 동시 중복 가드는 유지.
 * - live면 실데이터 프레임, scheduled면 예정 카드(시작 시각·선발) 프레임으로 start.
 * - 기존 호출부(부팅/포그라운드 등)는 반환값을 소비하지 않음 — outcome은 재노출 UI 전용.
 */
export async function autoStartMyTeamLiveActivity(
  reason: string,
  bypassThrottle = false,
): Promise<AutoStartOutcome> {
  if (!isNativeIOS()) return "skipped";
  const now = Date.now();
  if (autoStartInFlight) return "skipped";
  if (!bypassThrottle && now - autoStartLastAttemptMs < 60_000) return "skipped";
  const myTeamId = getMyTeamId();
  const myTeamCode = myTeamId ? ID_TO_KBO_CODE[myTeamId] ?? "" : "";
  if (!myTeamCode) return "none";
  autoStartInFlight = true;
  autoStartLastAttemptMs = now;
  try {
    const res = await fetch("/api/game-live");
    if (!res.ok) return "failed";
    const data = (await res.json()) as { games?: AutoStartGame[] };
    const picked = pickMyTeamStartableGame(data.games ?? [], myTeamCode, now);
    if (!picked) return "none";
    const { game: g, kind } = picked;
    const key = `${myTeamCode}|${g.gameId}|${kind}`;
    if (autoStartDoneKey === key) return "started";
    const codes = parseGameIdCodes(g.gameId)!; // pick이 파싱 성공만 반환
    const started = await startLiveActivity(
      kind === "live"
        ? {
            gameId: g.gameId,
            awayTeam: g.awayName,
            homeTeam: g.homeName,
            awayTeamCode: codes.away,
            homeTeamCode: codes.home,
            myTeamCode,
            awayScore: g.awayScore,
            homeScore: g.homeScore,
            inning: g.inning,
            isTopInning: g.isTop,
            balls: g.balls,
            strikes: g.strikes,
            outs: g.outs,
            onFirst: g.runner1b,
            onSecond: g.runner2b,
            onThird: g.runner3b,
            pitcherName: g.currentPitcher ?? "",
            batterName: g.currentBatter ?? "",
            stadium: g.stadium ?? "",
            status: "live",
            // 최근 플레이는 다음 서버 update/경기룸 진입 때 채워짐 — 시작 프레임은 생략.
            lastPlay: "",
          }
        : {
            // scheduled 예정 카드 — 서버 p2s 30분 전 프레임과 대칭(시작 시각·선발 표시).
            gameId: g.gameId,
            awayTeam: g.awayName,
            homeTeam: g.homeName,
            awayTeamCode: codes.away,
            homeTeamCode: codes.home,
            myTeamCode,
            awayScore: 0,
            homeScore: 0,
            inning: 1,
            isTopInning: true,
            balls: 0,
            strikes: 0,
            outs: 0,
            onFirst: false,
            onSecond: false,
            onThird: false,
            pitcherName: "",
            batterName: "",
            stadium: g.stadium ?? "",
            status: "scheduled",
            startTime: g.time,
            awayStarter: g.awayStarterName ?? "",
            homeStarter: g.homeStarterName ?? "",
          },
    );
    if (started) {
      autoStartDoneKey = key;
      console.log(`[live-activity] auto-start ok (${reason}, ${kind}) game=${g.gameId}`);
      return "started";
    }
    // startLiveActivity false = 토글 off/ActivityKit 비활성/네이티브 start 실패 — 재시도 안내 대상.
    return "failed";
  } catch (e) {
    console.warn("[live-activity] auto-start failed", e);
    return "failed";
  } finally {
    autoStartInFlight = false;
  }
}

/**
 * 마이페이지 "잠금화면 카드 다시 표시" 수동 트리거 (건의함 feedback:4369ee5a).
 * autostart와 달리 스로틀/세션 done-key를 건너뛴다(명시 요청이라 항상 재시도 — 유저가
 * 카드를 지운 뒤 done-key가 남아 skip되면 버튼이 무의미). outcome을 그대로 반환해
 * UI가 성공/대상없음/실패를 구분 안내한다(삼순 blocker②). 네이티브 start는 살아있는
 * 같은 gameId 카드를 update로 dedupe하므로 중복 카드 없음.
 */
export async function retriggerMyTeamLiveActivity(): Promise<AutoStartOutcome> {
  if (!isNativeIOS()) return "skipped";
  autoStartDoneKey = null; // 명시 재표시 요청 — 세션 dedupe 리셋
  return autoStartMyTeamLiveActivity("manual-retrigger", true);
}
