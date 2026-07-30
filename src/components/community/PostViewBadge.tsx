"use client";

import { Eye } from "lucide-react";
import { postViewTotal } from "@/lib/community/view-tracker-policy";

/**
 * 게시글 조회수 배지 — 기존 관리자 전용이던 click + impression 합산 단일값을
 * 그대로 전체 유저(비로그인 포함)에게 공개한다. 원본 집계는 분리 유지.
 */
export default function PostViewBadge({
  clickCount,
  impressionCount,
  className,
}: {
  clickCount?: number | null;
  impressionCount?: number | null;
  className?: string;
}) {
  const total = postViewTotal(clickCount, impressionCount);
  return (
    <span
      className={`inline-flex items-center gap-1 text-sm text-text-tertiary ${className ?? ""}`}
      title="조회수"
    >
      <Eye size={14} />
      <span>{total.toLocaleString()}</span>
    </span>
  );
}
