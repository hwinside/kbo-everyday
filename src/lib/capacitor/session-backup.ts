/**
 * 네이티브 세션 백업/복구 — WKWebView/WebView 웹 저장소 퍼지 대응.
 *
 * 배경 (App Store 리뷰 "들어갈때마다 로그인을 다시"):
 * 앱은 원격 로드(server.url=keubo.fan)라 로그인 세션(@supabase/ssr 쿠키)과
 * 온보딩 상태(localStorage)가 전부 웹뷰 저장소에 있다. iOS가 저장공간 압박 등으로
 * WKWebsiteDataStore 를 퍼지하면 쿠키+localStorage 가 동시에 사라져
 * "재로그인 + 온보딩 재진입" 전체 리셋이 된다.
 *
 * 대응: 세션 토큰을 네이티브 저장소(@capacitor/preferences → iOS UserDefaults /
 * Android SharedPreferences)에 미러링해 두고, 부팅 시 쿠키 세션이 없으면
 * setSession() 으로 복원한다. 웹 저장소 퍼지와 무관한 영역이라 로그인이 유지된다.
 *
 * 안전 원칙 (기존 로그인 경로 무영향):
 * - 모든 함수는 best-effort: 실패는 조용히 무시하고 기존 흐름 그대로 진행.
 * - 웹/구버전 앱(Preferences 플러그인 없는 바이너리)에서는 자동 no-op.
 * - 복원은 "쿠키 세션이 이미 없을 때"만 시도 — 정상 세션은 절대 건드리지 않는다.
 * - npm @capacitor/preferences 의 web 구현(localStorage) 사용 금지: 같은 웹 저장소라
 *   퍼지에 같이 사라져 가짜 백업이 된다. 주입 브릿지(window.Capacitor.Plugins)만 사용
 *   (원격 로드 dual-instance false-negative 대응 — platform.ts / venue-media-library.ts 패턴).
 */

import { isNativeRuntime } from "./platform";

const BACKUP_KEY = "kbo-native-session-backup";
/** Preferences 호출이 브릿지 이상으로 hang 해도 부팅을 막지 않는 상한 */
const CALL_TIMEOUT_MS = 3000;

export interface SessionTokens {
  access_token: string;
  refresh_token: string;
}

interface PreferencesLike {
  get(options: { key: string }): Promise<{ value: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
  remove(options: { key: string }): Promise<void>;
}

interface InjectedCapacitor {
  Plugins?: Record<string, unknown>;
}

/**
 * 주입 브릿지의 Preferences 플러그인만 반환.
 * 웹 / 플러그인 미포함 구버전 바이너리 → null (호출부 전부 no-op).
 */
function getNativePreferences(): PreferencesLike | null {
  if (!isNativeRuntime()) return null;
  if (typeof window === "undefined") return null;
  try {
    const injected = (window as unknown as { Capacitor?: InjectedCapacitor })
      .Capacitor;
    const plugin = injected?.Plugins?.["Preferences"] as
      | PreferencesLike
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

/**
 * 세션 토큰을 네이티브 저장소에 백업. SIGNED_IN / TOKEN_REFRESHED 마다 호출해
 * refresh token rotation 이후에도 백업이 최신을 유지하게 한다. best-effort.
 */
export async function backupSessionTokens(tokens: SessionTokens): Promise<void> {
  const prefs = getNativePreferences();
  if (!prefs) return;
  if (!tokens.access_token || !tokens.refresh_token) return;
  await withTimeout(
    prefs.set({ key: BACKUP_KEY, value: JSON.stringify(tokens) }),
    undefined,
  );
}

/**
 * 네이티브 백업에서 세션 토큰을 읽는다. 없거나 파싱 불가면 null.
 * (setSession 시도 자체는 호출부 — AuthContext — 책임)
 */
export async function readSessionBackup(): Promise<SessionTokens | null> {
  const prefs = getNativePreferences();
  if (!prefs) return null;
  const result = await withTimeout<{ value: string | null }>(
    prefs.get({ key: BACKUP_KEY }),
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
 * 백업 제거 — 명시적 로그아웃, 또는 복원 실패(무효 refresh token) 시.
 * 무효 백업을 남기면 부팅마다 실패 복원을 반복하므로 즉시 지운다.
 */
export async function clearSessionBackup(): Promise<void> {
  const prefs = getNativePreferences();
  if (!prefs) return;
  await withTimeout(prefs.remove({ key: BACKUP_KEY }), undefined);
}

interface AuthLike<S> {
  setSession(tokens: SessionTokens): Promise<{
    data: { session: S | null };
    error: { message?: string } | null;
  }>;
}

/**
 * 쿠키 세션이 없을 때만 호출되는 복원 경로.
 * - 백업 없음 → null (기존 로그아웃 흐름 그대로)
 * - setSession 성공 → 복원된 세션 반환
 * - setSession 이 error 반환(무효/만료 refresh token) → 백업 제거 후 null
 *   (무효 백업으로 부팅마다 실패 복원을 반복하지 않게)
 * - setSession 이 throw(네트워크 등 transient) → 백업 유지하고 null
 *   (다음 부팅에서 재시도 기회 보존)
 */
export async function restoreSessionFromBackup<S>(
  auth: AuthLike<S>,
): Promise<S | null> {
  const backup = await readSessionBackup();
  if (!backup) return null;
  try {
    const { data, error } = await auth.setSession(backup);
    if (data.session) return data.session;
    if (error) await clearSessionBackup();
  } catch {
    /* transient 실패 — 백업 보존, 이번 부팅은 로그아웃 상태로 진행 */
  }
  return null;
}
