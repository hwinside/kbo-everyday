"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import {
  shouldShowLaUpdateNudge,
  LA_NUDGE_DISMISS_KEY,
} from "@/lib/notifications/la-nudge-policy";

// ② 구버전(build15 이하 = broadcast 채널 미지원) iOS 앱 업데이트 넛지 — 라이브 경기
// 페이지에서만, 세션당 1회. 네이티브 코드 변경 없이 웹 레이어에서 판별한다:
// - platform: 주입 브릿지(window.Capacitor) 우선 — 원격 로드(server.url) 앱에서 npm
//   @capacitor/core가 'web'으로 오판하는 케이스 우회(native-app-review.ts와 동일 패턴).
// - appBuild: 주입 브릿지 App.getInfo() (native-live-activity.ts getAppBuild와 동일 패턴).
//   미보고(null)면 구버전 확증이 없어 노출 안 함(la-nudge-policy, 보수적).

interface InjectedCapacitor {
  getPlatform?: () => string;
  Plugins?: {
    App?: { getInfo?: () => Promise<{ build?: string }> };
  };
}

function getInjectedCapacitor(): InjectedCapacitor | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { Capacitor?: InjectedCapacitor }).Capacitor;
}

async function detectIosAppBuild(): Promise<{ platform: string | null; appBuild: number | null }> {
  let platform: string | null = null;
  const injected = getInjectedCapacitor();
  try {
    platform = injected?.getPlatform?.() ?? null;
  } catch {
    /* 무시 */
  }
  if (platform === null) {
    try {
      const { Capacitor } = await import("@capacitor/core");
      const p = Capacitor.getPlatform?.();
      if (p === "ios" || p === "android") platform = p;
    } catch {
      /* core 로드 실패 무시 */
    }
  }
  let appBuild: number | null = null;
  try {
    const info = await injected?.Plugins?.App?.getInfo?.();
    const n = info?.build ? parseInt(info.build, 10) : NaN;
    appBuild = Number.isFinite(n) ? n : null;
  } catch {
    appBuild = null;
  }
  return { platform, appBuild };
}

export default function LiveActivityUpdateNudge({ isLive }: { isLive: boolean }) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!isLive) return; // 숨김은 렌더 가드(아래 !isLive)가 담당 — effect 내 동기 setState 금지(lint).
    let cancelled = false;
    (async () => {
      let dismissed = false;
      try {
        dismissed = sessionStorage.getItem(LA_NUDGE_DISMISS_KEY) === "1";
      } catch {
        /* sessionStorage 불가 환경 → 미저장 취급 */
      }
      if (dismissed) return;
      const { platform, appBuild } = await detectIosAppBuild();
      if (cancelled) return;
      setShow(shouldShowLaUpdateNudge({ platform, appBuild, isLive: true, dismissed }));
    })();
    return () => {
      cancelled = true;
    };
  }, [isLive]);

  // live → final/취소 전환 시 즉시 숨김 — 종전에는 effect early return뿐이라 띄워둔
  // 배너가 잔존했다(삼순 재현 2026-07-23: status=final 전환 후 배너 1건 유지 = 계약 위반).
  // 렌더 가드라 전환 프레임부터 동기적으로 0건 보장(재라이브 시엔 effect가 재판정).
  if (!show || !isLive) return null;

  const dismiss = () => {
    setShow(false);
    try {
      sessionStorage.setItem(LA_NUDGE_DISMISS_KEY, "1");
    } catch {
      /* 저장 실패해도 이번 렌더에선 닫힘 */
    }
  };

  return (
    <div className="mx-5 mt-2 flex items-center gap-3 rounded-xl border border-border bg-bg-secondary px-4 py-3">
      <span className="text-base" aria-hidden>⚾</span>
      <p className="flex-1 text-sm text-text-primary">
        앱을 업데이트하면 잠금화면 실시간 점수 갱신이 안정화돼요
      </p>
      {/* hit target ≥44×44px(iOS HIG) — 음수 마진으로 시각 레이아웃은 종전 크기 유지 */}
      <button
        onClick={dismiss}
        aria-label="닫기"
        className="-my-2.5 -mr-3 flex h-11 w-11 shrink-0 items-center justify-center text-text-tertiary active:opacity-60"
      >
        <X size={16} />
      </button>
    </div>
  );
}
