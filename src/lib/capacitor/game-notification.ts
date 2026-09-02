"use client";

import { registerPlugin } from "@capacitor/core";
import { isAndroid, isIOS, isNativeRuntime, isIosNativeRuntime } from "./platform";
import {
  syncIosWidgetFavPlayers,
  syncIosWidgetMyTeam,
  getIosWidgetTapMode,
  setIosWidgetTapMode,
  type WidgetTapModeReason,
} from "../native-live-activity";
import { supabase } from "../supabase/client";
import { awaitBootPrefs } from "@/lib/boot-cache";
import {
  createLockCardGateFence,
  advanceLockCardGateFence,
  captureLockCardGateFence,
  shouldApplyLockCardLoad,
} from "./lock-card-gate-fence";

// 잠금화면 실시간 스코어 = ongoing notification (안드로이드 전용, A4).
// 네이티브 GameNotificationPlugin(@CapacitorPlugin name="GameNotification")과 페어.
// iOS는 Live Activity(별도)라 여기선 android만 동작.
interface WidgetData {
  myTeam: string;
  away: string;
  home: string;
  awayScore: string;
  homeScore: string;
  status: string;
  pitcher: string;
  pitcherTeam: string;
  batter: string;
  batterTeam: string;
  outs: string;
  diamond: string;
  stadium?: string; // 경기장(잠실 등) — 위젯에서 점수 위 별도 표시
  awayStarter?: string; // 예고선발(원정) — 예정 경기에서만. 미확정이면 빈 문자열
  homeStarter?: string; // 예고선발(홈)
  gameId?: string; // 경기 id(YYYYMMDD…) — 위젯 06:00 롤오버 기준일
  next?: WidgetNextGame; // 다음 예정 경기 — live/final일 때만. 06:00 자동 전환 타깃
}

/** 안드 위젯 06:00 롤오버 타깃(다음 예정 경기, 라이트). */
export interface WidgetNextGame {
  away: string;
  home: string;
  stadium: string;
  time: string;
  date: string;
  astarter?: string;
  hstarter?: string;
}

interface GameNotificationPlugin {
  start(opts: { title: string; body: string; path?: string }): Promise<void>;
  update(opts: { title: string; body: string }): Promise<void>;
  remove(): Promise<void>;
  updateWidget(opts: WidgetData): Promise<void>;
  clearWidget(): Promise<void>;
  setMyTeam(opts: { code: string }): Promise<void>;
  setFavPlayers(opts: { json: string }): Promise<void>;
  getLiveUpdateState(): Promise<LiveUpdateState>;
  setLiveUpdateOptIn(opts: { enabled: boolean }): Promise<void>;
  setLockCardEnabled(opts: { enabled: boolean }): Promise<void>;
  getLockCardGateState(): Promise<{ enabled: boolean }>;
  getWidgetTapMode(): Promise<{ mode: WidgetTapMode; refreshSupported?: boolean }>;
  setWidgetTapMode(opts: { mode: WidgetTapMode }): Promise<void>;
}

/** 홈 위젯 탭 동작 — 'open'(탭 시 앱 실행, 기본) | 'refresh'(앱 안 열고 위젯만 재렌더). */
export type WidgetTapMode = "open" | "refresh";

/** 홈 위젯 탭 동작 상태. refreshSupported = '새로고침만' 옵션이 실제 동작하는지
 *  (안드는 항상 true, iOS는 위젯 새로고침 인텐트가 iOS 17+ 전용이라 iOS17+에서만 true).
 *  reason = 미지원 사유(카드 안내 문구 분기용) — none | ios_version(iOS<17) | app_update(구빌드). */
export type { WidgetTapModeReason };
export interface WidgetTapModeState {
  mode: WidgetTapMode;
  refreshSupported: boolean;
  reason: WidgetTapModeReason;
}

/** Android 16+(One UI 8.5) 잠금화면 라이브 카드(Promoted Ongoing) 지원/opt-in 상태. */
export interface LiveUpdateState {
  supported: boolean;
  enabled: boolean;
}

const GameNotification = registerPlugin<GameNotificationPlugin>("GameNotification");

