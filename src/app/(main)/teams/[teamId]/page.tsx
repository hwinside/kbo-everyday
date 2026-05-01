"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import { getTeamBySlug } from "@/lib/constants/teams";
import TeamHero from "@/components/team/TeamHero";
import TeamSwitcher from "@/components/team/TeamSwitcher";
import TeamMenu from "@/components/team/TeamMenu";
import NextGameBanner from "@/components/team/NextGameBanner";
import { STADIUMS } from "@/lib/constants/stadiums";

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
      <TeamSwitcher currentTeam={team} />
      <TeamHero
        team={team}
        standings={standings}
        stadiumName={stadium?.name}
      />
      <TeamMenu team={team} />
      <NextGameBanner team={team} />
    </div>
  );
}
