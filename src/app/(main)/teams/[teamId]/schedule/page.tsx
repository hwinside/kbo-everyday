"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import HeaderProfileLink from "@/components/ui/HeaderProfileLink";
import { getTeamBySlug, getTeamBgColor } from "@/lib/constants/teams";
import TeamLogo from "@/components/ui/TeamLogo";
import {
  RESULT_TONE_BG,
  gameResultTone,
  resultToneTextStyle,
} from "@/lib/ui/result-tone";

interface ScheduleDay {
  day: number;
  date: string;
  gameId: string;
  opponent: { id: number; slug: string; shortName: string; name: string };
  home: boolean;
  status: "scheduled" | "live" | "final" | "cancelled";
  result: "W" | "L" | "D" | null;
  score: { for: number | null; against: number | null };
  stadium: string;
  time?: string;
}

interface ScheduleData {
  team: string;
  month: string;
  summary: { wins: number; losses: number; draws: number; winRate: number };
  days: ScheduleDay[];
}

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

export default function TeamSchedulePage() {
  const params = useParams();
  const router = useRouter();
  const teamSlug = params.teamId as string;
  const team = getTeamBySlug(teamSlug);

  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth() + 1);
  const [data, setData] = useState<ScheduleData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!team) return;
    const slug = team.slug;
    async function load() {
      setLoading(true);
      const monthStr = `${year}-${String(month).padStart(2, "0")}`;
      try {
        const r = await fetch(`/api/team-schedule?team=${slug}&month=${monthStr}`);
        setData(await r.json());
      } catch {
        setData(null);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [team, year, month]);

  if (!team) {
    return (
      <div className="flex items-center justify-center py-40 text-text-tertiary">
        존재하지 않는 구단입니다
      </div>
    );
  }

  const teamColor = getTeamBgColor(team);

  function navigate(dir: -1 | 1) {
    let newMonth = month + dir;
    let newYear = year;
    if (newMonth < 1) {
      newMonth = 12;
      newYear--;
    } else if (newMonth > 12) {
      newMonth = 1;
      newYear++;
    }
    setYear(newYear);
    setMonth(newMonth);
  }

  // Build calendar grid
  const firstDayOfWeek = new Date(year, month - 1, 1).getDay();
  const daysInMonth = new Date(year, month, 0).getDate();
  const gamesByDay = new Map<number, ScheduleDay>();
  data?.days.forEach((d) => gamesByDay.set(d.day, d));

  const cells: (number | null)[] = [];
  for (let i = 0; i < firstDayOfWeek; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  const summary = data?.summary;

  return (
    <div className="mx-auto max-w-lg pb-24">
      <div className="sticky top-0 z-30 border-b border-border bg-bg-primary" style={{ paddingTop: "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))", marginTop: "calc(var(--safe-area-inset-top, env(safe-area-inset-top, 0px)) * -1)" }}>
      <header className="flex items-center gap-2 px-5 min-h-[44px]">
        <button onClick={() => { if (window.history.length > 1) router.back(); else router.push(`/teams/${teamSlug}`); }} aria-label="뒤로가기" className="flex h-11 w-11 items-center justify-center rounded-full text-text-secondary hover:bg-bg-tertiary transition-colors">
          <ChevronLeft size={24} />
        </button>
        <h1 className="truncate text-lg font-bold text-text-primary flex-1">
          {team.shortName} 스케줄
        </h1>
        <HeaderProfileLink />
      </header>
      </div>

      {/* Month navigator */}
      <div className="flex items-center justify-between px-5 py-2">
        <button
          onClick={() => navigate(-1)}
          className="rounded-full p-2 hover:bg-bg-tertiary/50"
        >
          <ChevronLeft size={20} className="text-text-secondary" />
        </button>
        <span className="text-base font-bold text-text-primary">
          {year}년 {month}월
        </span>
        <button
          onClick={() => navigate(1)}
          className="rounded-full p-2 hover:bg-bg-tertiary/50"
        >
          <ChevronRight size={20} className="text-text-secondary" />
        </button>
      </div>

      {/* Monthly summary */}
      {summary && (summary.wins > 0 || summary.losses > 0) && (
        <div className="mx-5 mb-3 rounded-xl px-4 py-2.5 text-center text-sm font-medium" style={{ backgroundColor: `${teamColor}15`, color: teamColor }}>
          {summary.wins}승 {summary.losses}패{summary.draws > 0 ? ` ${summary.draws}무` : ""} · 승률 {summary.winRate.toFixed(3)}
        </div>
      )}

      {/* Calendar grid */}
      <div className="px-5">
        {/* Weekday headers */}
        <div className="grid grid-cols-7 mb-1">
          {WEEKDAYS.map((wd, i) => (
            <div
              key={wd}
              className={`text-center text-xs font-medium py-1 ${
                i === 0 ? "text-red-400" : i === 6 ? "text-blue-400" : "text-text-tertiary"
              }`}
            >
              {wd}
            </div>
          ))}
        </div>

        {/* Day cells */}
        {loading ? (
          <div className="py-20 text-center text-sm text-text-tertiary">
            로딩 중...
          </div>
        ) : (
          <div className="grid grid-cols-7 gap-y-1">
            {cells.map((day, idx) => {
              if (day === null) {
                return <div key={`empty-${idx}`} className="aspect-square" />;
              }

              const game = gamesByDay.get(day);
              const opponentTeam = game
                ? getTeamBySlug(game.opponent.slug)
                : undefined;

              // 승패 색은 홈 팀카드 기준 SSOT(@/lib/ui/result-tone). live 는 결과가 아니라 기존 붉은 톤 유지.
              // 무승부(D)도 같은 계약으로 중립 배경을 받는다.
              const resultBg = game?.result
                ? RESULT_TONE_BG[gameResultTone(game.result)]
                : undefined;
              const liveBgClass =
                !game?.result && game?.status === "live" ? "bg-red-500/15" : "";

              return (
                <div
                  key={day}
                  className={`flex flex-col items-center justify-center rounded-lg aspect-square ${liveBgClass}`}
                  style={{
                    ...(resultBg ? { backgroundColor: resultBg } : {}),
                    ...(game?.status === "scheduled"
                      ? { border: `1px solid ${teamColor}30` }
                      : {}),
                  }}
                >
                  <span className="text-[10px] text-text-tertiary leading-none">
                    {day}
                  </span>
                  {opponentTeam && (
                    <div className="my-0.5">
                      <TeamLogo team={opponentTeam} size={32} />
                    </div>
                  )}
                  {game && (
                    <span
                      className={`text-[9px] font-bold leading-none ${
                        !game.result && game.status === "live" ? "text-red-400" : ""
                      }`}
                      style={
                        game.result
                          ? resultToneTextStyle(gameResultTone(game.result))
                          : game.status === "live"
                            ? undefined
                            : { color: "var(--text-secondary)" }
                      }
                    >
                      {game.result
                        ? game.result
                        : game.status === "live"
                        ? "LIVE"
                        : game.status === "cancelled"
                        ? "취소"
                        : game.home ? "홈" : "@"}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