/** ongoing notification 시작 (경기 시작 시). 실패는 silent — 부가 기능.
 *  path = 카드 탭 시 열 경기룸 경로(옵셔널 — 네이티브 start가 path를 딥링크로 사용).
 *  반환 = 브릿지 호출 성공 여부(구빌드 메서드 부재/브릿지 실패 = false — 재노출 버튼 결과 안내용,
 *  PR #680 삼순 blocker②). 단 네이티브 post()가 권한 미허용(SecurityException)을 삼키므로
 *  true = "게시 확정"이 아니라 "요청 접수"로 해석할 것. */
export async function startGameNotification(title: string, body: string, path?: string): Promise<boolean> {
  if (!isAndroid) return false;
  try {
    await GameNotification.start({ title, body, ...(path ? { path } : {}) });
    return true;
  } catch {
    return false;
  }
}

/** ongoing notification 갱신 (득점/이닝 변경 시). */
export async function updateGameNotification(title: string, body: string): Promise<void> {
  if (!isAndroid) return;
  try {
    await GameNotification.update({ title, body });
  } catch {
    // silent
  }
}

/** ongoing notification 제거 (경기 종료 시). */
export async function removeGameNotification(): Promise<void> {
  if (!isAndroid) return;
  try {
    await GameNotification.remove();
  } catch {
    // silent
  }
}

/** 홈/잠금화면 위젯을 풀 라이브 데이터로 갱신 (경기룸 포그라운드). 주자/투수/타자 포함. */
export async function updateGameWidget(data: WidgetData): Promise<void> {
  if (!isAndroid) return;
  try {
    await GameNotification.updateWidget(data);
  } catch {
    // silent
  }
}

/** 위젯 빈 상태로 전환 (경기 종료). */
export async function clearGameWidget(): Promise<void> {
  if (!isAndroid) return;
  try {
    await GameNotification.clearWidget();
  } catch {
    // silent
  }
}

/** 디바이스 최애팀 코드 기록 (위젯 배경/워터마크 색 결정). */
export async function setWidgetMyTeam(code: string): Promise<void> {
  if (!code) return;
  if (isIOS) {
    // iOS는 GameNotification(안드 전용) 대신 LiveActivity 플러그인으로 App Group에 기록.
    await syncIosWidgetMyTeam(code);
    return;
  }
  if (!isAndroid) return;
  try {
    await GameNotification.setMyTeam({ code });
  } catch {
    // silent
  }
}

// 잠금카드 게이트 fence — load/bootstrap 결과가 명시 토글을 후승하지 못하게 막는
// 공유 generation(삼순 #686 재리뷰 blocker①). 모든 경로(토글·부팅·카드 로드)가 이 인스턴스를 공유.
const lockCardGateFence = createLockCardGateFence();

/** load/bootstrap GET 시작 전 호출 — 응답 적용 시 applyAndroidLockCardGateFromLoad에 전달. */
export function captureLockCardGateGeneration(): number {
  return captureLockCardGateFence(lockCardGateFence);
}

/** 잠금화면 카드 마스터 게이트(서버 prefs.live_activity의 디바이스 미러) 동기화 — *명시 토글 전용*.
 *  fence를 전진시켜 진행 중인 모든 load/bootstrap 결과를 무효화한다(iOS 캐시 보호 포함 —
 *  advance는 플랫폼 무관). off면 네이티브가 현재 카드를 즉시 제거하고 이후 FCM game_live
 *  수신 시에도 카드를 게시하지 않는다(홈위젯은 영향 없음 — game_live가 홈위젯과 잠금카드
 *  겸용이라 서버 발송은 유지). 구 네이티브 빌드(메서드 부재)는 조용히 무시 — vc14+부터 유효. */
export async function syncAndroidLockCardGate(enabled: boolean): Promise<void> {
  advanceLockCardGateFence(lockCardGateFence);
  if (!isAndroid) return;
  try {
    await GameNotification.setLockCardEnabled({ enabled });
  } catch {
    // silent — 구빌드/브릿지 실패(카드는 기존 동작 유지)
  }
}

/** load/bootstrap 결과 적용 — 칐처 이후 명시 토글이 있었으면 폐기(false 반환, 네이티브 미쓰기).
 *  적용되어도 fence는 전진하지 않는다(명시 토글만 전진). 반환값으로 소비자(UI/iOS 캐시)도
 *  동일 판정을 공유한다. */
