"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import { useSafeBack } from "@/lib/hooks/useSafeBack";
import { ChevronLeft } from "lucide-react";
import { getTeamBySlug } from "@/lib/constants/teams";
import HeaderProfileLink from "@/components/ui/HeaderProfileLink";
import TeamHero from "@/components/team/TeamHero";
import TeamSwitcher from "@/components/team/TeamSwitcher";
import TeamMenu from "@/components/team/TeamMenu";
import NextGameBanner from "@/components/team/NextGameBanner";
import TeamNextTicketCard from "@/components/team/TeamNextTicketCard";
import TeamRosterMovesCard from "@/components/team/TeamRosterMovesCard";
import { STADIUMS } from "@/lib/constants/stadiums";
import { getTeamBorderColorById } from "@/lib/utils/team-border-color";

interface StandingData {
  rank: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: string;
  streak: string;
  gb: string;
}

export default function TeamHubPage() {
  const params = useParams();
  const teamSlug = params.teamId as string;
  const goBack = useSafeBack("/teams");
  const team = getTeamBySlug(teamSlug);
  const [standings, setStandings] = useState<StandingData | undefined>();

  const stadium = team
    ? STADIUMS.find((s) => s.teamIds.includes(team.id))
    : undefined;

  useEffect(() => {
    if (!team) return;
    fetch("/api/standings")
      .then((r) => r.json())
      .then((data) => {
        const s = data.standings?.find(
          (st: { teamId: number }) => st.teamId === team.id
        );
        if (s) {
          setStandings({
            rank: data.standings.indexOf(s) + 1,
            wins: s.wins,
            losses: s.losses,
            draws: s.draws,
            winRate: s.winRate?.toFixed(3) ?? ".000",
            streak: s.continuousGameResult ?? "-",
            gb: s.gamesBehind === 0 ? "-" : String(s.gamesBehind),
          });
        }
      })
      .catch(() => {});
  }, [team]);

  if (!team) {
    return (
      <div className="flex items-center justify-center py-40 text-text-tertiary">
        존재하지 않는 구단입니다
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg pb-24">
      <div
        className="sticky top-0 z-30 border-b px-5 bg-bg-primary"
        style={{ borderColor: getTeamBorderColorById(team.id), paddingTop: "env(safe-area-inset-top, 0px)", marginTop: "calc(env(safe-area-inset-top, 0px) * -1)" }}
      >
        <header className="flex items-center gap-3 py-3">
          <button
            onClick={goBack}
            className="rounded-full p-1 text-text-secondary transition-colors hover:bg-bg-tertiary"
            aria-label="뒤로 가기"
          >
            <ChevronLeft size={24} />
          </button>
          <h1 className="flex-1 text-2xl font-bold tracking-tight text-text-primary">팀</h1>
          <HeaderProfileLink />
        </header>
      </div>
      <TeamSwitcher currentTeam={team} />
      <TeamHero
        team={team}
        standings={standings}
        stadiumName={stadium?.name}
      />
      <TeamMenu team={team} />
      <NextGameBanner team={team} />
      <TeamNextTicketCard team={team} />
      <TeamRosterMovesCard team={team} />
    </div>
  );
}
