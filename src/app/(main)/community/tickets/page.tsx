"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { X, Ticket } from "lucide-react";
import TicketTab from "@/components/stadium/TicketTab";
import { STADIUMS } from "@/lib/constants/stadiums";
import { TEAMS } from "@/lib/constants/teams";

export default function TicketBoardPage() {
  const router = useRouter();
  const [venue, setVenue] = useState<string | null>(null);

  useEffect(() => {
    const v =
      typeof window !== "undefined"
        ? new URLSearchParams(window.location.search).get("venue")
        : null;
    setVenue(v);
  }, []);

  const stadium = useMemo(() => {
    if (!venue) return null;
    return STADIUMS.find((s) => s.id === venue) || null;
  }, [venue]);

  const venueId = stadium ? stadium.id : "all";
  const teamIds = stadium ? stadium.teamIds : TEAMS.map((t) => t.id);

  return (
    <div className="mx-auto max-w-lg pb-24 overflow-x-hidden">
      {/* Info banner */}
      <div className="mx-5 mt-4 mb-4">
        <div className="flex items-center gap-3 rounded-2xl bg-accent/10 p-4">
          <Ticket size={20} className="text-accent flex-shrink-0" />
          <p className="text-sm text-text-secondary">
            티켓을 양도하거나 구하는 게시판입니다. 직거래 시 주의하세요!
          </p>
        </div>

        {stadium && (
          <div className="mt-3 flex items-center gap-2">
            <div className="inline-flex items-center gap-2 rounded-full bg-bg-tertiary px-3 py-1.5 text-xs text-text-secondary">
              <span className="font-semibold text-text-primary">{stadium.name}</span>
              <span className="text-text-tertiary">필터 적용됨</span>
              <button
                onClick={() => {
                  setVenue(null);
                  if (typeof window !== "undefined") {
                    window.history.replaceState({}, "", "/community/tickets");
                  }
                  router.replace("/community/tickets");
                }}
                className="ml-1 rounded-full p-1 hover:bg-white/10"
                aria-label="필터 해제"
              >
                <X size={14} />
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="mx-5">
        <TicketTab venueId={venueId} teamIds={teamIds} />
      </div>
    </div>
  );
}
