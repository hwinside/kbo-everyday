"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import HeaderProfileLink from "@/components/ui/HeaderProfileLink";
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
  const router = useRouter();
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
      <div className="sticky top-0 z-30 border-b border-border bg-bg-primary" style={{ paddingTop: "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))", marginTop: "calc(var(--safe-area-inset-top, env(safe-area-inset-top, 0px)) * -1)" }}>
      <header className="flex items-center gap-2 px-5 min-h-[44px]">
        <button onClick={() => { if (window.history.length > 1) router.back(); else router.push(`/teams/${teamSlug}`); }} aria-label="뒤로가기" className="flex h-11 w-11 items-center justify-center rounded-full text-text-secondary hover:bg-bg-tertiary transition-colors">
          <ChevronLeft size={24} />
        </button>
        <h1 className="truncate text-lg font-bold text-text-primary flex-1">
          {team.shortName} 상대 전적
        </h1>
        <HeaderProfileLink />
      </header>
      </div>

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

          let barPct: number;
          let barColor: string;
          if (played === 0) {
            barPct = 0;
            barColor = "#737373";
          } else if (opp.winPct > 0.5) {
            barPct = opp.winPct * 100;
            barColor = "#22c55e";
          } else if (opp.winPct < 0.5) {
            barPct = (1 - opp.winPct) * 100;
            barColor = "#ef4444";
          } else {
            barPct = 50;
            barColor = "#737373";
          }

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
              <div className="text-right w-20">
                <span className="text-sm font-bold text-text-primary tabular-nums">
                  {opp.wins}-{opp.losses}
                  {opp.draws > 0 ? `-${opp.draws}` : ""}
                </span>
                <span className="block text-xs text-text-tertiary tabular-nums">
                  {played > 0 ? opp.winPct.toFixed(3) : "-"}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
