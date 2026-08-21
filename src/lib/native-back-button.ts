/**
 * Android 하드웨어 뒤로가기 처리 (네이티브 앱 전용)
 *
 * 문제: backButton 리스너가 없으면 Capacitor 기본 동작(웹뷰 history goBack)만 수행되는데,
 * 탭바가 Link(pushState) 기반이라 히스토리가 계속 쌓여 뒤로가기를 아무리 눌러도
 * 앱이 종료되지 않는다 (#cs 2026-07-12 제보).
 *
 * 동작:
 * - 홈("/")에서: 첫 번째 뒤로가기 → "한 번 더 누르면 종료" 토스트, 2초 안에 한 번 더 → 앱 종료
 * - 그 외 경로: 히스토리 있으면 뒤로가기, 없으면(딥링크 콜드 스타트 등) 홈으로 이동
 *
 * iOS는 하드웨어 뒤로가기가 없어 backButton 이벤트가 발생하지 않지만,
 * 리스너 등록 자체를 Android로 게이트해 불필요한 플러그인 로드를 막는다.
 */
import { isAndroid } from "@/lib/capacitor/platform";

const EXIT_CONFIRM_WINDOW_MS = 2000;
const EXIT_TOAST_ID = "android-back-exit-toast";

let listenerAttached = false;
let lastBackPressAt = 0;

// 원격 로드(server.url) 앱은 npm @capacitor/core가 'web'으로 오판할 수 있어
// 주입된 window.Capacitor 브릿지 판정을 병행한다 (레퍼런스: capacitor_remote_load_isnative_false).
function isAndroidNative(): boolean {
  if (isAndroid) return true;
  if (typeof window === "undefined") return false;
  const injected = (window as unknown as { Capacitor?: { getPlatform?: () => string } }).Capacitor;
  try {
    return injected?.getPlatform?.() === "android";
  } catch {
    return false;
  }
}

function showExitToast(): void {
  if (typeof document === "undefined") return;
  document.getElementById(EXIT_TOAST_ID)?.remove();
  const toast = document.createElement("div");
  toast.id = EXIT_TOAST_ID;
  toast.textContent = "한 번 더 누르면 앱이 종료됩니다";
  toast.style.cssText = [
    "position:fixed",
    "left:50%",
    "transform:translateX(-50%)",
    // 탭바(--global-tabbar-h 51px) 위에 뜨도록
    "bottom:calc(var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)) + 70px)",
    "z-index:9999",
    "background:rgba(0,0,0,0.82)",
    "color:#fff",
    "font-size:13px",
    "font-weight:500",
    "padding:9px 16px",
    "border-radius:9999px",
    "pointer-events:none",
    "white-space:nowrap",
  ].join(";");
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), EXIT_CONFIRM_WINDOW_MS);
}

/** 앱 부팅 시 1회 호출 (NativePushMount). Android 네이티브가 아니면 no-op. */
export async function listenForAndroidBackButton(): Promise<void> {
  if (listenerAttached || !isAndroidNative()) return;
  listenerAttached = true;
  try {
    const { App } = await import("@capacitor/app");
    await App.addListener("backButton", ({ canGoBack }) => {
      if (window.location.pathname === "/") {
        const now = Date.now();
        if (now - lastBackPressAt <= EXIT_CONFIRM_WINDOW_MS) {
          void App.exitApp();
          return;
        }
        lastBackPressAt = now;
        showExitToast();
        return;
      }
      if (canGoBack) {
        window.history.back();
        return;
      }
      // 히스토리 없이 딥링크로 진입한 경우 — 종료 대신 홈으로 (다음 뒤로가기 = 종료 확인 플로우)
      window.location.replace("/");
    });
  } catch {
    // 리스너 등록 실패 시 Capacitor 기본 동작 유지 — 다음 부팅에서 재시도 가능하도록 해제
    listenerAttached = false;
  }
}
