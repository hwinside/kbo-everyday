"use client";

import { useState, useEffect, useCallback } from "react";
import { LayoutGrid, ChevronDown, ChevronUp } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";
import { isNative, isAndroid } from "@/lib/capacitor/platform";
import { getWidgetTapMode, setWidgetTapMode, type WidgetTapMode } from "@/lib/capacitor/game-notification";

/**
 * 마이페이지 > 위젯 탭 동작 — 홈 위젯을 탭했을 때 앱을 열지, 위젯만 최신 상태로 다시 표시할지
 * 2택(디바이스 로컬). 안드로이드 네이티브 전용 — iOS/웹엔 이 위젯 탭 모드 개념이 없다.
 * 초기값은 getWidgetTapMode로 로드(구빌드 메서드 부재 시 'open').
 */
export default function WidgetTapModeCard() {
  const [expanded, setExpanded] = useState(false);
  const [mode, setMode] = useState<WidgetTapMode>("open");

  // 펼칠 때 현재 저장된 모드 로드(안드만 — 브릿지 실패 시 'open' 유지).
  useEffect(() => {
    if (!expanded || !isAndroid) return;
    let cancelled = false;
    void (async () => {
      const m = await getWidgetTapMode();
      if (!cancelled) setMode(m);
    })();
    return () => { cancelled = true; };
  }, [expanded]);

  const choose = useCallback(async (next: WidgetTapMode) => {
    if (next === mode) return;
    setMode(next);
    await setWidgetTapMode(next);
  }, [mode]);

  // 안드로이드 네이티브 전용 — iOS/웹엔 노출하지 않는다.
  if (!isNative || !isAndroid) return null;

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
            aria-pressed={mode === "refresh"}
            className={`rounded-xl border px-3 py-3 text-left transition-colors ${mode === "refresh" ? "border-accent bg-accent/10" : "border-white/10 bg-bg-tertiary"}`}
          >
            <span className={`text-sm font-medium ${mode === "refresh" ? "text-accent" : "text-text-primary"}`}>새로고침만</span>
            <p className="text-xs text-text-tertiary mt-0.5">앱을 열지 않고 위젯을 최신 상태로 다시 표시</p>
          </button>
        </div>
      )}
    </GlassCard>
  );
}
