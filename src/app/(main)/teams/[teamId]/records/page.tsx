"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import { getTeamBySlug, getTeamBgColor } from "@/lib/constants/teams";

interface TeamBatting {
  teamId: number;
  slug: string;
  avg: string;
  ops: string;
  hr: number;
  runs: number;
  sb: number;
}

interface TeamPitching {
  teamId: number;
  slug: string;
  era: string;
  whip: string;
  so: number;
  sv: number;
  hra: number;
}

interface RecordsData {
  season: number;
  batting: TeamBatting[];
  pitching: TeamPitching[];
}

function StatBar({
  label,
  value,
  rank,
  total,
  teamColor,
}: {
  label: string;
  value: string | number;
  rank: number;
  total: number;
  teamColor: string;
}) {
  const pct = total > 0 ? ((total - rank + 1) / total) * 100 : 0;
  return (
    <div className="flex items-center gap-3 py-2">
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
    </div>
  );
}

export default function TeamRecordsPage() {
  const params = useParams();
  const teamSlug = params.teamId as string;
  const team = getTeamBySlug(teamSlug);
  const [data, setData] = useState<RecordsData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/team-records?season=2026")
      .then((r) => r.json())
      .then((d) => setData(d))
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

  function getRank<T>(arr: T[], key: keyof T, slug: string, desc = true): number {
    const sorted = [...arr].sort((a, b) => {
      const av = Number(a[key]);
      const bv = Number(b[key]);
      return desc ? bv - av : av - bv;
    });
    return sorted.findIndex((item) => (item as Record<string, unknown>).slug === slug) + 1;
  }

  const battingStats = myBatting
    ? [
        { label: "타율", value: myBatting.avg, rank: getRank(data.batting, "avg", teamSlug) },
        { label: "OPS", value: myBatting.ops, rank: getRank(data.batting, "ops", teamSlug) },
        { label: "홈런", value: myBatting.hr, rank: getRank(data.batting, "hr", teamSlug) },
        { label: "득점", value: myBatting.runs, rank: getRank(data.batting, "runs", teamSlug) },
        { label: "도루", value: myBatting.sb, rank: getRank(data.batting, "sb", teamSlug) },
      ]
    : [];

  const pitchingStats = myPitching
    ? [
        { label: "ERA", value: myPitching.era, rank: getRank(data.pitching, "era", teamSlug, false) },
        { label: "WHIP", value: myPitching.whip, rank: getRank(data.pitching, "whip", teamSlug, false) },
        { label: "탈삼진", value: myPitching.so, rank: getRank(data.pitching, "so", teamSlug) },
        { label: "세이브", value: myPitching.sv, rank: getRank(data.pitching, "sv", teamSlug) },
        { label: "피홈런", value: myPitching.hra, rank: getRank(data.pitching, "hra", teamSlug, false) },
      ]
    : [];

  // OPS hero card
  const opsRank = myBatting ? getRank(data.batting, "ops", teamSlug) : 0;

  return (
    <div className="mx-auto max-w-lg pb-24">
      <header className="px-5 py-4">
        <h1 className="text-lg font-bold text-text-primary">
          {team.shortName} 기록
        </h1>
      </header>

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
          />
        ))}
      </section>
    </div>
  );
}
