"use client";

import { useState, useEffect, useCallback } from "react";
import { LayoutGrid, ChevronDown, ChevronUp } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";
import { isNativeRuntime } from "@/lib/capacitor/platform";
import { getWidgetTapMode, setWidgetTapMode, type WidgetTapMode } from "@/lib/capacitor/game-notification";

/**
 * 마이페이지 > 위젯 탭 동작 — 홈 위젯을 탭했을 때 앱을 열지, 위젯만 최신 상태로 다시 표시할지
 * 2택(디바이스 로컬). 안드로이드/iOS 네이티브 전용 — 웹엔 이 위젯 탭 모드 개념이 없다.
 * iOS의 '새로고침만'은 위젯 새로고침 인텐트(iOS 17+)라, refreshSupported=false(iOS16 이하)면
 * 해당 옵션을 비활성+안내한다. 초기값은 getWidgetTapMode로 로드(구빌드 메서드 부재 시 'open').
 */
export default function WidgetTapModeCard() {
  const [expanded, setExpanded] = useState(false);
  const [mode, setMode] = useState<WidgetTapMode>("open");
  const [refreshSupported, setRefreshSupported] = useState(true);

  // 펼칠 때 현재 저장된 모드 로드(안드/iOS — 브릿지 실패 시 'open' 유지).
  useEffect(() => {
    if (!expanded || !isNativeRuntime()) return;
    let cancelled = false;
    void (async () => {
      const s = await getWidgetTapMode();
      if (!cancelled) {
        setMode(s.mode);
        setRefreshSupported(s.refreshSupported);
      }
    })();
    return () => { cancelled = true; };
  }, [expanded]);

  const choose = useCallback(async (next: WidgetTapMode) => {
    if (next === mode) return;
    if (next === "refresh" && !refreshSupported) return; // 미지원 옵션 방어
    const prev = mode;
    setMode(next); // 낙관적 반영
    const ok = await setWidgetTapMode(next);
    if (!ok) setMode(prev); // 저장 실패(구빌드/브릿지) → 이전 선택 롤백(삼순 ④)
  }, [mode, refreshSupported]);

  // 안드로이드/iOS 네이티브 전용 — 웹엔 노출하지 않는다(원격 로드 런타임 판정, 삼순 #833).
  if (!isNativeRuntime()) return null;

  return (
    <GlassCard className="p-5">
      <button className="w-full flex items-center justify-between" onClick={() => setExpanded(!expanded)}>
        <div className="flex items-center gap-4">
          <LayoutGrid size={22} className="text-text-secondary" />
          <div className="text-left">
            <span className="text-base text-text-primary">위젯 탭 동작</span>
            <p className="text-xs text-text-tertiary mt-0.5">홈 위젯을 탭했을 때 동작을 선택하세요</p>
          </div>
        </div>
        {expanded ? <ChevronUp size={20} className="text-text-tertiary" /> : <ChevronDown size={20} className="text-text-tertiary" />}
      </button>

      {expanded && (
        <div className="mt-4 grid grid-cols-2 gap-2">
          <button
            onClick={() => void choose("open")}
            aria-pressed={mode === "open"}
            className={`rounded-xl border px-3 py-3 text-left transition-colors ${mode === "open" ? "border-accent bg-accent/10" : "border-white/10 bg-bg-tertiary"}`}
          >
            <span className={`text-sm font-medium ${mode === "open" ? "text-accent" : "text-text-primary"}`}>앱 열기</span>
            <p className="text-xs text-text-tertiary mt-0.5">탭하면 앱을 실행 (기본)</p>
          </button>
          <button
            onClick={() => void choose("refresh")}
            disabled={!refreshSupported}
            aria-pressed={mode === "refresh"}
            className={`rounded-xl border px-3 py-3 text-left transition-colors ${
              !refreshSupported
                ? "border-white/10 bg-bg-tertiary opacity-50 cursor-not-allowed"
                : mode === "refresh" ? "border-accent bg-accent/10" : "border-white/10 bg-bg-tertiary"
            }`}
          >
            <span className={`text-sm font-medium ${mode === "refresh" && refreshSupported ? "text-accent" : "text-text-primary"}`}>새로고침만</span>
            <p className="text-xs text-text-tertiary mt-0.5">
              {refreshSupported ? "앱을 열지 않고 위젯을 최신 상태로 다시 표시" : "iOS 17 이상에서 지원"}
            </p>
          </button>
        </div>
      )}
    </GlassCard>
  );
}
