"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";
import TeamLogo from "@/components/ui/TeamLogo";
import { getTeamById, type TeamData } from "@/lib/constants/teams";
import { getTeamColor } from "@/lib/utils/team";

type FormResult = "W" | "L" | "D";

interface TopPlayer { category: string; rank: number; playerName: string; value: number }

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
  rankHistory?: { date: string; rank: number }[];
  topPlayers?: TopPlayer[];
  weeklyBatting?: { week: string; avg: number }[];
  weeklyPitching?: { week: string; era: number }[];
}

interface TeamCardProps {
  team: TeamData;
  // 오늘 경기 카드(MyTeamHero)를 팀카드 안에 임베드. 없으면(오늘 경기 없음) 다음 경기 블록 표시.
  gameSlot?: ReactNode;
}

const CAT_LABEL: Record<string, string> = {
  avg: "타율", hr: "홈런", rbi: "타점", sb: "도루", era: "평균자책",
  k: "탈삼진", wins: "다승", saves: "세이브", whip: "WHIP",
};

// 순위 시계열 → SVG 폴리라인. rank 1=위, 10=아래(반전). 최대 ~40점 다운샘플.
function buildRankLine(history: { rank: number }[], w: number, h: number, pad: number) {
  const ranks = history.map((p) => p.rank).filter((r) => r >= 1 && r <= 10);
  const n = ranks.length;
  if (n < 2) return null;
  const step = n > 40 ? Math.ceil(n / 40) : 1;
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i += step) {
    pts.push({ x: pad + (i / (n - 1)) * (w - pad * 2), y: pad + ((ranks[i] - 1) / 9) * (h - pad * 2) });
  }
  const lastX = pad + (w - pad * 2);
  const lastY = pad + ((ranks[n - 1] - 1) / 9) * (h - pad * 2);
  if (pts[pts.length - 1].x !== lastX) pts.push({ x: lastX, y: lastY });
  return { line: pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" "), lastX, lastY, first: ranks[0], last: ranks[n - 1] };
}

// 일반 시계열(타율/방어율) → 폴리라인. higherIsBetter=false면 낮을수록 위로.
function buildSeriesLine(values: number[], w: number, h: number, pad: number, higherIsBetter: boolean) {
  if (values.length < 2) return null;
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => {
    const norm = (v - min) / span;
    const y = higherIsBetter ? pad + (1 - norm) * (h - pad * 2) : pad + norm * (h - pad * 2);
    return { x: pad + (i / (values.length - 1)) * (w - pad * 2), y };
  });
  const last = pts[pts.length - 1];
  return { line: pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" "), lastX: last.x, lastY: last.y };
}

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
  return Number.isInteger(gap) ? `${gap}` : gap.toFixed(1);
}

function formatNextDate(yyyymmdd: string): string {
  const y = Number(yyyymmdd.slice(0, 4)), mo = Number(yyyymmdd.slice(4, 6)), d = Number(yyyymmdd.slice(6, 8));
  const wd = ["일", "월", "화", "수", "목", "금", "토"][new Date(Date.UTC(y, mo - 1, d)).getUTCDay()];
  return `${mo}/${d} (${wd})`;
}

function MiniStatChart({ title, values, unit, fmt, higherIsBetter, accent }: {
  title: string; values: number[]; unit: string; fmt: (v: number) => string; higherIsBetter: boolean; accent: string;
}) {
  const line = buildSeriesLine(values, 140, 40, 5, higherIsBetter);
  const current = values.length ? values[values.length - 1] : null;
  return (
    <div className="flex-1 rounded-[10px] bg-bg-secondary/60 px-2.5 py-2">
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-[10.5px] text-text-tertiary">{title}</span>
        {current != null && <span className="text-[12px] font-bold text-text-primary">{fmt(current)}<span className="text-[9px] text-text-tertiary ml-0.5">{unit}</span></span>}
      </div>
      {line ? (
        <svg width="100%" height="40" viewBox="0 0 140 40" preserveAspectRatio="none" aria-hidden>
          <polyline fill="none" stroke={accent} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" points={line.line} />
          <circle cx={line.lastX} cy={line.lastY} r="2.8" fill={accent} />
        </svg>
      ) : (
        <div className="h-10 flex items-center text-[10px] text-text-tertiary">데이터 부족</div>
      )}
    </div>
  );
}

