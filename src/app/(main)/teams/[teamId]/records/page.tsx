"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { ChevronLeft, ChevronDown } from "lucide-react";
import HeaderProfileLink from "@/components/ui/HeaderProfileLink";
import { getTeamBySlug, getTeamBgColor } from "@/lib/constants/teams";
import TeamLogo from "@/components/ui/TeamLogo";
import {
  fetchTeamRecordsForDisplay,
  type RecordsData,
} from "@/lib/team-records/client";

interface RankedTeam {
  slug: string;
  value: string | number;
}

function StatBar({
  label,
  value,
  rank,
  total,
  teamColor,
  expanded,
  onClick,
  allTeams,
  mySlug,
}: {
  label: string;
  value: string | number;
  rank: number;
  total: number;
  teamColor: string;
  expanded: boolean;
  onClick: () => void;
  allTeams: RankedTeam[];
  mySlug: string;
}) {
  const pct = total > 0 ? ((total - rank + 1) / total) * 100 : 0;
  return (
    <div>
      <button onClick={onClick} className="flex items-center gap-3 py-2 w-full text-left cursor-pointer group">
        <span className="w-12 text-xs text-text-tertiary shrink-0">{label}</span>
        <div className="flex-1 h-2 rounded-full bg-bg-tertiary/50 overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{ width: `${pct}%`, backgroundColor: teamColor }}
          />
        </div>
        <span className="w-14 text-right text-sm font-bold text-text-primary tabular-nums">
          {value}
        </span>
        <span
          className="w-8 text-center text-xs font-bold rounded-full px-1.5 py-0.5"
          style={{
            backgroundColor: rank <= 3 ? `${teamColor}25` : "transparent",
            color: rank <= 3 ? teamColor : "var(--text-tertiary)",
          }}
        >
          {rank}위
        </span>
        <ChevronDown size={14} className={`text-text-tertiary transition-transform shrink-0 ${expanded ? "rotate-180" : ""}`} />
      </button>
      {expanded && (
        <div className="mb-2 rounded-xl bg-bg-glass/60 overflow-hidden">
          {allTeams.map((t, i) => {
            const isMe = t.slug === mySlug;
            const rowTeam = getTeamBySlug(t.slug);
            return (
              <div
                key={t.slug}
                className="flex items-center gap-3 px-3 py-1.5 text-sm"
                style={isMe ? { backgroundColor: `${teamColor}20` } : undefined}
              >
                <span className="w-5 text-xs text-text-tertiary text-right tabular-nums">{i + 1}</span>
                {rowTeam && <TeamLogo team={rowTeam} size={18} />}
                <span className={`flex-1 text-sm ${isMe ? "font-bold text-text-primary" : "text-text-secondary"}`}>
                  {rowTeam?.shortName || t.slug}
                </span>
                <span className={`tabular-nums text-sm ${isMe ? "font-bold text-text-primary" : "text-text-secondary"}`}>
                  {t.value}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function TeamRecordsPage() {
  const params = useParams();
  const router = useRouter();
  const teamSlug = params.teamId as string;
  const team = getTeamBySlug(teamSlug);
  const [data, setData] = useState<RecordsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedStat, setExpandedStat] = useState<string | null>(null);

  useEffect(() => {
    fetchTeamRecordsForDisplay()
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, []);

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

  if (!data) {
    return (
      <div className="flex items-center justify-center py-40 text-text-tertiary text-sm">
        기록 데이터를 불러올 수 없습니다
      </div>
    );
  }

  const myBatting = data.batting.find((b) => b.slug === teamSlug);
  const myPitching = data.pitching.find((p) => p.slug === teamSlug);

  function getSorted<T extends { slug: string }>(arr: T[], key: keyof T, desc = true): T[] {
    return [...arr].sort((a, b) => {
      const av = Number(a[key]);
      const bv = Number(b[key]);
      return desc ? bv - av : av - bv;
    });
  }

  function getRank<T extends { slug: string }>(arr: T[], key: keyof T, slug: string, desc = true): number {
    const sorted = getSorted(arr, key, desc);
    return sorted.findIndex((item) => item.slug === slug) + 1;
  }

  function getAllTeams<T extends { slug: string }>(arr: T[], key: keyof T, desc = true): RankedTeam[] {
    return getSorted(arr, key, desc).map((item) => ({
      slug: item.slug,
      value: item[key] as string | number,
    }));
  }

  const battingStats = myBatting
    ? [
        { label: "타율", value: myBatting.avg, rank: getRank(data.batting, "avg", teamSlug), allTeams: getAllTeams(data.batting, "avg") },
        { label: "OPS", value: myBatting.ops, rank: getRank(data.batting, "ops", teamSlug), allTeams: getAllTeams(data.batting, "ops") },
        { label: "홈런", value: myBatting.hr, rank: getRank(data.batting, "hr", teamSlug), allTeams: getAllTeams(data.batting, "hr") },
        { label: "득점", value: myBatting.runs, rank: getRank(data.batting, "runs", teamSlug), allTeams: getAllTeams(data.batting, "runs") },
        { label: "도루", value: myBatting.sb, rank: getRank(data.batting, "sb", teamSlug), allTeams: getAllTeams(data.batting, "sb") },
      ]
    : [];

  const pitchingStats = myPitching
    ? [
        { label: "ERA", value: myPitching.era, rank: getRank(data.pitching, "era", teamSlug, false), allTeams: getAllTeams(data.pitching, "era", false) },
        { label: "WHIP", value: myPitching.whip, rank: getRank(data.pitching, "whip", teamSlug, false), allTeams: getAllTeams(data.pitching, "whip", false) },
        { label: "탈삼진", value: myPitching.so, rank: getRank(data.pitching, "so", teamSlug), allTeams: getAllTeams(data.pitching, "so") },
        { label: "세이브", value: myPitching.sv, rank: getRank(data.pitching, "sv", teamSlug), allTeams: getAllTeams(data.pitching, "sv") },
        { label: "피홈런", value: myPitching.hra, rank: getRank(data.pitching, "hra", teamSlug, false), allTeams: getAllTeams(data.pitching, "hra", false) },
      ]
    : [];

  // OPS hero card
  const opsRank = myBatting ? getRank(data.batting, "ops", teamSlug) : 0;

  return (
    <div className="mx-auto max-w-lg pb-24">
      <div className="sticky top-0 z-30 border-b border-border bg-bg-primary" style={{ paddingTop: "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))", marginTop: "calc(var(--safe-area-inset-top, env(safe-area-inset-top, 0px)) * -1)" }}>
      <header className="flex items-center gap-2 px-5 min-h-[44px]">
        <button onClick={() => { if (window.history.length > 1) router.back(); else router.push(`/teams/${teamSlug}`); }} aria-label="뒤로가기" className="flex h-11 w-11 items-center justify-center rounded-full text-text-secondary hover:bg-bg-tertiary transition-colors">
          <ChevronLeft size={24} />
        </button>
        <h1 className="truncate text-lg font-bold text-text-primary flex-1">
          {team.shortName} 팀 기록
        </h1>
        <HeaderProfileLink />
      </header>
      </div>

      {/* OPS Hero Card */}
      {myBatting && (
        <div
          className="mx-5 mb-4 rounded-2xl p-5 text-center"
          style={{ backgroundColor: `${teamColor}15` }}
        >
          <p className="text-xs text-text-tertiary mb-1">팀 OPS</p>
          <p className="text-3xl font-black tabular-nums" style={{ color: teamColor }}>
            {myBatting.ops}
          </p>
          <div className="flex items-center justify-center gap-2 mt-2">
            <span className="text-sm text-text-secondary">리그 {opsRank}위</span>
            <div className="flex gap-0.5">
              {Array.from({ length: 10 }, (_, i) => (
                <div
                  key={i}
                  className="w-3 h-2 rounded-sm"
                  style={{
                    backgroundColor:
                      i < 10 - opsRank + 1
                        ? teamColor
                        : "var(--bg-tertiary)",
                  }}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Batting */}
      <section className="px-5 mb-6">
        <h2 className="text-sm font-bold text-text-secondary mb-2">타격</h2>
        {battingStats.map((stat) => (
          <StatBar
            key={stat.label}
            label={stat.label}
            value={stat.value}
            rank={stat.rank}
            total={10}
            teamColor={teamColor}
            expanded={expandedStat === `batting-${stat.label}`}
            onClick={() => setExpandedStat(expandedStat === `batting-${stat.label}` ? null : `batting-${stat.label}`)}
            allTeams={stat.allTeams}
            mySlug={teamSlug}
          />
        ))}
      </section>

      {/* Pitching */}
      <section className="px-5">
        <h2 className="text-sm font-bold text-text-secondary mb-2">투구</h2>
        {pitchingStats.map((stat) => (
          <StatBar
            key={stat.label}
            label={stat.label}
            value={stat.value}
            rank={stat.rank}
            total={10}
            teamColor={teamColor}
            expanded={expandedStat === `pitching-${stat.label}`}
            onClick={() => setExpandedStat(expandedStat === `pitching-${stat.label}` ? null : `pitching-${stat.label}`)}
            allTeams={stat.allTeams}
            mySlug={teamSlug}
          />
        ))}
      </section>
    </div>
  );
}
