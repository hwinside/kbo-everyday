/**
 * 네이티브 세션 백업/복구 — WKWebView/WebView 웹 저장소 퍼지 대응.
 *
 * 배경 (App Store 리뷰 "들어갈때마다 로그인을 다시"):
 * 앱은 원격 로드(server.url=keubo.fan)라 로그인 세션(@supabase/ssr 쿠키)과
 * 온보딩 상태(localStorage)가 전부 웹뷰 저장소에 있다. iOS가 저장공간 압박 등으로
 * WKWebsiteDataStore 를 퍼지하면 쿠키+localStorage 가 동시에 사라져
 * "재로그인 + 온보딩 재진입" 전체 리셋이 된다.
 *
 * 대응: 세션 토큰을 네이티브 secure storage(커스텀 SecureSessionStore 플러그인 —
 * iOS Keychain / Android EncryptedSharedPreferences+Keystore)에 미러링해 두고,
 * 부팅 시 쿠키 세션이 없으면 setSession() 으로 복원한다. 웹 저장소 퍼지와 무관한
 * 영역이라 로그인이 유지된다. (Preferences/UserDefaults 평문 저장은 보안 NO-GO —
 * 삼순 리뷰 반영으로 Keychain/Keystore 계열로 교체)
 *
 * 안전 원칙 (기존 로그인 경로 무영향):
 * - 모든 함수는 best-effort: 실패는 조용히 무시하고 기존 흐름 그대로 진행.
 * - 웹/구버전 앱(SecureSessionStore 미포함 바이너리)에서는 자동 no-op.
 * - 복원은 "쿠키·pending 세션이 이미 없을 때"만 시도 — 정상 세션은 절대 건드리지 않는다.
 * - 모든 브릿지 호출·setSession 에 타임아웃 상한 — hang 이 부팅을 막지 못하게.
 * - 백업 삭제는 "확정적 refresh 거부"에서만 — transient 오류로 유일한 백업을 잃지 않는다.
 * - 로그아웃 fence — signOut 진행 중 동시 SIGNED_IN/TOKEN_REFRESHED 가 백업을
 *   되살리는 race 차단.
 */

import { isNativeRuntime } from "./platform";

const BACKUP_KEY = "kbo-native-session-backup";
/** 브릿지/auth 호출이 hang 해도 부팅을 막지 않는 상한 */
const CALL_TIMEOUT_MS = 3000;

export interface SessionTokens {
  access_token: string;
  refresh_token: string;
}

interface SecureStoreLike {
  get(options: { key: string }): Promise<{ value: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
  remove(options: { key: string }): Promise<void>;
}

interface InjectedCapacitor {
  Plugins?: Record<string, unknown>;
}

/**
 * 주입 브릿지의 SecureSessionStore 플러그인만 반환.
 * 웹 / 플러그인 미포함 구버전 바이너리 → null (호출부 전부 no-op).
 * npm 웹 구현 폴백을 두지 않는 이유: 웹 저장소 기반 폴백은 퍼지에 같이 사라지는
 * 가짜 백업이 된다 (dual-instance 패턴 — platform.ts / venue-media-library.ts 참조).
 */
function getSecureStore(): SecureStoreLike | null {
  if (!isNativeRuntime()) return null;
  if (typeof window === "undefined") return null;
  try {
    const injected = (window as unknown as { Capacitor?: InjectedCapacitor })
      .Capacitor;
    const plugin = injected?.Plugins?.["SecureSessionStore"] as
      | SecureStoreLike
      | undefined;
    if (
      plugin &&
      typeof plugin.get === "function" &&
      typeof plugin.set === "function" &&
      typeof plugin.remove === "function"
    ) {
      return plugin;
    }
  } catch {
    /* 브릿지 접근 실패 → no-op */
  }
  return null;
}

const TIMEOUT_SENTINEL = Symbol("timeout");

function withTimeout<T>(p: Promise<T>, fallback: T): Promise<T> {
  return new Promise<T>(resolve => {
    let settled = false;
    const done = (v: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => done(fallback), CALL_TIMEOUT_MS);
    p.then(done).catch(() => done(fallback));
  });
}

/** timeout 을 구분해야 하는 호출용 — fallback 대신 sentinel 반환 */
function withTimeoutSentinel<T>(p: Promise<T>): Promise<T | typeof TIMEOUT_SENTINEL> {
  return new Promise(resolve => {
    let settled = false;
    const done = (v: T | typeof TIMEOUT_SENTINEL) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => done(TIMEOUT_SENTINEL), CALL_TIMEOUT_MS);
    p.then(done).catch(() => done(TIMEOUT_SENTINEL));
  });
}

