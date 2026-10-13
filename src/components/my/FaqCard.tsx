"use client";

import { useState, useSyncExternalStore } from "react";
import { ChevronDown, CircleHelp } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";
import { platform } from "@/lib/capacitor/platform";
import { FAQ_ITEMS, type FaqPlatform } from "@/lib/constants/faq-items";

const subscribeToPlatform = () => () => {};

interface InjectedCapacitor {
  getPlatform?: () => string;
  isNativePlatform?: () => boolean;
}

// 원격 로드(server.url) 앱에서는 npm @capacitor/core가 web으로 오판할 수 있어,
// 네이티브 셸이 주입한 window.Capacitor 브릿지를 함께 확인한다.
const getPlatformSnapshot = (): FaqPlatform => {
  if (platform !== "web" || typeof window === "undefined") return platform;

  const injected = (window as unknown as { Capacitor?: InjectedCapacitor }).Capacitor;
  try {
    const injectedPlatform = injected?.getPlatform?.();
    if (injectedPlatform === "ios" || injectedPlatform === "android") return injectedPlatform;

    if (injected?.isNativePlatform?.() === true) {
      if (/android/i.test(navigator.userAgent)) return "android";
      if (/iphone|ipad|ipod/i.test(navigator.userAgent)) return "ios";
    }
  } catch {
    // 브릿지 조회 실패 시 웹 FAQ로 안전하게 폴백한다.
  }
  return "web";
};
const getServerPlatformSnapshot = (): FaqPlatform => "web";

export default function FaqCard() {
  const devicePlatform = useSyncExternalStore(
    subscribeToPlatform,
    getPlatformSnapshot,
    getServerPlatformSnapshot,
  );
  const [isExpanded, setIsExpanded] = useState(false);
  const [openQuestion, setOpenQuestion] = useState<string | null>(null);
  const items = FAQ_ITEMS[devicePlatform];

  const toggleFaq = () => {
    if (isExpanded) setOpenQuestion(null);
    setIsExpanded(!isExpanded);
  };

  return (
    <GlassCard className="overflow-hidden !p-0">
      <button
        type="button"
        className="flex min-h-12 w-full items-center justify-between gap-3 px-4 text-left"
        aria-expanded={isExpanded}
        aria-controls="faq-question-list"
        onClick={toggleFaq}
      >
        <div className="flex items-center gap-3">
          <CircleHelp size={20} className="shrink-0 text-text-secondary" />
          <h2 className="text-base font-semibold text-text-primary">자주 묻는 질문 (FAQ)</h2>
        </div>
        <ChevronDown
          size={20}
          className={`shrink-0 text-text-tertiary transition-transform ${isExpanded ? "rotate-180" : ""}`}
        />
      </button>

      {isExpanded && (
        <div id="faq-question-list" className="divide-y divide-white/10 border-t border-white/10">
          {items.map(({ question, answer }, index) => {
            const isOpen = openQuestion === question;
            const answerId = `faq-answer-${index}`;

            return (
              <div key={question}>
                <button
                  type="button"
                  className="flex min-h-11 w-full items-center justify-between gap-3 px-4 py-3 text-left"
                  aria-expanded={isOpen}
                  aria-controls={answerId}
                  onClick={() => setOpenQuestion(isOpen ? null : question)}
                >
                  <span className="text-sm font-medium text-text-primary">{question}</span>
                  <ChevronDown
                    size={18}
                    className={`shrink-0 text-text-tertiary transition-transform ${isOpen ? "rotate-180" : ""}`}
                  />
                </button>
                {isOpen && (
                  <p id={answerId} className="px-4 pb-3 pr-10 text-sm leading-5 text-text-secondary">
                    {answer}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </GlassCard>
  );
}
