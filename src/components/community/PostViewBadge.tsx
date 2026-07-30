"use client";

import { Eye } from "lucide-react";
import AdminOnly from "@/components/admin/AdminOnly";

/**
 * 게시글 조회수 배지 — 클릭 수는 전체 유저(비로그인 포함) 공개,
 * 노출수(impression)는 관리자(ADMIN_EMAILS) 전용으로만 덧붙인다.
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
  return (
    <span
      className={`inline-flex items-center gap-1 text-sm text-text-tertiary ${className ?? ""}`}
      title="조회수"
    >
      <Eye size={14} />
      <span>{(clickCount ?? 0).toLocaleString()}</span>
      <AdminOnly>
        <span title="노출수 (관리자 전용)">· {(impressionCount ?? 0).toLocaleString()}</span>
      </AdminOnly>
    </span>
  );
}
