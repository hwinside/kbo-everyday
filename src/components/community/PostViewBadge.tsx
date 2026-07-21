"use client";

import { Eye } from "lucide-react";
import AdminOnly from "@/components/admin/AdminOnly";
import { postViewTotal } from "@/lib/community/view-tracker-policy";

/**
 * 게시글 조회수 배지 — 관리자(ADMIN_EMAILS)에게만 노출.
 * 화면에는 click + impression 합산값만 표시하고, 원본 집계는 분리 유지한다.
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
    <AdminOnly>
      <span
        className={`inline-flex items-center gap-1 text-xs text-text-tertiary ${className ?? ""}`}
        title="관리자 전용 조회수"
      >
        <Eye size={13} />
        <span>{total.toLocaleString()}</span>
      </span>
    </AdminOnly>
  );
}
