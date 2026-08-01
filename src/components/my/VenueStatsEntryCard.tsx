"use client";

import Link from "next/link";
import { BarChart3, ChevronRight } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";
import { useAuth } from "@/lib/supabase/AuthContext";

export default function VenueStatsEntryCard() {
  const { user, loading } = useAuth();

  if (loading || !user) return null;

  return (
    <Link href="/my/venue-stats" data-testid="venue-stats-entry" className="mt-3 block">
      <GlassCard pressable className="flex w-full items-center justify-between p-4 text-left">
        <span className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[#ff5263]/15 text-[#ff6574]">
            <BarChart3 size={19} />
          </span>
          <span>
            <span className="block text-[14px] font-extrabold text-text-primary">내 직관 통계 보기</span>
            <span className="mt-0.5 block text-[11px] font-semibold text-text-tertiary">
              요정 지수 · 팀 부스트 · 최애 활약
            </span>
          </span>
        </span>
        <ChevronRight size={18} className="text-text-tertiary" />
      </GlassCard>
    </Link>
  );
}
