"use client";

import { useState, useEffect } from "react";
import { X, Share, Plus } from "lucide-react";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

interface NavigatorStandalone extends Navigator {
  standalone?: boolean;
}

export default function PWAInstallBanner() {
  const [show, setShow] = useState(false);
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isIOS, setIsIOS] = useState(false);
  const [showIOSGuide, setShowIOSGuide] = useState(false);
  const [isInAppBrowser, setIsInAppBrowser] = useState(false);
  const [isNonSafariiOS, setIsNonSafariiOS] = useState(false);

  useEffect(() => {
    // 이미 PWA로 실행 중이면 숨김
    if (window.matchMedia("(display-mode: standalone)").matches) return;
    if ((window.navigator as NavigatorStandalone).standalone) return;

    // 24시간 내 닫았으면 숨김
    const dismissed = localStorage.getItem("pwa-banner-dismissed");
    if (dismissed && Date.now() - Number(dismissed) < 7 * 24 * 60 * 60 * 1000) return;

    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsIOS(ios);

    // 인앱브라우저 감지 (카카오톡, 인스타, 페이스북, 네이버, 라인 등)
    const ua = navigator.userAgent;
    const isInApp = /KAKAOTALK|Instagram|FBAN|FBAV|NAVER|Line/i.test(ua);
    if (isInApp) {
      setIsInAppBrowser(true);
      setShow(true);
      return;
    }

    if (ios) {
      const isSafari = /Safari/.test(ua) && !/CriOS|FxiOS/.test(ua);
      const isIOSChrome = /CriOS/.test(ua);
      const isIOSFirefox = /FxiOS/.test(ua);
      if (isIOSChrome || isIOSFirefox) {
        setIsNonSafariiOS(true);
        setShow(true);
      } else if (isSafari) {
        setShow(true);
      }
    } else {
      // Android: beforeinstallprompt 이벤트
      const handler = (e: Event) => {
        e.preventDefault();
        setDeferredPrompt(e as BeforeInstallPromptEvent);
        setShow(true);
      };
      window.addEventListener("beforeinstallprompt", handler);
      // 이벤트 없어도 3초 후 표시 (일부 브라우저)
      const timer = setTimeout(() => setShow(true), 3000);
      return () => {
        window.removeEventListener("beforeinstallprompt", handler);
        clearTimeout(timer);
      };
    }
  }, []);

  const dismiss = () => {
    setShow(false);
    localStorage.setItem("pwa-banner-dismissed", String(Date.now()));
  };

  const install = async () => {
    if (isNonSafariiOS) {
      alert("Safari에서만 홈 화면에 추가할 수 있어요!\n\n이 페이지 주소를 복사해서 Safari에서 열어주세요.");
      navigator.clipboard?.writeText(window.location.href);
      return;
    }
    if (isInAppBrowser) {
      // 외부 브라우저로 열기
      const url = window.location.href;
      // Android 인텐트
      if (/android/i.test(navigator.userAgent)) {
        window.location.href = `intent://${url.replace(/https?:\/\//, "")}#Intent;scheme=https;end`;
      } else {
        // iOS — Safari로 열기 안내
        window.open(url, "_blank");
        alert("Safari에서 열린 페이지에서 홈 화면에 추가하세요!");
      }
      return;
    }
    if (isIOS) {
      setShowIOSGuide(true);
      return;
    }
    if (deferredPrompt) {
      deferredPrompt.prompt();
      const result = await deferredPrompt.userChoice;
      if (result.outcome === "accepted") dismiss();
      setDeferredPrompt(null);
    }
  };

  if (!show) return null;

  return (
    <>
      {/* 인라인 슬림 배너 (non-sticky, 홈 전용) */}
      <div className="mx-auto max-w-lg px-5 mb-3">
        <div className="bg-[rgba(240,240,242,0.95)] dark:bg-[rgba(30,30,35,0.95)] backdrop-blur-xl border border-border rounded-2xl px-4 py-2.5 flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-text-primary truncate">{isInAppBrowser ? "🌐 브라우저에서 열기" : isNonSafariiOS ? "🧭 Safari에서 열기" : "📲 홈 화면에 추가"}</p>
            <p className="text-xs leading-[18px] text-text-tertiary truncate">{isInAppBrowser ? "외부 브라우저에서 앱을 설치할 수 있어요" : isNonSafariiOS ? "Safari에서만 앱을 설치할 수 있어요" : "앱처럼 빠르게 접속할 수 있어요"}</p>
          </div>
          <button
            onClick={install}
            className="px-3 py-1.5 bg-accent text-white text-xs font-semibold rounded-xl whitespace-nowrap"
          >
            {isInAppBrowser ? "열기" : isNonSafariiOS ? "복사" : isIOS ? "방법" : "설치"}
          </button>
          <button onClick={dismiss} className="text-text-tertiary p-0.5 -mr-1" aria-label="닫기">
            <X size={16} />
          </button>
        </div>
      </div>

      {/* iOS 가이드 모달 */}
      {showIOSGuide && (
        <div className="fixed inset-0 z-[60] bg-black/80 backdrop-blur-sm flex items-end justify-center" onClick={() => setShowIOSGuide(false)}>
          <div className="w-full max-w-lg bg-bg-secondary rounded-t-3xl p-6 pb-safe" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-text-primary mb-4">홈 화면에 추가하기</h3>
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-accent/20 flex items-center justify-center text-accent font-bold text-sm">1</div>
                <p className="text-sm text-text-secondary">하단 우측 <strong>⋯</strong> 버튼을 탭 → <Share size={16} className="inline text-accent" /> <strong>공유</strong>를 선택하세요</p>
              </div>
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-accent/20 flex items-center justify-center text-accent font-bold text-sm">2</div>
                <p className="text-sm text-text-secondary"><Plus size={16} className="inline text-accent" /> <strong>홈 화면에 추가</strong>를 선택하세요</p>
              </div>
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-accent/20 flex items-center justify-center text-accent font-bold text-sm">3</div>
                <p className="text-sm text-text-secondary">오른쪽 상단 <strong>추가</strong>를 탭하면 완료!</p>
              </div>
            </div>
            <button
              onClick={() => { setShowIOSGuide(false); dismiss(); }}
              className="w-full mt-6 py-3 bg-accent text-white font-semibold rounded-xl"
            >
              확인
            </button>
          </div>
        </div>
      )}
    </>
  );
}
