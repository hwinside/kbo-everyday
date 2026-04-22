/**
 * In-app browser detection + external browser redirect utilities.
 *
 * Why this exists:
 *   Social/chat WebViews (Instagram, Threads, FB, KakaoTalk, NAVER app, Line)
 *   block or sandbox third-party cookies required by OAuth flows. Naver / Kakao /
 *   Google sign-in via these WebViews has been observed failing silently —
 *   users return from the provider but their session cookie never persists.
 *
 *   Rather than chase cookie/session fallbacks inside the WebView, the
 *   industry-standard remedy is: detect the in-app UA, and guide users into
 *   the real system browser (Safari/Chrome).
 *
 * Sources referenced while implementing:
 *   - Google OAuth "disallowed_useragent" policy (2023)
 *   - Toss/Baemin/Danggeun/Naver-cafe production patterns
 */

export type InAppBrowserKind =
  | "instagram"
  | "threads"
  | "facebook"
  | "kakaotalk"
  | "naver-app"
  | "line"
  | "band"
  | "kakaostory"
  | "daum-app"
  | "other-inapp"
  | null;

export interface InAppDetection {
  isInApp: boolean;
  kind: InAppBrowserKind;
  os: "ios" | "android" | "other";
  /** Human-readable app label for UI copy. */
  label: string | null;
}

/**
 * Detect whether the current user-agent is an in-app WebView we need to
 * escape from for OAuth. Safe to call on server (returns isInApp=false).
 */
export function detectInApp(userAgent?: string): InAppDetection {
  const ua =
    userAgent ??
    (typeof navigator !== "undefined" ? navigator.userAgent : "") ??
    "";

  if (!ua) return { isInApp: false, kind: null, os: "other", label: null };

  const os: InAppDetection["os"] = /iPad|iPhone|iPod/.test(ua)
    ? "ios"
    : /Android/i.test(ua)
    ? "android"
    : "other";

  // Order matters: Threads UA contains "Barcelona" and we want to surface it
  // distinctly from Instagram even though both are Meta apps.
  if (/Barcelona/i.test(ua)) {
    return { isInApp: true, kind: "threads", os, label: "Threads" };
  }
  if (/Instagram/i.test(ua)) {
    return { isInApp: true, kind: "instagram", os, label: "Instagram" };
  }
  if (/FBAN|FBAV|FB_IAB|FB4A|FBIOS/i.test(ua)) {
    return { isInApp: true, kind: "facebook", os, label: "Facebook" };
  }
  if (/KAKAOTALK/i.test(ua)) {
    return { isInApp: true, kind: "kakaotalk", os, label: "카카오톡" };
  }
  if (/kakaostory/i.test(ua)) {
    return { isInApp: true, kind: "kakaostory", os, label: "카카오스토리" };
  }
  // NAVER app family: "NAVER(inapp" appears in blog/cafe/main app; older apps
  // use bare "naver" token in UA too. Be conservative to avoid false positives
  // on Windows/browsers.
  if (/NAVER\(inapp|NAVER\/[0-9]/i.test(ua)) {
    return { isInApp: true, kind: "naver-app", os, label: "네이버앱" };
  }
  if (/\bLine\//i.test(ua)) {
    return { isInApp: true, kind: "line", os, label: "LINE" };
  }
  if (/BAND\//i.test(ua)) {
    return { isInApp: true, kind: "band", os, label: "밴드" };
  }
  if (/DaumApps/i.test(ua)) {
    return { isInApp: true, kind: "daum-app", os, label: "다음앱" };
  }

  return { isInApp: false, kind: null, os, label: null };
}

/**
 * Attempt to force-open a URL in the external system browser.
 *
 * Return value:
 *   - "attempted": we invoked a scheme/redirect. The caller should keep the
 *     guidance modal visible until `onTimeout` fires — if the scheme fails
 *     silently (custom scheme not handled, intent:// rejected), we want the
 *     user to still have the manual copy/guide visible.
 *   - "fallback": we could not even attempt a scheme; caller should show
 *     manual instructions immediately (e.g. "menu → open in Safari").
 *
 * Scheme-failure handling:
 *   Custom scheme navigation never throws on failure — the browser just stays
 *   on the page. We therefore arm a ~1.8s timer and clear it only if the
 *   document becomes hidden (user actually left this WebView). If the timer
 *   fires, `onTimeout` is called so the caller can resurface explicit manual
 *   instructions. This matches the pattern Toss / Naver Cafe / Daangn use.
 *
 * Notes:
 *   - iOS Safari cannot be force-opened from an arbitrary WebView (no public
 *     scheme). We return "fallback" on iOS except KakaoTalk, which exposes
 *     `kakaotalk://web/openExternal`.
 *   - Android Chrome can be targeted via `intent://` for most in-app WebViews
 *     including Instagram and Threads.
 */
export function openExternalBrowser(
  targetUrl: string,
  detection: InAppDetection,
  onTimeout?: () => void,
): "attempted" | "fallback" {
  if (!detection.isInApp || typeof window === "undefined") return "fallback";

  let schemeUrl: string | null = null;

  // KakaoTalk has an explicit scheme on both iOS and Android.
  if (detection.kind === "kakaotalk") {
    schemeUrl = `kakaotalk://web/openExternal?url=${encodeURIComponent(
      targetUrl,
    )}`;
  } else if (detection.os === "android") {
    try {
      const url = new URL(targetUrl, window.location.origin);
      const pathAndSearch = `${url.pathname}${url.search}${url.hash}`;
      const host = url.host;
      const scheme = url.protocol.replace(":", "");
      schemeUrl = `intent://${host}${pathAndSearch}#Intent;scheme=${scheme};package=com.android.chrome;end`;
    } catch {
      return "fallback";
    }
  } else {
    // iOS + other inapp: no public API to force-open Safari.
    return "fallback";
  }

  // Arm the fallback timer BEFORE we navigate so we never race against a
  // scheme handler that redirects synchronously.
  const TIMEOUT_MS = 1800;
  let fired = false;
  const onHidden = () => {
    if (document.visibilityState === "hidden") {
      // User actually left — scheme worked. Disarm.
      fired = true;
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", onHidden);
    }
  };
  document.addEventListener("visibilitychange", onHidden);
  window.addEventListener("pagehide", onHidden);

  window.setTimeout(() => {
    document.removeEventListener("visibilitychange", onHidden);
    window.removeEventListener("pagehide", onHidden);
    if (!fired && onTimeout) onTimeout();
  }, TIMEOUT_MS);

  try {
    window.location.href = schemeUrl;
  } catch {
    return "fallback";
  }
  return "attempted";
}

/**
 * Build a stable, absolute URL for the external browser to land on.
 * Preserves search + hash so login intents etc. survive the jump.
 */
export function currentAbsoluteUrl(): string {
  if (typeof window === "undefined") return "";
  return window.location.href;
}
