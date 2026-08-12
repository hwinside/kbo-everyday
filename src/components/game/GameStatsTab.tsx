"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { clsx } from "clsx";
import { type TeamData, getCompareBarColors } from "@/lib/constants/teams";
import { resultToneChipStyle } from "@/lib/ui/result-tone";
import { useTheme } from "@/components/ThemeProvider";
import type {
  GameStats,
  BatterStat,
  PitcherStat,
} from "@/lib/constants/game-stats";
import type { GameRelayResponse } from "@/lib/hooks/useGameRelay";
import RelayInningCard from "./RelayInningCard";
import { inningRuns, type InningLinescore } from "@/lib/game/inning-runs";
import { ChevronDown, ChevronUp } from "lucide-react";
import playersRoster from "@/lib/constants/players-roster.json";

interface GameStatsTabProps {
  stats: GameStats;
  awayTeam: TeamData;
  homeTeam: TeamData;
  isLive?: boolean;
  relay?: GameRelayResponse | null;
  linescore?: InningLinescore | null;
}

type Side = "away" | "home";

type RosterPlayer = {
  name: string;
  kboId: string;
  teamId: number;
};

function getPlayerHref(name: string, teamId: number): string | null {
  if (!name) return null;
  const roster = playersRoster as RosterPlayer[];
  const player =
    roster.find((entry) => entry.name === name && entry.teamId === teamId) ??
    roster.find((entry) => entry.name === name) ??
    roster.find((entry) => entry.name.endsWith(name) && entry.teamId === teamId) ??
    roster.find((entry) => entry.name.endsWith(name)) ??
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
  { key: "w", label: "승" },
  { key: "l", label: "패" },
  { key: "sv", label: "세이브" },
  { key: "hd", label: "홀드" },
  { key: "era", label: "평균자책" },
];

/* -- summable numeric key lists -- */
const BATTER_SUM_KEYS: (keyof BatterStat)[] = [
  "ab", "r", "h", "rbi", "hr", "bb", "so", "sb",
];
const PITCHER_SUM_KEYS: (keyof PitcherStat)[] = [
  "h", "r", "er", "bb", "so", "hr", "bf", "ab", "np",
  // g, w, l, sv, hd는 합계행에서 의미 없으므로 제외 (네이버도 비워둠)
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
  // 승/패는 홈 팀카드 기준 SSOT(@/lib/ui/result-tone). 이전엔 승=빨강·패=파랑으로
  // 앱 전체와 정반대였다. 세·홀은 승패가 아니라 투수 역할 표시라 tone 체계 밖(현행 유지).
  const map = {
    win: { label: "승", tone: "positive" },
    loss: { label: "패", tone: "negative" },
  } as const;
  const roleMap = {
    save: { label: "세", bg: "bg-amber-500/90", text: "text-white" },
    hold: { label: "홀", bg: "bg-emerald-500/90", text: "text-white" },
  } as const;
  const base =
    "inline-flex items-center justify-center rounded px-1 py-px text-[9px] font-bold leading-none";
  if (result === "win" || result === "loss") {
    const cfg = map[result];
    return (
      <span className={base} style={resultToneChipStyle(cfg.tone)}>
        {cfg.label}
      </span>
    );
  }
  const cfg = roleMap[result];
  return <span className={clsx(base, cfg.bg, cfg.text)}>{cfg.label}</span>;
}