// ---------------------------------------------------------------------------
// 로그아웃 fence — signOut 진행 중 백업 재기록 차단 (삼순 P1)
// ---------------------------------------------------------------------------

let logoutFenceActive = false;

/**
 * 명시적 로그아웃 시작 시 호출. 이후 backupSessionTokens 는 전부 no-op 이 되어
 * signOut 과 동시에 도착한 TOKEN_REFRESHED/SIGNED_IN 이 백업을 되살리지 못한다.
 * fence 는 페이지 이탈(window.location 이동)까지 유지된다.
 */
export function beginLogoutFence(): void {
  logoutFenceActive = true;
}

/** 테스트 전용 — fence 상태 리셋 */
export function _resetLogoutFenceForTest(): void {
  logoutFenceActive = false;
}

// ---------------------------------------------------------------------------
// 백업 원장 조작
// ---------------------------------------------------------------------------

/**
 * 세션 토큰을 네이티브 secure storage 에 백업. SIGNED_IN / TOKEN_REFRESHED 마다 호출해
 * refresh token rotation 이후에도 백업이 최신을 유지하게 한다. best-effort.
 * 로그아웃 fence 활성 중에는 no-op (백업 부활 race 차단).
 */
export async function backupSessionTokens(tokens: SessionTokens): Promise<void> {
  if (logoutFenceActive) return;
  const store = getSecureStore();
  if (!store) return;
  if (!tokens.access_token || !tokens.refresh_token) return;
  await withTimeout(
    store.set({ key: BACKUP_KEY, value: JSON.stringify(tokens) }),
    undefined,
  );
}

/**
 * 네이티브 백업에서 세션 토큰을 읽는다. 없거나 파싱 불가면 null.
 */
export async function readSessionBackup(): Promise<SessionTokens | null> {
  const store = getSecureStore();
  if (!store) return null;
  const result = await withTimeout<{ value: string | null }>(
    store.get({ key: BACKUP_KEY }),
    { value: null },
  );
  if (!result.value) return null;
  try {
    const parsed = JSON.parse(result.value) as Partial<SessionTokens>;
    if (
      typeof parsed.access_token === "string" &&
      parsed.access_token.length > 0 &&
      typeof parsed.refresh_token === "string" &&
      parsed.refresh_token.length > 0
    ) {
      return {
        access_token: parsed.access_token,
        refresh_token: parsed.refresh_token,
      };
    }
  } catch {
    /* 손상된 백업 → null */
  }
  return null;
}

/**
 * 백업 제거 — 명시적 로그아웃, 또는 확정적 refresh 거부 시.
 */
export async function clearSessionBackup(): Promise<void> {
  const store = getSecureStore();
  if (!store) return;
  await withTimeout(store.remove({ key: BACKUP_KEY }), undefined);
}

// ---------------------------------------------------------------------------
// 복원 — 에러 분류 포함 (삼순 P0: transient error 로 유일한 백업을 잃지 않기)
// ---------------------------------------------------------------------------

export interface AuthErrorLike {
  message?: string;
  name?: string;
  status?: number;
  code?: string;
}

/**
 * "이 refresh token 은 서버가 확정적으로 거부했다"인 경우에만 true.
 * supabase-js 는 일시적 네트워크 실패도 throw 가 아니라 error 로 반환하므로
 * (AuthRetryableFetchError), error 존재 = 무효 토큰이 아니다.
 *
 * 판정: 명시적 코드/메시지 신호만 신뢰. 애매하면 false(백업 보존) — 최악이
 * "다음 부팅에서 한 번 더 실패 시도"라 안전한 방향으로 fail-close.
 */
export function isDefinitiveRefreshRejection(error: AuthErrorLike): boolean {
  if (error.name === "AuthRetryableFetchError") return false;
  const code = (error.code ?? "").toLowerCase();
  if (
    code === "refresh_token_not_found" ||
    code === "refresh_token_already_used" ||
    code === "session_not_found" ||
    code === "invalid_grant"
  ) {
    return true;
  }
  const msg = (error.message ?? "").toLowerCase();
  if (msg.includes("invalid refresh token") || msg.includes("refresh token not found")) {
    return true;
  }
  return false;
}

