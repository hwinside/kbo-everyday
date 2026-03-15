"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { clsx } from "clsx";
import { type TeamData, getCompareBarColors } from "@/lib/constants/teams";
import { useTheme } from "@/components/ThemeProvider";
import type {
  GameStats,
  BatterStat,
  PitcherStat,
} from "@/lib/constants/game-stats";
import playersRoster from "@/lib/constants/players-roster.json";

interface GameStatsTabProps {
  stats: GameStats;
  awayTeam: TeamData;
  homeTeam: TeamData;
}

type Side = "away" | "home";

type RosterPlayer = {
  name: string;
  kboId: string;
  teamId: number;
};

function getPlayerHref(name: string, teamId: number): string | null {
  const roster = playersRoster as RosterPlayer[];
  const player =
    roster.find((entry) => entry.name === name && entry.teamId === teamId) ??
    roster.find((entry) => entry.name === name) ??
    null;

  return player ? `/community/players/${player.kboId}` : null;
}

/* -- batter columns -- */
const BATTER_COLUMNS: {
  key: keyof BatterStat;
  label: string;
  sticky?: boolean;
}[] = [
  { key: "order", label: "타순", sticky: true },
  { key: "name", label: "타자", sticky: true },
  { key: "position", label: "포지션", sticky: true },
  { key: "ab", label: "타수" },
  { key: "r", label: "득점" },
  { key: "h", label: "안타" },
  { key: "rbi", label: "타점" },
  { key: "hr", label: "홈런" },
  { key: "bb", label: "볼넷" },
  { key: "so", label: "삼진" },
  { key: "sb", label: "도루" },
  { key: "avg", label: "타율" },
];

/* -- pitcher columns -- */
const PITCHER_COLUMNS: { key: keyof PitcherStat; label: string; sticky?: boolean }[] = [
  { key: "name", label: "투수", sticky: true },
  { key: "ip", label: "이닝" },
  { key: "h", label: "피안타" },
  { key: "r", label: "실점" },
  { key: "er", label: "자책" },
  { key: "bb", label: "4사구" },
  { key: "so", label: "삼진" },
  { key: "hr", label: "피홈런" },
  { key: "bf", label: "타자" },
  { key: "ab", label: "타수" },
  { key: "np", label: "투구수" },
  { key: "g", label: "경기" },
  { key: "w", label: "승" },
  { key: "l", label: "패" },
  { key: "sv", label: "세이브" },
  { key: "era", label: "평균자책" },
];

/* -- summable numeric key lists -- */
const BATTER_SUM_KEYS: (keyof BatterStat)[] = [
  "ab", "r", "h", "rbi", "hr", "bb", "so", "sb",
];
const PITCHER_SUM_KEYS: (keyof PitcherStat)[] = [
  "h", "r", "er", "bb", "so", "hr", "bf", "ab", "np",
  // g, w, l, sv는 합계행에서 의미 없으므로 제외 (네이버도 비워둠)
];

function sumBatterField(batters: BatterStat[], key: keyof BatterStat): number {
  return batters.reduce((s, b) => s + (typeof b[key] === "number" ? (b[key] as number) : 0), 0);
}

function sumPitcherField(pitchers: PitcherStat[], key: keyof PitcherStat): number {
  return pitchers.reduce((s, p) => s + (typeof p[key] === "number" ? (p[key] as number) : 0), 0);
}

/** innings sum: handles "4", "1/3", "2/3", "6.1" formats */
function parseIpToThirds(ip: string): number {
  if (ip === "1/3") return 1;
  if (ip === "2/3") return 2;
  if (ip.includes(".")) {
    const [whole, frac] = ip.split(".");
    return parseInt(whole) * 3 + (frac ? parseInt(frac) : 0);
  }
  return (parseInt(ip) || 0) * 3;
}

function sumInnings(pitchers: PitcherStat[]): string {
  let thirds = 0;
  for (const p of pitchers) {
    thirds += parseIpToThirds(p.ip);
  }
  const rem = thirds % 3;
  return rem === 0 ? `${thirds / 3}` : `${Math.floor(thirds / 3)} ${rem}/3`;
}

/** team batting avg */
function teamAvg(batters: BatterStat[]): string {
  const totalAb = sumBatterField(batters, "ab");
  const totalH = sumBatterField(batters, "h");
  if (totalAb === 0) return ".000";
  return (totalH / totalAb).toFixed(3).replace(/^0/, "");
}