export default function GameStatsTab({
  stats,
  awayTeam,
  homeTeam,
  isLive,
  relay,
  linescore,
}: GameStatsTabProps) {
  void isLive; // Reserved for future live-specific styling
  const [collapseInnings, setCollapseInnings] = useState(true);
  const relayInnings = relay?.innings ?? [];
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
      {/* -- 이닝별 주요 기록 (relay 데이터 있을 때) -- */}
      {relayInnings.length > 0 && (
        <div className="space-y-1">
          <div className="glass-card p-3 mb-3">
            <p className="text-sm font-semibold text-text-primary">이닝별 주요 기록</p>
          </div>
          <button
            onClick={() => setCollapseInnings(!collapseInnings)}
            className="w-full flex items-center justify-center gap-1.5 px-4 py-2 text-text-tertiary hover:bg-black/5 dark:hover:bg-white/5 transition-colors rounded-lg border border-border/30"
          >
            {collapseInnings ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
            <span className="text-[11px] font-medium">
              {collapseInnings ? `전체 이닝별 기록 보기 (${relayInnings.length}개)` : "이닝별 기록 접기"}
            </span>
          </button>
          <div className="space-y-2">
            {!collapseInnings && relayInnings.map((inning) => (
              <RelayInningCard
                key={`${inning.inning}-${inning.half}`}
                inning={inning}
                awayTeam={awayTeam}
                homeTeam={homeTeam}
                runs={inningRuns(linescore, inning)}
              />
            ))}
          </div>
        </div>
      )}

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

        {/* table-fixed + w-full → 컬럼이 화면 폭에 맞춰 압축, 좌우 스크롤 없음 */}
        <table className="w-full table-fixed text-[10px] leading-tight border-collapse">
          <colgroup>
            {BATTER_COLUMNS.map((col) => (
              <col
                key={col.key}
                style={{
                  width:
                    col.key === "order"
                      ? "6%"
                      : col.key === "name"
                        ? "16%"
                        : col.key === "position"
                          ? "8%"
                          : col.key === "avg"
                            ? "9%"
                            : undefined,
                }}
              />
            ))}
          </colgroup>
          <thead className="bg-bg-secondary">
            <tr className="text-text-tertiary border-b border-border">
              {BATTER_COLUMNS.map((col) => (
                <th
                  key={col.key}
                  className={clsx(
                    "py-1.5 px-0.5 font-medium",
                    col.key === "name" ? "text-left" : "text-center"
                  )}
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
                  const isName = col.key === "name";
                  const isPos = col.key === "position";
                  const isOrder = col.key === "order";

                  return (
                    <td
                      key={col.key}
                      className={clsx(
                        "py-1.5 px-0.5 tabular-nums",
                        isName && "text-text-primary font-medium text-left",
                        isPos && "text-text-tertiary text-center",
                        isOrder && "text-center text-text-tertiary",
                        !isName && !isPos && !isOrder && "text-center text-text-secondary",
                        b.isSubstitute && isOrder && "text-accent",
                        // highlight: 3+ hits or 1+ HR
                        col.key === "h" && b.h >= 3 && "text-accent font-semibold",
                        col.key === "hr" && b.hr >= 1 && "text-accent font-semibold"
                      )}
                    >
                      {isOrder && b.isSubstitute ? (
                        <span className="text-accent">↑</span>
                      ) : isName ? (() => {
                        const href = getPlayerHref(b.name, team.id);
                        return href ? (
                          <Link href={href} prefetch={false} className="hover:underline">
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
                const isName = col.key === "name";
                return (
                  <td
                    key={col.key}
                    className={clsx(
                      "py-1.5 px-0.5 tabular-nums text-text-primary",
                      isName ? "font-bold text-left" : "text-center"
                    )}
                  >
                    {String(batterTotals[col.key])}
                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
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

        {/* 투수표 전치: 스탯=행 / 투수=열. 투수는 3~6명이라 세로로 두면 16스탯 라벨이
            안 잘리고 폰트도 9px→10px로 키움. 투수 7+명이면 min-w + overflow로 가로 스크롤. */}
        <div className="overflow-x-auto">
          <table className="w-full text-[10px] leading-tight border-collapse">
            <thead className="bg-bg-secondary">
              <tr className="text-text-tertiary border-b border-border">
                <th className="py-1.5 px-1 text-left font-medium min-w-[40px]" />
                {data.pitchers.map((p, i) => {
                  const href = getPlayerHref(p.name, team.id);
                  const head = (
                    <span className="inline-flex flex-col items-center justify-center gap-0.5 text-text-primary font-semibold">
                      <ResultBadge result={p.result} />
                      {p.name}
                    </span>
                  );
                  return (
                    <th key={`phead-${i}-${p.name}`} className="py-1.5 px-0.5 text-center font-medium min-w-[30px]">
                      {href ? (
                        <Link href={href} prefetch={false} className="hover:underline">
                          {head}
                        </Link>
                      ) : (
                        head
                      )}
                    </th>
                  );
                })}
                <th className="py-1.5 px-0.5 text-center font-semibold text-text-secondary min-w-[30px]">합계</th>
              </tr>
            </thead>
            <tbody>
              {PITCHER_COLUMNS.filter((c) => c.key !== "name").map((col, ri) => (
                <tr
                  key={col.key}
                  className={clsx(
                    "border-b border-border/50",
                    ri % 2 === 0 ? "bg-bg-glass/30" : "bg-transparent"
                  )}
                >
                  <td className="py-1.5 px-1 text-left font-medium text-text-tertiary whitespace-nowrap">
                    {col.label}
                  </td>
                  {data.pitchers.map((p, i) => (
                    <td
                      key={`pval-${i}-${col.key}`}
                      className="py-1.5 px-0.5 text-center tabular-nums text-text-secondary"
                    >
                      {String(p[col.key] ?? "")}
                    </td>
                  ))}
                  <td className="py-1.5 px-0.5 text-center tabular-nums font-semibold text-text-primary">
                    {String(pitcherTotals[col.key] ?? "")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