export default function TeamCard({ team, gameSlot }: TeamCardProps) {
  const [data, setData] = useState<TeamCardData | null>(null);
  const [loaded, setLoaded] = useState(false);
  const accent = getTeamColor(team.id);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/team-card?team=${team.slug}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: TeamCardData | null) => {
        if (!cancelled) { setData(d && !("error" in d) ? d : null); setLoaded(true); }
      })
      .catch(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [team.slug]);

  if (loaded && !data?.standing && !data?.nextGame && !data?.recentForm?.length) return null;

  const streak = formatStreak(data?.standing?.streak ?? null);
  const opponent = data?.nextGame ? getTeamById(data.nextGame.opponentId) : null;
  const rankLine = data?.rankHistory ? buildRankLine(data.rankHistory, 320, 56, 8) : null;
  // 순위권 칩 — rank 오름차순, 최대 6개
  const topChips = (data?.topPlayers ?? []).slice(0, 6);

  return (
    <GlassCard className="p-5 mb-3">
      <div className="flex items-center gap-2.5 mb-3.5">
        <TeamLogo team={team} size={34} />
        <span className="text-base font-bold text-text-primary">{team.name}</span>
        <span className="ml-auto text-[10px] font-bold text-white px-1.5 py-0.5 rounded-md" style={{ background: accent }}>MY TEAM</span>
      </div>

      {!loaded ? (
        <div className="h-24 animate-pulse rounded-xl bg-bg-secondary" />
      ) : (
        <>
          {/* 상단 2분할: 좌 순위/게임차/연승연패 | 우 최근 5경기 */}
          {(data?.standing || (data?.recentForm?.length ?? 0) > 0) && (
            <div className="flex items-start gap-3">
              {data?.standing && (
                <div className="flex-1 min-w-0">
                  <div className="flex items-end gap-2">
                    <span className="text-[34px] font-extrabold leading-none text-text-primary">{data.standing.rank}위</span>
                    {streak && (
                      <span className="text-[12px] font-bold pb-1" style={{ color: streak.hot ? "#ff6b6b" : "var(--text-tertiary)" }}>
                        {streak.hot ? "🔥" : ""}{streak.text}
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-text-secondary leading-[16px] mt-1.5">
                    {data.standing.above && (<div>↑ {getTeamById(data.standing.above.teamId)?.shortName} <b className="text-text-primary">{gapLabel(data.standing.above.gap)}G</b></div>)}
                    {data.standing.below && (<div>↓ {getTeamById(data.standing.below.teamId)?.shortName} <b className="text-text-primary">{gapLabel(data.standing.below.gap)}G</b></div>)}
                  </div>
                </div>
              )}
              {data?.recentForm && data.recentForm.length > 0 && (
                <div className="flex-shrink-0 text-right">
                  <p className="text-[11px] text-text-tertiary mb-2">최근 {data.recentForm.length}경기</p>
                  <div className="flex gap-1.5 justify-end">
                    {data.recentForm.map((r, i) => (
                      <span key={i} className="w-[22px] h-[22px] rounded-[7px] flex items-center justify-center text-[11px] font-extrabold"
                        style={r === "W" ? { background: "rgba(38,168,109,.22)", color: "#36d399" } : r === "L" ? { background: "rgba(196,1,47,.20)", color: "#ff6b6b" } : { background: "rgba(160,160,170,.18)", color: "#b0b0ba" }}>
                        {r === "W" ? "승" : r === "L" ? "패" : "무"}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 순위권 선수 칩 */}
          {topChips.length > 0 && (
            <div className="mt-4 border-t border-border/40 pt-3.5">
              <p className="text-[11px] text-text-tertiary mb-2">순위권 선수</p>
              <div className="flex flex-wrap gap-1.5">
                {topChips.map((p, i) => (
                  <span key={i} className="text-[11.5px] px-2 py-1 rounded-full bg-white/[0.06] border border-border">
                    {CAT_LABEL[p.category] ?? p.category} {p.playerName} <b style={{ color: p.rank === 1 ? "#ffd24a" : "var(--text-primary)" }}>{p.rank}위</b>
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* 경기 — 오늘 경기카드(임베드) 또는 다음 경기. 예고선발 포함. (④=B) */}
          {(gameSlot || (data?.nextGame && opponent)) && (
            <div className="mt-4 border-t border-border/40 pt-3.5">
              {gameSlot ? (
                <>
                  <p className="text-[11px] text-text-tertiary mb-2">경기</p>
                  {gameSlot}
                  {data?.nextGame && opponent && (data.nextGame.myStarter || data.nextGame.oppStarter) && (
                    <div className="text-[11.5px] text-text-tertiary mt-2">
                      다음 예고선발 · {formatNextDate(data.nextGame.date)} {data.nextGame.myStarter || "미정"}({team.shortName}) vs {data.nextGame.oppStarter || "미정"}({opponent.shortName})
                    </div>
                  )}
                </>
              ) : data?.nextGame && opponent ? (
                <>
                  <p className="text-[11px] text-text-tertiary mb-2">다음 경기</p>
                  <div className="text-xs text-text-secondary">{formatNextDate(data.nextGame.date)} {data.nextGame.time} · {data.nextGame.stadium}</div>
                  <div className="text-sm font-bold text-text-primary mt-0.5">
                    {team.shortName} <span className="text-text-tertiary font-normal">{data.nextGame.home ? "vs" : "@"}</span> {opponent.shortName}
                  </div>
                  {(data.nextGame.myStarter || data.nextGame.oppStarter) && (
                    <div className="text-[11.5px] text-text-tertiary mt-1">예고선발 {data.nextGame.myStarter || "미정"}({team.shortName}) vs {data.nextGame.oppStarter || "미정"}({opponent.shortName})</div>
                  )}
                </>
              ) : null}
              <Link href={`/teams/${team.slug}/schedule`} className="mt-3 flex items-center justify-center gap-1 rounded-[10px] border border-border bg-white/[0.06] py-2.5 text-[12.5px] font-semibold text-text-secondary">
                경기 일정 보기<ChevronRight size={14} />
              </Link>
            </div>
          )}

          {/* 시즌 순위 변동 그래프 (순위 라벨) */}
          {rankLine && (
            <div className="mt-4 border-t border-border/40 pt-3.5">
              <div className="flex items-baseline justify-between mb-2">
                <p className="text-[11px] text-text-tertiary">시즌 순위 변동 (개막 ~ 현재)</p>
                <p className="text-[11px] text-text-secondary">{rankLine.first}위 <span className="text-text-tertiary">→</span> <b className="text-text-primary">{rankLine.last}위</b></p>
              </div>
              <div className="relative rounded-[10px] bg-bg-secondary/60 px-2 pt-2.5 pb-1">
                <span className="absolute left-2 top-1 text-[9px] text-text-tertiary/70">1위</span>
                <span className="absolute left-2 bottom-1 text-[9px] text-text-tertiary/70">10위</span>
                <svg width="100%" height="56" viewBox="0 0 320 56" preserveAspectRatio="none" aria-hidden>
                  <polyline fill="none" stroke={accent} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" points={rankLine.line} />
                  <circle cx={rankLine.lastX} cy={rankLine.lastY} r="3.5" fill={accent} />
                </svg>
              </div>
            </div>
          )}

          {/* 주간 팀 타율 | 방어율 2분할 */}
          {((data?.weeklyBatting?.length ?? 0) >= 2 || (data?.weeklyPitching?.length ?? 0) >= 2) && (
            <div className="mt-3 flex gap-2">
              <MiniStatChart title="주간 팀 타율" values={(data?.weeklyBatting ?? []).map((w) => w.avg)} unit="" fmt={(v) => v.toFixed(3)} higherIsBetter accent={accent} />
              <MiniStatChart title="주간 팀 방어율" values={(data?.weeklyPitching ?? []).map((w) => w.era)} unit="" fmt={(v) => v.toFixed(2)} higherIsBetter={false} accent={accent} />
            </div>
          )}
        </>
      )}
    </GlassCard>
  );
}
