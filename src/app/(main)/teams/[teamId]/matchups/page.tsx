"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import { getTeamBySlug, getTeamBgColor } from "@/lib/constants/teams";
import TeamLogo from "@/components/ui/TeamLogo";

interface OpponentRecord {
  slug: string;
  name: string;
  shortName: string;
  wins: number;
  losses: number;
  draws: number;
  winPct: number;
}

interface MatchupsData {
  team: string;
  season: number;
  total: { wins: number; losses: number; draws: number; winRate: number };
  opponents: OpponentRecord[];
}

export default function TeamMatchupsPage() {
  const params = useParams();
  const teamSlug = params.teamId as string;
  const team = getTeamBySlug(teamSlug);
  const [data, setData] = useState<MatchupsData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!team) return;
    fetch(`/api/team-matchups?team=${team.slug}&season=2026`)
      .then((r) => r.json())
      .then((d) => setData(d))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [team]);

  if (!team) {
    return (
      <div className="flex items-center justify-center py-40 text-text-tertiary">
        존재하지 않는 구단입니다
      </div>
    );
  }

  const teamColor = getTeamBgColor(team);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-40 text-text-tertiary text-sm">
        로딩 중...
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg pb-24">
      <header className="px-5 py-4">
        <h1 className="text-lg font-bold text-text-primary">
          {team.shortName} 상대 전적
        </h1>
      </header>

      {/* Season total */}
      {data?.total && (
        <div
          className="mx-5 mb-4 rounded-2xl p-4 flex items-center justify-center gap-4"
          style={{ backgroundColor: `${teamColor}15` }}
        >
          <TeamLogo team={team} size={40} />
          <div className="text-center">
            <p className="text-lg font-black text-text-primary tabular-nums">
              {data.total.wins}승 {data.total.losses}패
              {data.total.draws > 0 ? ` ${data.total.draws}무` : ""}
            </p>
            <p className="text-xs text-text-tertiary">
              승률 {data.total.winRate.toFixed(3)}
            </p>
          </div>
        </div>
      )}

      {/* Opponent list */}
      <div className="px-5 space-y-2">
        {data?.opponents.map((opp) => {
          const oppTeam = getTeamBySlug(opp.slug);
          const played = opp.wins + opp.losses;
          const barPct = played > 0 ? opp.winPct * 100 : 50;

          let barColor = teamColor;
          if (opp.winPct >= 0.6) barColor = "#22c55e"; // green
          else if (opp.winPct <= 0.4 && played > 0) barColor = "#737373"; // gray

          return (
            <div
              key={opp.slug}
              className="flex items-center gap-3 rounded-xl bg-bg-glass/60 p-3"
            >
              {oppTeam && <TeamLogo team={oppTeam} size={28} />}
              <span className="w-14 text-sm font-medium text-text-primary truncate">
                {opp.shortName || opp.name}
              </span>
              <div className="flex-1 h-2 rounded-full bg-bg-tertiary/50 overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{ width: `${barPct}%`, backgroundColor: barColor }}
                />
              </div>
              <span className="text-sm font-bold text-text-primary tabular-nums w-20 text-right">
                {opp.wins}-{opp.losses}
                {opp.draws > 0 ? `-${opp.draws}` : ""}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