export async function applyAndroidLockCardGateFromLoad(
  enabled: boolean,
  capturedGeneration: number,
): Promise<boolean> {
  if (!shouldApplyLockCardLoad(lockCardGateFence, capturedGeneration)) return false;
  if (!isAndroid) return true;
  try {
    await GameNotification.setLockCardEnabled({ enabled });
  } catch {
    // silent — 구빌드/브릿지 실패(카드는 기존 동작 유지)
  }
  return true;
}

/** 안드 네이티브 잠금카드 게이트 capability/상태 프로브 — 메서드 부재(vc13 이하)는
 *  supported:false. 마스터 토글 활성/업데이트 안내 판정용(삼순 #686 재리뷰 blocker②).
 *  조회 전용이라 부작용 없음. */
export interface AndroidLockCardGateState {
  supported: boolean;
  enabled: boolean;
}

export async function getAndroidLockCardGateState(): Promise<AndroidLockCardGateState> {
  if (!isAndroid) return { supported: false, enabled: true };
  try {
    const r = await GameNotification.getLockCardGateState();
    return { supported: true, enabled: r?.enabled !== false };
  } catch {
    return { supported: false, enabled: true }; // 메서드 부재 = 구빌드
  }
}

/** 부팅/로그인 시 서버 live_activity pref → 네이티브 잠금카드 게이트 동기화(안드 전용).
 *  다른 기기에서 꺼둔 유저/재설치(네이티브 디폴트 on) 복원용. 확정 응답일 때만 반영 —
 *  비로그인/네트워크 실패 시 기존 네이티브 값 유지(임의 on 덮어쓰기 금지).
 *  fence: GET 시작 전 칐처 → 그 사이 명시 토글이 있었으면 과거 값 폐기(삼순 blocker①). */
export async function bootstrapAndroidLockCardGate(): Promise<void> {
  if (!isAndroid) return;
  try {
    const gen = captureLockCardGateGeneration();
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    if (!token) return;
    // PR④: 부트 번들 로드를 기다렸다 소비(begin 유예→settle 대기 — NativePushMount 가
    // AuthProvider 보다 먼저 뜨는 race 흘수). 토글(PUT)은 setLiveActivityEnabledCache 경유로
    // 부트 캠시를 무효화하므로, 캠시 적중 = 캠시 이후 토글 없음 → gen fence 계약 유지(fence 는
    // await 전에 capture 되어 대기 중 토글도 폐기된다). 미스면 종전 fetch(fail-open).
    const bootUserId = session?.user?.id;
    const bootPrefs = bootUserId ? await awaitBootPrefs(bootUserId, "androidLockCardGate") : null;
    if (bootPrefs) {
      await applyAndroidLockCardGateFromLoad(bootPrefs.live_activity !== false, gen);
      return;
    }
    const res = await fetch("/api/push/prefs", { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return;
    const { prefs } = await res.json();
    await applyAndroidLockCardGateFromLoad(prefs?.live_activity !== false, gen);
  } catch {
    // silent — 다음 부팅/마이페이지 진입 시 재동기화
  }
}

/** 잠금화면 라이브 카드 지원/opt-in 상태 — 미지원(비안드/구버전 OS)이면 supported:false.
 *  구 네이티브 빌드(플러그인 메서드 부재)에서도 조용히 미지원 처리(fail-open — 토글 행 숨김용). */
export async function getLiveUpdateState(): Promise<LiveUpdateState> {
  if (!isAndroid) return { supported: false, enabled: false };
  try {
    return await GameNotification.getLiveUpdateState();
  } catch {
    return { supported: false, enabled: false };
  }
}

/** strict 버전 — 수동 재노출 경로 전용(삼순 #680 재리뷰). 브릿지 조회 실패(구빌드 메서드
 *  부재 포함)를 null로 구분 반환 — suppression 상태 불명인 채 재게시하면 네이티브 post()가
 *  조용히 suppress해 성공 오안내가 나므로 호출부가 failed 처리한다. */
export async function getLiveUpdateStateStrict(): Promise<LiveUpdateState | null> {
  if (!isAndroid) return null;
  try {
    return await GameNotification.getLiveUpdateState();
  } catch {
    return null;
  }
}

/** 잠금화면 라이브 카드 명시 opt-in 토글(디바이스 로컬).
 *  반환 = 브릿지 호출 성공 여부 — 재노출 경로에서 suppression 리셋 실패를 성공으로
 *  오안내하지 않기 위함(PR #680 삼순 blocker②). 기존 토글 호출부는 void 소비라 무영향. */
export async function setLiveUpdateOptIn(enabled: boolean): Promise<boolean> {
  if (!isAndroid) return false;
  try {
    await GameNotification.setLiveUpdateOptIn({ enabled });
    return true;
  } catch {
    return false;
  }
}

// 원격 로드 dual-instance 우회 — registerPlugin(정적 core) 호출 실패 시 주입 브릿지
// (window.Capacitor.Plugins.GameNotification) 직접 호출로 대체(native-live-activity getAppBuild 패턴 미러).
interface InjectedGameNotification {
  getWidgetTapMode?: () => Promise<{ mode?: WidgetTapMode; refreshSupported?: boolean }>;
  setWidgetTapMode?: (opts: { mode: WidgetTapMode }) => Promise<void>;
}
function injectedGameNotification(): InjectedGameNotification | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as {
    Capacitor?: { Plugins?: { GameNotification?: InjectedGameNotification } };
  }).Capacitor?.Plugins?.GameNotification;
}

