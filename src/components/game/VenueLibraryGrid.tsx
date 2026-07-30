"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Play, Cloud } from "lucide-react";
import { mediaDurationBadge, VENUE_STORY_MAX_ITEMS } from "@/lib/venue-stories/multi-pick";
import type { VenueMediaAsset } from "@/lib/capacitor/venue-media-library";

// 이 파일은 프리뷰/그리드 표현 로직만 담아(capacitor/supabase/upload 미의존) 실제 컴포넌트
// 렌더 회귀(jsdom)로 "타일 탭 → 큰 프리뷰 즉시 갱신"을 고정할 수 있게 분리한다(삼순 라운드3 #1).

export function LibraryThumbnail({ asset }: { asset: VenueMediaAsset }) {
  const [loaded, setLoaded] = useState(false);
  // iCloud 전용 등 로컬 썸네일이 없는 asset — shimmer 영구 고착 대신 명시 상태(삼순 라운드2 #3).
  // 선택은 가능 — 원본은 export 단계에서 네트워크(isNetworkAccessAllowed=true)로 내려받는다.
  if (!asset.thumbnailUrl) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-bg-tertiary text-text-tertiary">
        <Cloud size={18} />
        <span className="text-[9px]">미리보기 없음</span>
      </div>
    );
  }
  return (
    <>
      <div
        aria-hidden
        className={`absolute inset-0 bg-gradient-to-br from-bg-tertiary via-bg-secondary to-bg-tertiary transition-opacity duration-200 ${
          loaded ? "opacity-0" : "animate-pulse opacity-100"
        }`}
      />
      {/* 네이티브가 내려준 작은 썸네일만 사용. lazy+async decode로 스크롤 메인 스레드 점유 최소화. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={asset.thumbnailUrl}
        alt=""
        loading="lazy"
        decoding="async"
        onLoad={() => setLoaded(true)}
        className={`w-full h-full object-cover transition-opacity duration-200 ease-out ${
          loaded ? "opacity-100" : "opacity-0"
        }`}
      />
    </>
  );
}

/**
 * 앱 내 커스텀 사진첩 그리드 — **타일 탭 한 번에 같은 화면의 큰 네이티브 썸네일 프리뷰가 즉시 바뀐다**
 * (삼순 라운드3 #1). 선택 순서(1→2→3) 배지는 부모가 소유한 selection 으로 그리고,
 * 프리뷰 포커스는 이 컴포넌트 내부 상태라 탭 즉시 export/bridge 왕복 0회로 DOM 이 갱신된다.
 */
export function VenueLibraryGrid({
  assets,
  selection,
  onToggle,
  accent,
  onAccent,
  maxItems = VENUE_STORY_MAX_ITEMS,
}: {
  assets: VenueMediaAsset[];
  /** 선택된 asset id — 선택 순서대로. */
  selection: string[];
  onToggle: (asset: VenueMediaAsset) => void;
  accent: string;
  onAccent: string;
  maxItems?: number;
}) {
  // 프리뷰 포커스 — 탭한 타일. 미탭 시 마지막 선택(없으면 첫 항목)을 기본 포커스로 보여준다.
  const [focusId, setFocusId] = useState<string | null>(null);
  const effectiveFocusId =
    focusId ?? selection[selection.length - 1] ?? assets[0]?.id ?? null;
  const focused = assets.find((a) => a.id === effectiveFocusId) ?? null;
  const focusBadge = focused ? mediaDurationBadge(focused.kind, focused.durationMs) : null;

  const handleTap = (asset: VenueMediaAsset) => {
    // 큰 프리뷰를 **먼저 즉시** 바꾼 뒤 선택 토글을 부모로 올린다(탭→프리뷰 P95 계약, #1).
    setFocusId(asset.id);
    onToggle(asset);
  };

  return (
    <>
      {/* 큰 네이티브 썸네일 프리뷰 — 타일 탭 즉시 갱신(같은 picker 화면 유지). */}
      <div
        data-testid="library-focus-preview"
        className="relative rounded-2xl overflow-hidden bg-black aspect-[9/16] max-h-[34dvh] flex items-center justify-center"
      >
        {focused?.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            data-testid="library-focus-image"
            src={focused.thumbnailUrl}
            alt=""
            decoding="async"
            className="w-full h-full object-contain"
          />
        ) : (
          <div
            data-testid="library-focus-empty"
            className="flex flex-col items-center gap-2 text-text-tertiary"
          >
            <Cloud size={22} />
            <span className="text-xs">{focused ? "미리보기 없음" : "사진을 눌러 미리보기"}</span>
          </div>
        )}
        {focused?.kind === "video" && (
          <Play size={22} className="absolute text-white/90 fill-white/90 drop-shadow" />
        )}
        {focusBadge && (
          <span className="absolute bottom-2 right-2 px-2 py-0.5 rounded-lg bg-black/60 text-white text-[11px] font-semibold">
            {focusBadge}
          </span>
        )}
      </div>

      {/* 앱 내 커스텀 그리드 — 최근순 사진+영상. 탭 = 프리뷰 즉시 갱신 + 선택/해제 토글. */}
      <div className="grid grid-cols-3 gap-0.5">
        {assets.map((asset) => {
          const displayIndex = selection.findIndex((id) => id === asset.id);
          const badge = mediaDurationBadge(asset.kind, asset.durationMs);
          const isFocused = asset.id === effectiveFocusId;
          return (
            <button
              key={asset.id}
              data-asset-id={asset.id}
              onClick={() => handleTap(asset)}
              disabled={displayIndex < 0 && selection.length >= maxItems}
              aria-pressed={displayIndex >= 0}
              className={`relative aspect-square min-h-11 overflow-hidden bg-bg-tertiary active:scale-[0.98] disabled:opacity-40 ${
                isFocused ? "ring-2 ring-inset" : ""
              }`}
              style={{ contentVisibility: "auto", ...(isFocused ? { boxShadow: `inset 0 0 0 2px ${accent}` } : {}) }}
            >
              <LibraryThumbnail asset={asset} />
              <AnimatePresence>
                {displayIndex >= 0 && (
                  <motion.span
                    key="selected"
                    initial={{ scale: 0.55, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0.55, opacity: 0 }}
                    transition={{ type: "spring", stiffness: 520, damping: 30 }}
                    className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full border border-white flex items-center justify-center text-[11px] font-bold"
                    style={{ background: accent, color: onAccent }}
                  >
                    {displayIndex + 1}
                  </motion.span>
                )}
              </AnimatePresence>
              {displayIndex < 0 && (
                <span className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full border border-white/90 bg-black/20" />
              )}
              {asset.kind === "video" && (
                <Play
                  size={13}
                  className="absolute bottom-1.5 left-1.5 text-white fill-white drop-shadow"
                />
              )}
              {badge && (
                <span className="absolute bottom-1.5 right-1.5 px-1.5 rounded-md bg-black/60 text-white text-[9px] font-semibold leading-4">
                  {badge}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </>
  );
}
