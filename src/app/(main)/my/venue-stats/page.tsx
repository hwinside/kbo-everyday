"use client";

import Link from "next/link";
import VenueStatsDashboard from "@/components/my/VenueStatsDashboard";
import { useAuth } from "@/lib/supabase/AuthContext";

/**
 * 직관 통계(직관 요정 지수) — 일반 공개.
 *
 * 관리자 전용(`AdminOnly`) 으로 실환경 QA 를 마친 뒤 래퍼를 벗겼다.
 * 데이터 자체는 이전부터 소유자 인증 API(`/api/me/venue-stats`) 가 본인 것만
 * 내려주므로, 이 변경은 표시 게이트만 열고 서버 인가는 그대로다.
 */
export default function VenueStatsPage() {
  const { user, loading } = useAuth();

  if (loading) {
    return <div className="min-h-screen bg-[#100b0e]" aria-label="로그인 상태 확인 중" />;
  }

  if (!user) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#100b0e] px-5 text-center">
        <div data-testid="venue-stats-login-required" className="w-full max-w-sm rounded-3xl border border-white/10 bg-white/5 p-7">
          <p className="text-lg font-extrabold text-white">로그인이 필요해요</p>
          <p className="mt-2 text-sm leading-6 text-white/60">내 직관 기록으로 만든 통계는 로그인 후 볼 수 있어요.</p>
          <Link href="/my" className="mt-5 inline-flex min-h-11 items-center justify-center rounded-full bg-accent px-6 text-sm font-bold text-white">
            마이페이지에서 로그인하기
          </Link>
        </div>
      </main>
    );
  }

  return <VenueStatsDashboard />;
}