/** 홈 위젯 탭 동작 모드 조회(디바이스 로컬). iOS는 LiveActivity 브릿지, 안드는 GameNotification.
 *  플러폼 분기는 정적 isIOS/isAndroid 대신 런타임 판정(원격 로드 web 오판 방지, 삼순 #833).
 *  capability(refreshSupported)는 성공한 네이티브 응답에서만 — 메서드 부재/throw(구빌드)는
 *  {open, refreshSupported:false} fail-closed(삼순 ④: 구빌드 오탐 금지). */
export async function getWidgetTapMode(): Promise<WidgetTapModeState> {
  if (isIosNativeRuntime()) return getIosWidgetTapMode();
  if (!isNativeRuntime()) return { mode: "open", refreshSupported: false, reason: "none" };
  // 안드로이드 네이티브 — 성공 응답은 항상 지원(refreshSupported:true, reason:none).
  const fromSuccess = (r?: { mode?: string; refreshSupported?: boolean }): WidgetTapModeState => {
    const refreshSupported = r?.refreshSupported === true; // 안드 네이티브가 명시 반환해야 지원 간주
    return {
      mode: r?.mode === "refresh" ? "refresh" : "open",
      refreshSupported,
      reason: refreshSupported ? "none" : "app_update",
    };
  };
  try {
    return fromSuccess(await GameNotification.getWidgetTapMode());
  } catch {
    // dual-instance 우회: 주입 브릿지 직접 호출
    const inj = injectedGameNotification();
    if (inj?.getWidgetTapMode) {
      try {
        return fromSuccess(await inj.getWidgetTapMode());
      } catch {
        /* fall through → fail-closed */
      }
    }
    // 메서드 부재 = 구 안드 빌드 → 런타임 플랫폼(android) 기반 앱 업데이트 안내(삼순 ②)
    return { mode: "open", refreshSupported: false, reason: "app_update" };
  }
}

/** 홈 위젯 탭 동작 모드 저장(디바이스 로컬). iOS는 LiveActivity, 안드는 GameNotification.
 *  성공 여부 반환 — 저장 실패(구빌드/브릿지) 시 카드가 이전 선택으로 롤백(삼순 ④). */
export async function setWidgetTapMode(mode: WidgetTapMode): Promise<boolean> {
  if (isIosNativeRuntime()) return setIosWidgetTapMode(mode);
  if (!isNativeRuntime()) return false;
  try {
    await GameNotification.setWidgetTapMode({ mode });
    return true;
  } catch {
    // dual-instance 우회: 주입 브릿지 직접 호출
    const inj = injectedGameNotification();
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

/** 최애선수 목록 동기화 — 선수 카드 위젯 config(선수 선택 목록)용. */
export async function setWidgetFavPlayers(players: unknown[]): Promise<void> {
  if (isIOS) {
    // iOS는 GameNotification(안드 전용) 대신 LiveActivity 플러그인으로 App Group에 기록.
    await syncIosWidgetFavPlayers(players);
    return;
  }
  if (!isAndroid) return;
  try {
    await GameNotification.setFavPlayers({ json: JSON.stringify(players ?? []) });
  } catch {
    // silent
  }
}
