"use client";

import { Eye } from "lucide-react";
import AdminOnly from "@/components/admin/AdminOnly";

/**
 * 콘텐츠(숏츠·뉴스) 조회수 배지 — 관리자(ADMIN_EMAILS)에게만 노출.
 * count가 undefined(미로드)면 렌더하지 않는다. PostViewBadge와 동일 축.
 */
export default function ContentViewBadge({
  count,
  className,
}: {
  count?: number;
  className?: string;
}) {
  if (count === undefined) return null;
  return (
    <AdminOnly>
      <span
        className={`inline-flex items-center gap-1 text-xs text-text-tertiary ${className ?? ""}`}
        title="관리자 전용 조회수"
      >
        <Eye size={13} />
        <span>{count.toLocaleString()}</span>
      </span>
    </AdminOnly>
  );
}