/** team ERA */
function teamEra(pitchers: PitcherStat[]): string {
  const totalEr = sumPitcherField(pitchers, "er");
  let thirds = 0;
  for (const p of pitchers) thirds += parseIpToThirds(p.ip);
  const innings = thirds / 3;
  if (innings === 0) return "0.00";
  return ((totalEr * 9) / innings).toFixed(2);
}

/* -- result badge -- */
function ResultBadge({ result }: { result: PitcherStat["result"] }) {
  if (!result) return null;
  const map = {
    win: { label: "승", bg: "bg-red-500/90", text: "text-white" },
    loss: { label: "패", bg: "bg-blue-500/90", text: "text-white" },
    save: { label: "세", bg: "bg-amber-500/90", text: "text-white" },
    hold: { label: "홀", bg: "bg-emerald-500/90", text: "text-white" },
  } as const;
  const cfg = map[result];
  return (
    <span
      className={clsx(
        "ml-1 inline-flex items-center justify-center rounded px-1 py-px text-sm font-bold leading-none",
        cfg.bg,
        cfg.text
      )}
    >
      {cfg.label}
    </span>
  );
}

/* -- sticky cell shared style -- */
const stickyBase =
  "sticky bg-bg-primary z-[2]";

export default function GameStatsTab({
  stats,
  awayTeam,
  homeTeam,
}: GameStatsTabProps) {
  const [side, setSide] = useState<Side>("away");

  const team = side === "away" ? awayTeam : homeTeam;
  const data = side === "away" ? stats.away : stats.home;

  /* pre-compute totals row */
  const batterTotals = useMemo(() => {
    const totals: Record<string, string | number> = {};
    for (const col of BATTER_COLUMNS) {
      if (col.key === "order") totals[col.key] = "";
      else if (col.key === "name") totals[col.key] = "합계";
      else if (col.key === "position") totals[col.key] = "";
      else if (col.key === "avg") totals[col.key] = teamAvg(data.batters);
      else if (BATTER_SUM_KEYS.includes(col.key))
        totals[col.key] = sumBatterField(data.batters, col.key);
      else totals[col.key] = "";
    }
    return totals;
  }, [data.batters]);

  const pitcherTotals = useMemo(() => {
    const totals: Record<string, string | number> = {};
    for (const col of PITCHER_COLUMNS) {
      if (col.key === "name") totals[col.key] = "합계";
      else if (col.key === "ip") totals[col.key] = sumInnings(data.pitchers);
      else if (col.key === "era") totals[col.key] = teamEra(data.pitchers);
      else if (PITCHER_SUM_KEYS.includes(col.key))
        totals[col.key] = sumPitcherField(data.pitchers, col.key);
      else totals[col.key] = "";
    }
    return totals;
  }, [data.pitchers]);

  /* team comparison summary */
  const comparison = useMemo(() => {
    const items: { label: string; away: number; home: number }[] = [
      { label: "안타", away: sumBatterField(stats.away.batters, "h"), home: sumBatterField(stats.home.batters, "h") },
      { label: "홈런", away: sumBatterField(stats.away.batters, "hr"), home: sumBatterField(stats.home.batters, "hr") },
      { label: "삼진", away: sumBatterField(stats.away.batters, "so"), home: sumBatterField(stats.home.batters, "so") },
      { label: "볼넷", away: sumBatterField(stats.away.batters, "bb"), home: sumBatterField(stats.home.batters, "bb") },
      { label: "도루", away: sumBatterField(stats.away.batters, "sb"), home: sumBatterField(stats.home.batters, "sb") },
    ];
    return items;
  }, [stats]);

  // 라이트 → colorPrimary, 다크 → colorLight
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const [awayBarColor, homeBarColor] = getCompareBarColors(awayTeam, homeTeam, isDark);

  return (
    <div className="px-5 py-4 space-y-5">
      {/* -- team comparison bar chart -- */}
      <div className="glass-card p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full" style={{ backgroundColor: awayBarColor }} />
            <span className="text-xs font-bold" style={{ color: awayBarColor }}>{awayTeam.shortName}</span>
          </div>
          <span className="text-[10px] text-text-tertiary font-semibold">팀 비교</span>
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold" style={{ color: homeBarColor }}>{homeTeam.shortName}</span>
            <div className="w-3 h-3 rounded-full" style={{ backgroundColor: homeBarColor }} />
          </div>
        </div>
        <div className="space-y-2">
          {comparison.map((item) => {
            const total = item.away + item.home;
            const awayPct = total > 0 ? (item.away / total) * 100 : 50;
            const homePct = total > 0 ? (item.home / total) * 100 : 50;
            return (
              <div key={item.label} className="flex items-center gap-1.5">
                {/* away number */}
                <span className="text-xs font-bold text-text-primary w-5 text-right shrink-0">{item.away}</span>
                {/* away bar (grows right-to-left) */}
                <div className="flex-1 flex justify-end">
                  <div
                    className="h-4 rounded-l-md transition-all duration-700"
                    style={{
                      width: `${awayPct}%`,
                      backgroundColor: awayBarColor,
                      minWidth: item.away > 0 ? "4px" : "0px",
                    }}
                  />
                </div>
                {/* label */}
                <span className="text-[10px] text-text-tertiary w-7 text-center shrink-0 font-medium">{item.label}</span>
                {/* home bar (grows left-to-right) */}
                <div className="flex-1 flex justify-start">
                  <div
                    className="h-4 rounded-r-md transition-all duration-700"
                    style={{
                      width: `${homePct}%`,
                      backgroundColor: homeBarColor,
                      minWidth: item.home > 0 ? "4px" : "0px",
                    }}
                  />
                </div>
                {/* home number */}
                <span className="text-xs font-bold text-text-primary w-5 text-left shrink-0">{item.home}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* -- team switch tabs -- */}
      <div className="flex gap-1 p-1 rounded-lg bg-bg-glass/40 backdrop-blur-sm">
        {([
          { id: "away" as Side, team: awayTeam },
          { id: "home" as Side, team: homeTeam },
        ]).map(({ id, team: t }) => (
          <button
            key={id}
            onClick={() => setSide(id)}
            className={clsx(
              "flex-1 py-3 text-base font-semibold rounded-md transition-all",
              side === id ? "text-white shadow-md" : "text-text-tertiary"
            )}
            style={
              side === id ? { backgroundColor: t.colorPrimary } : undefined
            }
          >
            {t.shortName}
          </button>
        ))}
      </div>

      {/* -- batter stats -- */}
      <section className="glass-card p-4">
        <div className="flex items-center gap-4 mb-3">
          <div
            className="w-1 h-4 rounded-full"
            style={{ backgroundColor: team.colorPrimary }}
          />
          <span className="text-base font-semibold text-text-primary">
            타자 기록
          </span>
        </div>

        <div className="overflow-x-auto max-h-[45vh] relative">
          <table className="w-max min-w-full text-sm border-collapse">
            <thead className="sticky top-0 z-[3] bg-bg-secondary">
              <tr className="text-text-tertiary border-b border-border">
                {BATTER_COLUMNS.map((col) => (
                  <th
                    key={col.key}
                    className={clsx(
                      "py-2 px-2 font-medium whitespace-nowrap",
                      col.sticky ? `${stickyBase} text-left ${col.key === "order" ? "left-0 min-w-[36px]" : col.key === "name" ? "left-[36px] min-w-[72px]" : "left-[108px] min-w-[40px]"}` : "text-center",
                      col.key === "order" && "text-center w-8",
                      col.key === "name" && "left-0 min-w-[56px]",
                      col.key === "position" && "left-[56px] min-w-[36px]"
                    )}
                    style={
                      col.key === "name"
                        ? { left: 0 }
                        : col.key === "position"
                          ? { left: 56 }
                          : undefined
                    }
                  >
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.batters.map((b, i) => (
                <tr
                  key={`${side}-${i}-${b.name}`}
                  className={clsx(
                    "border-b border-border/50 group",
                    i % 2 === 0 ? "bg-bg-glass/30" : "bg-transparent"
                  )}
                >
                  {BATTER_COLUMNS.map((col) => {
                    const isSticky = col.sticky;
                    const isName = col.key === "name";
                    const isPos = col.key === "position";
                    const isOrder = col.key === "order";

                    return (
                      <td
                        key={col.key}
                        className={clsx(
                          "py-2 px-2 tabular-nums whitespace-nowrap",
                          isSticky && stickyBase,
                          isName && "text-text-primary font-medium",
                          isPos && "text-text-tertiary text-xs",
                          !isSticky && "text-center text-text-secondary",
                          isOrder && "text-center text-text-tertiary w-8",
                          b.isSubstitute && isOrder && "text-accent",
                          // highlight: 3+ hits or 1+ HR
                          col.key === "h" && b.h >= 3 && "text-accent font-semibold",
                          col.key === "hr" && b.hr >= 1 && "text-accent font-semibold"
                        )}
                        style={
                          isName
                            ? { left: 0 }
                            : isPos
                              ? { left: 56 }
                              : undefined
                        }
                      >
                        {isOrder && b.isSubstitute ? (
                          <span className="text-[10px] text-text-tertiary">↑</span>
                        ) : isName ? (() => {
                          const href = getPlayerHref(b.name, team.id);
                          return href ? (
                            <Link href={href} className="hover:underline">
                              {String(b[col.key])}
                            </Link>
                          ) : (
                            String(b[col.key])
                          );
                        })() : String(b[col.key])}
                      </td>
                    );
                  })}
                </tr>
              ))}
              {/* totals row */}
              <tr className="border-t-2 border-border bg-bg-glass/50 font-semibold">
                {BATTER_COLUMNS.map((col) => {
                  const isSticky = col.sticky;
                  const isName = col.key === "name";
                  const isPos = col.key === "position";

                  return (
                    <td
                      key={col.key}
                      className={clsx(
                        "py-2 px-2 tabular-nums whitespace-nowrap text-text-primary",
                        isSticky && stickyBase,
                        isName && "font-bold",
                        !isSticky && "text-center",
                        col.key === "order" && "text-center w-8"
                      )}
                      style={
                        isName
                          ? { left: 0 }
                          : isPos
                            ? { left: 56 }
                            : undefined
                      }
                    >
                      {String(batterTotals[col.key])}
                    </td>
                  );
                })}
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* -- pitcher stats -- */}
      <section className="glass-card p-4">
        <div className="flex items-center gap-4 mb-3">
          <div
            className="w-1 h-4 rounded-full"
            style={{ backgroundColor: team.colorPrimary }}
          />
          <span className="text-base font-semibold text-text-primary">
            투수 기록
          </span>
        </div>

        <div className="overflow-x-auto max-h-[45vh] relative">
          <table className="w-max min-w-full text-sm border-collapse">
            <thead className="sticky top-0 z-[3] bg-bg-secondary">
              <tr className="text-text-tertiary border-b border-border">
                {PITCHER_COLUMNS.map((col) => (
                  <th
                    key={col.key}
                    className={clsx(
                      "py-2 px-2 font-medium whitespace-nowrap",
                      col.sticky
                        ? `${stickyBase} left-0 text-left min-w-[80px]`
                        : "text-center"
                    )}
                  >
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.pitchers.map((p, i) => (
                <tr
                  key={`${side}-pitcher-${i}-${p.name}`}
                  className={clsx(
                    "border-b border-border/50",
                    i % 2 === 0 ? "bg-bg-glass/30" : "bg-transparent"
                  )}
                >
                  {PITCHER_COLUMNS.map((col) => {
                    const isSticky = col.sticky;
                    const isName = col.key === "name";

                    return (
                      <td
                        key={col.key}
                        className={clsx(
                          "py-2 px-2 tabular-nums whitespace-nowrap",
                          isSticky && `${stickyBase} left-0`,
                          isName && "text-text-primary font-medium",
                          !isSticky && "text-center text-text-secondary"
                        )}
                      >
                        {isName ? (() => {
                          const href = getPlayerHref(p.name, team.id);
                          const content = (
                            <span className="inline-flex items-center">
                              {p.name}
                              <ResultBadge result={p.result} />
                            </span>
                          );
                          return href ? (
                            <Link href={href} className="hover:underline">
                              {content}
                            </Link>
                          ) : content;
                        })() : (
                          String(p[col.key] ?? "")
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
              {/* totals row */}
              <tr className="border-t-2 border-border bg-bg-glass/50 font-semibold">
                {PITCHER_COLUMNS.map((col) => {
                  const isSticky = col.sticky;
                  const isName = col.key === "name";

                  return (
                    <td
                      key={col.key}
                      className={clsx(
                        "py-2 px-2 tabular-nums whitespace-nowrap text-text-primary",
                        isSticky && `${stickyBase} left-0`,
                        isName && "font-bold",
                        !isSticky && "text-center"
                      )}
                    >
                      {String(pitcherTotals[col.key])}
                    </td>
                  );
                })}
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
