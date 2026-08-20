"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

/**
 * 댓글 이미지 전체화면 라이트박스.
 * - 댓글 썸네일(max 220px) 탭 → 화면 전체로 확대해서 보기 (#cs 하린아빠 요청)
 * - body 포털 렌더: 댓글시트가 zIndex 9999 포털이라 그 위(10000)에 떠야 함
 *   (fixed 오버레이는 transform 조상에 갇히지 않게 body 포털 — reference_fixed_overlay_needs_body_portal)
 * - 배경 탭/X/Escape 로 닫기, 열려있는 동안 뒤 스크롤 전파 차단
 */
export default function CommentImageLightbox({ src, onClose }: {
  src: string | null;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!src) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [src, onClose]);

  if (!src || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 bg-black/90 flex items-center justify-center"
      style={{ zIndex: 10000, touchAction: "none", overscrollBehavior: "none" }}
      onClick={onClose}
      onTouchMove={(e) => { if (e.cancelable) e.preventDefault(); }}
      role="dialog"
      aria-modal="true"
      aria-label="댓글 이미지 확대 보기"
    >
      <button
        onClick={onClose}
        className="absolute top-0 right-0 p-4 text-white/80"
        style={{ paddingTop: "calc(var(--safe-area-inset-top, env(safe-area-inset-top, 0px)) + 12px)" }}
        aria-label="닫기"
      >
        <X size={26} />
      </button>
      {/* 이미지 자체 탭은 닫힘 제외(배경 탭/X/Escape만 닫기) — 오버레이 onClick으로 버블링 차단 (삼순 리뷰 #678) */}
      <img
        src={src}
        alt="댓글 이미지"
        className="max-w-full max-h-full object-contain select-none"
        style={{ WebkitTouchCallout: "none" } as React.CSSProperties}
        onClick={(e) => e.stopPropagation()}
      />
    </div>,
    document.body
  );
}
