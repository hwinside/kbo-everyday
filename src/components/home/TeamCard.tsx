"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";
import TeamLogo from "@/components/ui/TeamLogo";
import { getTeamById, type TeamData } from "@/lib/constants/teams";
import { getTeamColor } from "@/lib/utils/team";

type FormResult = "W" | "L" | "D";

interface TeamCardData {
  standing: {
    rank: number;
    gamesBehind: number;
    streak: string | null;
    above: { teamId: number; gap: number } | null;
    below: { teamId: number; gap: number } | null;
  } | null;
  recentForm: FormResult[];
  nextGame: {
    gameId: string;
    date: string;
    time: string;
    stadium: string;
    home: boolean;
    opponentId: number;
    myStarter: string | null;
    oppStarter: string | null;
  } | null;
}

interface TeamCardProps {
  team: TeamData;
}

// "3승"/"2패"/"1무" → 표시 문자열 + 톤
function formatStreak(raw: string | null): { text: string; hot: boolean } | null {
  if (!raw) return null;
  const m = raw.match(/^(\d+)\s*(승|패|무)$/);
  if (!m) return { text: raw, hot: false };
  const [, n, kind] = m;
  if (kind === "승") return { text: `${n}연승`, hot: true };
  if (kind === "패") return { text: `${n}연패`, hot: false };
  return { text: `${n}무`, hot: false };
}

function gapLabel(gap: number): string {
  // 0.5 단위 표기, 정수면 .0 생략
  return Number.isInteger(gap) ? `${gap}` : gap.toFixed(1);
}

function formatNextDate(yyyymmdd: string): string {
  const y = Number(yyyymmdd.slice(0, 4));
  const mo = Number(yyyymmdd.slice(4, 6));
  const d = Number(yyyymmdd.slice(6, 8));
  const wd = ["일", "월", "화", "수", "목", "금", "토"][new Date(Date.UTC(y, mo - 1, d)).getUTCDay()];
  return `${mo}/${d} (${wd})`;
}

export default function TeamCard({ team }: TeamCardProps) {
  const [data, setData] = useState<TeamCardData | null>(null);
  const [loaded, setLoaded] = useState(false);
  const accent = getTeamColor(team.id);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/team-card?team=${team.slug}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: TeamCardData | null) => {
        if (!cancelled) {
          setData(d && !("error" in d) ? d : null);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [team.slug]);

  // 데이터 전혀 없으면(로딩 실패) 카드 자체를 숨겨 빈 카드 방지
  if (loaded && !data?.standing && !data?.nextGame && (!data?.recentForm?.length)) {
    return null;
  }

  const streak = formatStreak(data?.standing?.streak ?? null);
  const opponent = data?.nextGame ? getTeamById(data.nextGame.opponentId) : null;

  return (
    <GlassCard className="p-5 mb-3">
      {/* 헤더 */}
      <div className="flex items-center gap-2.5 mb-3.5">
        <TeamLogo team={team} size={34} />
        <span className="text-base font-bold text-text-primary">{team.name}</span>
        <span
          className="ml-auto text-[10px] font-bold text-white px-1.5 py-0.5 rounded-md"
          style={{ background: accent }}
        >
          MY TEAM
        </span>
      </div>

      {!loaded ? (
        <div className="h-24 animate-pulse rounded-xl bg-bg-secondary" />
      ) : (
        <>
          {/* 순위 + 게임차 + 연승연패 */}
          {data?.standing && (
            <div>
              <div className="flex items-end gap-3">
                <span className="text-[34px] font-extrabold leading-none text-text-primary">
                  {data.standing.rank}위
                </span>
                <span className="text-xs text-text-secondary leading-[18px] pb-1">
                  {data.standing.above && (
                    <>
                      {getTeamById(data.standing.above.teamId)?.shortName} 위와{" "}
                      <b className="text-text-primary">{gapLabel(data.standing.above.gap)}G</b>
                    </>
                  )}
                  {data.standing.above && data.standing.below && " · "}
                  {data.standing.below && (
                    <>
                      {getTeamById(data.standing.below.teamId)?.shortName} 아래와{" "}
                      <b className="text-text-primary">{gapLabel(data.standing.below.gap)}G</b>
                    </>
                  )}
                </span>
              </div>
              {streak && (
                <span
                  className="inline-block mt-2 text-[12.5px] font-bold"
                  style={{ color: streak.hot ? "#ff6b6b" : "var(--text-tertiary)" }}
                >
                  {streak.hot ? "🔥 " : ""}
                  {streak.text}
                </span>
              )}
            </div>
          )}

          {/* 최근 5경기 폼 */}
          {data?.recentForm && data.recentForm.length > 0 && (
            <div className="mt-4 border-t border-border/40 pt-3.5">
              <p className="text-[11px] text-text-tertiary mb-2">최근 {data.recentForm.length}경기</p>
              <div className="flex gap-1.5">
                {data.recentForm.map((r, i) => (
                  <span
                    key={i}
                    className="w-[22px] h-[22px] rounded-[7px] flex items-center justify-center text-[11px] font-extrabold"
                    style={
                      r === "W"
                        ? { background: "rgba(38,168,109,.22)", color: "#36d399" }
                        : r === "L"
                        ? { background: "rgba(196,1,47,.20)", color: "#ff6b6b" }
                        : { background: "rgba(160,160,170,.18)", color: "#b0b0ba" }
                    }
                  >
                    {r === "W" ? "승" : r === "L" ? "패" : "무"}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* 다음 경기 + 예고선발 + CTA */}
          {data?.nextGame && opponent && (
            <div className="mt-4 border-t border-border/40 pt-3.5">
              <p className="text-[11px] text-text-tertiary mb-2">다음 경기</p>
              <div className="text-xs text-text-secondary">
                {formatNextDate(data.nextGame.date)} {data.nextGame.time} · {data.nextGame.stadium}
              </div>
              <div className="text-sm font-bold text-text-primary mt-0.5">
                {team.shortName} <span className="text-text-tertiary font-normal">{data.nextGame.home ? "vs" : "@"}</span> {opponent.shortName}
              </div>
              {(data.nextGame.myStarter || data.nextGame.oppStarter) && (
                <div className="text-[11.5px] text-text-tertiary mt-1">
                  예고선발 {data.nextGame.myStarter || "미정"}({team.shortName}) vs {data.nextGame.oppStarter || "미정"}({opponent.shortName})
                </div>
              )}
              <Link
                href={`/teams/${team.slug}/schedule`}
                className="mt-3 flex items-center justify-center gap-1 rounded-[10px] border border-border bg-white/[0.06] py-2.5 text-[12.5px] font-semibold text-text-secondary"
              >
                경기 일정 보기
                <ChevronRight size={14} />
              </Link>
            </div>
          )}
        </>
      )}
    </GlassCard>
  );
}
