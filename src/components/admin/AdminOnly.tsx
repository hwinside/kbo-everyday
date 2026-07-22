"use client";

import type { ReactNode } from "react";
import { useIsAdmin } from "@/hooks/useIsAdmin";

/**
 * 관리자(ADMIN_EMAILS)에게만 children을 렌더하는 공용 게이트.
 *
 * 용도:
 *  - 조회수 배지처럼 운영자 전용 지표 노출
 *  - WIP 기능(직관 스토리 등)을 prod 배포하되 관리자에게만 보여 실환경 QA
 *    → 검증되면 <AdminOnly> 래퍼만 벗겨 전체 롤아웃
 *
 * 비관리자에겐 fallback(기본 null)을 렌더. 표시 게이트일 뿐이며,
 * 파괴적/권한 작업의 서버 인가를 대체하지 않는다.
 */
export default function AdminOnly({
  children,
  fallback = null,
}: {
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const isAdmin = useIsAdmin();
  return <>{isAdmin ? children : fallback}</>;
}
