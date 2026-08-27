"use client";

import { ChevronLeft } from "lucide-react";
import HeaderProfileLink from "@/components/ui/HeaderProfileLink";
import { useParams, useRouter } from "next/navigation";
import { getTeamBySlug } from "@/lib/constants/teams";
import RecordRoom from "@/components/players/RecordRoom";

/* 팀 선수 기록 — RecordRoom을 해당 팀 스코프로 마운트 (스탯 클릭 시 팀 내 정렬).
 * 팀 페이지 '선수 기록' 메뉴 진입. 팀 누적 기록은 '팀 기록'(records) 별도 페이지. */
export default function TeamPlayerRecordsPage() {
  const params = useParams();
  const router = useRouter();
  const teamSlug = params.teamId as string;
  const team = getTeamBySlug(teamSlug);

  if (!team) {
    return (
      <div className="flex items-center justify-center py-40 text-text-tertiary">
        존재하지 않는 구단입니다
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg px-5 pb-24">
      <div className="sticky top-0 z-30 border-b -mx-5 px-5 bg-bg-primary" style={{ borderColor: "var(--color-border)", paddingTop: "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))", marginTop: "calc(var(--safe-area-inset-top, env(safe-area-inset-top, 0px)) * -1)" }}>
        <header className="min-h-[44px] flex items-center gap-2">
          <button
            onClick={() => { if (window.history.length > 1) router.back(); else router.push(`/teams/${teamSlug}`); }}
            aria-label="뒤로가기" className="flex h-11 w-11 items-center justify-center rounded-full text-text-secondary hover:bg-bg-tertiary transition-colors"
          >
            <ChevronLeft size={24} />
          </button>
          <h1 className="truncate text-lg font-bold text-text-primary flex-1">{team.shortName} 선수 기록</h1>
          <HeaderProfileLink />
        </header>
      </div>

      <p className="mt-2 mb-3 text-xs text-text-tertiary">
        기록을 선택하면 그 순으로 정렬됩니다 · {team.shortName} 선수
      </p>

      <RecordRoom scopeTeamId={team.id} />
    </div>
  );
}