interface AuthLike<S> {
  setSession(tokens: SessionTokens): Promise<{
    data: { session: S | null };
    error: AuthErrorLike | null;
  }>;
}

/**
 * 쿠키/pending 세션이 없을 때만 호출되는 복원 경로.
 * - 백업 없음 → null (기존 로그아웃 흐름 그대로, setSession 미호출)
 * - setSession 성공 → 복원된 세션 반환
 * - 확정적 refresh 거부 → 백업 제거 후 null (실패 복원 무한 반복 방지)
 * - transient(네트워크 error·throw·타임아웃) → 백업 보존하고 null (다음 부팅 재시도)
 * - setSession 자체에 타임아웃 상한 — auth lock hang 이 부팅을 영구 정지시키지 않게
 */
export async function restoreSessionFromBackup<S>(
  auth: AuthLike<S>,
): Promise<S | null> {
  const backup = await readSessionBackup();
  if (!backup) return null;
  try {
    const result = await withTimeoutSentinel(auth.setSession(backup));
    if (result === TIMEOUT_SENTINEL) {
      // hang/지연 — transient 취급, 백업 보존. (늦게 성공하면 onAuthStateChange 가 이어받는다)
      return null;
    }
    const { data, error } = result;
    if (data.session) return data.session;
    if (error && isDefinitiveRefreshRejection(error)) {
      await clearSessionBackup();
    }
  } catch {
    /* transient 실패 — 백업 보존, 이번 부팅은 로그아웃 상태로 진행 */
  }
  return null;
}

// ---------------------------------------------------------------------------
// 세션 획득 사다리 — AuthContext.syncSession 의 획득 순서를 검증 가능한 형태로 추출
// (동작은 기존과 동일: ① 쿠키 세션 → ② pending 토큰 → ③ 네이티브 백업 복원)
// ---------------------------------------------------------------------------

export interface SessionLike {
  access_token: string;
  refresh_token: string;
}

export interface SessionLadderDeps<S extends SessionLike> {
  /** ① 쿠키 기반 세션 (supabase.auth.getSession) */
  getCookieSession(): Promise<S | null>;
  /** ② sessionStorage 의 1회성 pending 토큰 — 읽고 즉시 제거 (기존 semantics) */
  consumePendingTokens(): SessionTokens | null;
  /** setSession — pending 복원과 백업 복원이 공유 */
  setSession(tokens: SessionTokens): Promise<{
    data: { session: S | null };
    error: AuthErrorLike | null;
  }>;
}

/**
 * 세션 획득 사다리. 상위 단계에서 세션을 얻으면 하위 단계는 절대 실행되지 않는다 —
 * 특히 쿠키/pending 세션이 있으면 네이티브 백업 read 0회 (정상 로그인 무영향 계약,
 * QA 스모크가 call count 로 직접 검증).
 * 세션 확보 시 네이티브 백업을 갱신한다 (웹/구버전은 내부에서 no-op).
 */
export async function acquireSession<S extends SessionLike>(
  deps: SessionLadderDeps<S>,
): Promise<S | null> {
  let session: S | null = null;

  // ① 쿠키 세션
  try {
    session = await deps.getCookieSession();
  } catch {
    /* getSession 실패 → 다음 단계 */
  }

  // ② pending 토큰 (iOS Safari 쿠키 미부착 fallback — 기존 로직 이동)
  if (!session) {
    try {
      const pending = deps.consumePendingTokens();
      if (pending) {
        const { data } = await deps.setSession(pending);
        session = data.session;
      }
    } catch {
      /* pending 복원 실패 무시 (기존 semantics) */
    }
  }

  // ③ 네이티브 백업 복원 (앱 전용 — 웹뷰 저장소 퍼지로 쿠키가 사라진 경우)
  if (!session) {
    try {
      session = await restoreSessionFromBackup(deps);
    } catch {
      /* best-effort */
    }
  }

  // 세션 확보 → 백업 최신화
  if (session?.access_token && session.refresh_token) {
    void backupSessionTokens({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
    });
  }

  return session;
}
