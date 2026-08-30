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
  // 팀 허브 direct-entry 뒤로가기 fallback은 홈("/")으로.
  // /teams로 보내면 로그인+team_id 사용자의 useEffect가 /teams/{myTeam}로 replace해
  // 같은 팀 허브로 되돌아오는 loop가 생기므로 홈으로 고정한다.
  const goBack = useSafeBack("/");
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
        style={{ borderColor: getTeamBorderColorById(team.id), paddingTop: "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))", marginTop: "calc(var(--safe-area-inset-top, env(safe-area-inset-top, 0px)) * -1)" }}
      >
        <header className="flex items-center gap-3 min-h-[44px]">
          <button
            onClick={goBack}
            className="flex h-11 w-11 items-center justify-center rounded-full text-text-secondary transition-colors hover:bg-bg-tertiary"
            aria-label="뒤로 가기"
          >
            <ChevronLeft size={24} />
          </button>
          <h1 className="flex-1 truncate text-lg font-bold tracking-tight text-text-primary">팀</h1>
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
