"use client";

import { useState, useEffect } from "react";
import { X } from "lucide-react";
import { isNativeRuntime, isAndroidWeb, isIosWeb } from "@/lib/capacitor/platform";

const APP_STORE_URL = "https://apps.apple.com/kr/app/id6765719087";
const PLAY_STORE_URL = "https://play.google.com/store/apps/details?id=fan.keubo.app";

const DISMISS_KEY = "app-download-banner-dismissed";
const DISMISS_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7일

/**
 * 모바일 웹 + PWA(standalone)에서 네이티브 앱 다운로드를 유도하는 인라인 배너.
 * - 네이티브 앱(Capacitor iOS/Android)에선 절대 노출 안 함 (isNativeRuntime)
 * - 데스크톱에선 노출 안 함 (iOS/Android 모바일 웹만)
 * - 닫으면 7일간 재노출 억제 (localStorage)
 */
export default function AppDownloadBanner() {
  const [storeUrl, setStoreUrl] = useState<string | null>(null);

  useEffect(() => {
    // 네이티브 앱(iOS/Android)에선 노출 금지 — 주입 브릿지까지 확인 (원격 로드 대응)
    if (isNativeRuntime()) return;

    // 7일 내 닫았으면 숨김
    const dismissed = localStorage.getItem(DISMISS_KEY);
    if (dismissed && Date.now() - Number(dismissed) < DISMISS_TTL_MS) return;

    // 모바일 웹/PWA만: iOS → App Store, Android → Play. 데스크톱은 미노출.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (isIosWeb()) setStoreUrl(APP_STORE_URL);
    else if (isAndroidWeb()) setStoreUrl(PLAY_STORE_URL);
  }, []);

  const dismiss = () => {
    setStoreUrl(null);
    localStorage.setItem(DISMISS_KEY, String(Date.now()));
  };

  if (!storeUrl) return null;

  return (
    <div className="mb-3">
      <div className="bg-[rgba(240,240,242,0.95)] dark:bg-[rgba(30,30,35,0.95)] backdrop-blur-xl border border-border rounded-2xl px-4 py-2.5 flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-text-primary truncate">📲 크보팬 앱 다운로드</p>
          <p className="text-xs leading-[18px] text-text-tertiary truncate">앱에서 이용할 때 가장 쾌적하게 이용하실 수 있어요</p>
        </div>
        <a
          href={storeUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="px-3 py-1.5 bg-accent text-white text-xs font-semibold rounded-xl whitespace-nowrap"
        >
          {storeUrl === APP_STORE_URL ? "App Store" : "Google Play"}
        </a>
        <button onClick={dismiss} className="text-text-tertiary p-0.5 -mr-1" aria-label="닫기">
          <X size={16} />
        </button>
      </div>
    </div>
  );
}
