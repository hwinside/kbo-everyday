"use client";

import { Eye } from "lucide-react";
import AdminOnly from "@/components/admin/AdminOnly";

/**
 * 게시글 조회수 배지 — 관리자(ADMIN_EMAILS)에게만 노출.
 * click = 상세 진입 누적, impression = 피드 노출(카드 세로 50%+) 누적.
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
  const clicks = clickCount ?? 0;
  const impressions = impressionCount ?? 0;
  return (
    <AdminOnly>
      <span
        className={`inline-flex items-center gap-1 text-xs text-text-tertiary ${className ?? ""}`}
        title="관리자 전용 · 클릭(상세 진입) · 노출(피드 50%+)"
      >
        <Eye size={13} />
        <span>클릭 {clicks.toLocaleString()} · 노출 {impressions.toLocaleString()}</span>
      </span>
    </AdminOnly>
  );
}
