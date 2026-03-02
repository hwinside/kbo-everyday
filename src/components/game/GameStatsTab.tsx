"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { clsx } from "clsx";
import { type TeamData } from "@/lib/constants/teams";
import type {
  GameStats,
  BatterStat,
  PitcherStat,
} from "@/lib/constants/game-stats";

interface GameStatsTabProps {
  stats: GameStats;
  awayTeam: TeamData;
  homeTeam: TeamData;
}

type Side = "away" | "home";

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
  "h", "r", "er", "bb", "so", "hr", "bf", "ab", "np", "g", "w", "l", "sv",
];

function sumBatterField(batters: BatterStat[], key: keyof BatterStat): number {
  return batters.reduce((s, b) => s + (typeof b[key] === "number" ? (b[key] as number) : 0), 0);
}

function sumPitcherField(pitchers: PitcherStat[], key: keyof PitcherStat): number {
  return pitchers.reduce((s, p) => s + (typeof p[key] === "number" ? (p[key] as number) : 0), 0);
}

/** innings sum: "6.0" + "2.0" + "1.0" -> "9.0" */
function sumInnings(pitchers: PitcherStat[]): string {
  let thirds = 0;
  for (const p of pitchers) {
    const [whole, frac] = p.ip.split(".");
    thirds += parseInt(whole) * 3 + (frac ? parseInt(frac) : 0);
  }
  return `${Math.floor(thirds / 3)}.${thirds % 3}`;
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
  const ipStr = sumInnings(pitchers);
  const [whole, frac] = ipStr.split(".");
  const innings = parseInt(whole) + (frac ? parseInt(frac) / 3 : 0);
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
  "sticky bg-[#0A0A0B] z-[2]";

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

  return (
    <div className="px-5 py-4 space-y-5">
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
            <thead className="sticky top-0 z-[3] bg-[#141416]">
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
                  key={b.order}
                  className={clsx(
                    "border-b border-border/50 group",
                    i % 2 === 0 ? "bg-bg-glass/30" : "bg-transparent"
                  )}
                >
                  {BATTER_COLUMNS.map((col) => {
                    const isSticky = col.sticky;
                    const isName = col.key === "name";
                    const isPos = col.key === "position";

                    return (
                      <td
                        key={col.key}
                        className={clsx(
                          "py-2 px-2 tabular-nums whitespace-nowrap",
                          isSticky && stickyBase,
                          isName && "text-text-primary font-medium",
                          isPos && "text-text-tertiary",
                          !isSticky && "text-center text-text-secondary",
                          col.key === "order" && "text-center text-text-tertiary w-8",
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
                        {isName ? (
                          <Link href={`/boards/players/${b.name}`} className="hover:underline">
                            {String(b[col.key])}
                          </Link>
                        ) : String(b[col.key])}
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
            <thead className="sticky top-0 z-[3] bg-[#141416]">
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
                  key={p.name}
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
                        {isName ? (
                          <span className="inline-flex items-center">
                            {p.name}
                            <ResultBadge result={p.result} />
                          </span>
                        ) : (
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
