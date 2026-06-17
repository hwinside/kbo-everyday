"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";
import TeamLogo from "@/components/ui/TeamLogo";
import { getTeamById, type TeamData } from "@/lib/constants/teams";
import { getTeamColor } from "@/lib/utils/team";
import { STAT_DEFS } from "@/lib/stats/title-defs";
import { rankByStat } from "@/lib/stats/title-rankings";
import { getCanonicalPlayerHref } from "@/lib/utils/resolve-player";

type FormResult = "W" | "L" | "D";

interface TopPlayer { playerName: string; href: string | null; titles: { category: string; rank: number }[] }

// 순위권 노출 부문 = 순위 페이지 타이틀 탭(BatterTitleTab/PitcherTitleTab) allowlist ∩ STAT_DEFS.
// 타이틀 탭: 타자[타율·홈런·타점·도루·OPS·출루율] 투수[평균자책·다승·탈삼진·세이브·홀드·WHIP].
// (안타·장타율은 STAT_DEFS 미정의라 제외 / 득점·볼넷·사구·2루타+3루타·출전경기는 탭 미노출이라 제외)
const TOPPLAYER_ALLOW = new Set([
  "avg", "hr", "rbi", "sb", "ops", "obp",
  "era", "wins", "so_pitcher", "saves", "holds", "whip",
]);

// 부문 표기명: STAT_DEFS desc("홈런 랭킹"/"삼진 랭킹 (타자)") → "홈런"/"삼진"
function catName(statKey: string): string {
  const d = STAT_DEFS[statKey];
  if (!d) return statKey;
  return d.desc.replace(/\s*랭킹.*$/, "").replace(/\s*\(.*\)\s*$/, "").trim();
}

// /api/stats(batter+pitcher) → 마이팀 선수별 top5 타이틀 묶음(공식 랭킹 소스).
function computeTopPlayers(batters: Record<string, unknown>[], pitchers: Record<string, unknown>[], teamShort: string): TopPlayer[] {
  const byPlayer = new Map<string, TopPlayer>();
  for (const [statKey, def] of Object.entries(STAT_DEFS)) {
    if (!TOPPLAYER_ALLOW.has(statKey)) continue;
    const rows = (def.type === "batter" ? batters : pitchers) as Parameters<typeof rankByStat>[0];
    for (const r of rankByStat(rows, statKey)) {
      if (r.rank > 5) continue;
      if (String((r as { team?: string }).team ?? "") !== teamShort) continue;
      const name = String((r as { name?: string }).name ?? "");
      if (!name) continue;
      const entry = byPlayer.get(name) ?? {
        playerName: name,
        href: getCanonicalPlayerHref({ name, team: teamShort, kboId: (r as { kboId?: string }).kboId }),
        titles: [],
      };
      entry.titles.push({ category: statKey, rank: r.rank });
      byPlayer.set(name, entry);
    }
  }
  return [...byPlayer.values()]
    .map((p) => ({ ...p, titles: p.titles.sort((a, b) => a.rank - b.rank) }))
    .sort((a, b) => Math.min(...a.titles.map((t) => t.rank)) - Math.min(...b.titles.map((t) => t.rank)));
}

interface TeamCardData {
  standing: {
    rank: number;
    gamesBehind: number;
    streak: string | null;
    above: { teamId: number; gap: number } | null;
    below: { teamId: number; gap: number } | null;
  } | null;
  recentForm: FormResult[];
  nextGame: { gameId: string; date: string; time: string; stadium: string; home: boolean; opponentId: number; myStarter: string | null; oppStarter: string | null } | null;
  rankHistory?: { date: string; rank: number }[];
  weeklyBatting?: { week: string; avg: number }[];
  weeklyPitching?: { week: string; era: number }[];
  communityNewPosts?: number;
}

interface TeamCardProps {
  team: TeamData;
  gameSlot?: ReactNode;
}


// 순위 시계열 → 좌표(rank 1=위, 10=아래). 다운샘플 ~60점. yOf로 빗금 가이드도 공유.
function rankPoints(history: { rank: number }[], w: number, h: number, pad: number) {
  const ranks = history.map((p) => p.rank).filter((r) => r >= 1 && r <= 10);
  const n = ranks.length;
  if (n < 2) return null;
  const step = n > 60 ? Math.ceil(n / 60) : 1;
  const yOf = (r: number) => pad + ((r - 1) / 9) * (h - pad * 2);
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i += step) pts.push({ x: pad + (i / (n - 1)) * (w - pad * 2), y: yOf(ranks[i]) });
  const lastX = pad + (w - pad * 2);
  if (pts[pts.length - 1].x !== lastX) pts.push({ x: lastX, y: yOf(ranks[n - 1]) });
  return { line: pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" "), lastX, lastY: yOf(ranks[n - 1]), yOf, first: ranks[0], last: ranks[n - 1] };
}

function buildSeriesLine(values: number[], w: number, h: number, pad: number, higherIsBetter: boolean) {
  if (values.length < 2) return null;
  const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
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

function MiniStatChart({ title, values, fmt, higherIsBetter, accent }: {
  title: string; values: number[]; fmt: (v: number) => string; higherIsBetter: boolean; accent: string;
}) {
  const line = buildSeriesLine(values, 140, 38, 5, higherIsBetter);
  const current = values.length ? values[values.length - 1] : null;
  return (
    <div className="flex-1 rounded-[10px] bg-bg-secondary/60 px-2.5 py-2">
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-[10.5px] text-text-tertiary">{title}</span>
        {current != null && <span className="text-[12px] font-bold text-text-primary">{fmt(current)}</span>}
      </div>
      {line ? (
        <svg width="100%" height="34" viewBox="0 0 140 38" preserveAspectRatio="none" aria-hidden>
          <polyline fill="none" stroke={accent} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" points={line.line} />
          <circle cx={line.lastX} cy={line.lastY} r="2.6" fill={accent} />
        </svg>
      ) : (
        <div className="h-[34px] flex items-center text-[10px] text-text-tertiary">데이터 부족</div>
      )}
    </div>
  );
}

export default function TeamCard({ team, gameSlot }: TeamCardProps) {
  const [data, setData] = useState<TeamCardData | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [topPlayers, setTopPlayers] = useState<TopPlayer[]>([]);
  const accent = getTeamColor(team.id);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/team-card?team=${team.slug}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: TeamCardData | null) => { if (!cancelled) { setData(d && !("error" in d) ? d : null); setLoaded(true); } })
      .catch(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [team.slug]);

  // 순위권 선수 — 공식 랭킹 소스(/api/stats + rankByStat). 리더보드와 동일.
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch(`/api/stats?type=batter&season=2026`).then((r) => (r.ok ? r.json() : [])),
      fetch(`/api/stats?type=pitcher&season=2026`).then((r) => (r.ok ? r.json() : [])),
    ])
      .then(([b, p]) => {
        if (cancelled) return;
        const batters = Array.isArray(b) ? b : (b?.stats ?? []);
        const pitchers = Array.isArray(p) ? p : (p?.stats ?? []);
        setTopPlayers(computeTopPlayers(batters, pitchers, team.shortName));
      })
      .catch(() => { /* 순위권 실패해도 카드 나머지는 정상 */ });
    return () => { cancelled = true; };
  }, [team.shortName]);

  if (loaded && !data?.standing && !data?.nextGame && !data?.recentForm?.length) return null;

  const streak = formatStreak(data?.standing?.streak ?? null);
  const st = data?.standing;
  const rg = data?.rankHistory ? rankPoints(data.rankHistory, 300, 120, 10) : null;

  return (
    <GlassCard className="p-5 mb-3">
      {/* 헤더 — 팀명 옆 화살표 클릭 시 팀 페이지 */}
      <Link href={`/teams/${team.slug}`} className="flex items-center gap-2.5 mb-3.5">
        <TeamLogo team={team} size={34} />
        <span className="text-base font-bold text-text-primary">{team.name}</span>
        <ChevronRight size={18} className="text-text-tertiary -ml-1" />
        <span className="ml-auto text-[10px] font-bold text-white px-1.5 py-0.5 rounded-md" style={{ background: accent }}>MY TEAM</span>
      </Link>

      {!loaded ? (
        <div className="h-24 animate-pulse rounded-xl bg-bg-secondary" />
      ) : (
        <>
          {/* 1. 순위 정보 (클릭 → 순위 페이지) + 최근 5경기 2분할 */}
          {(st || (data?.recentForm?.length ?? 0) > 0) && (
            <div className="flex items-start gap-3">
              {st && (
                <Link href="/standings" className="flex-1 min-w-0 block">
                  <div className="flex items-end gap-2">
                    <span className="text-[34px] font-extrabold leading-none text-text-primary">{st.rank}위</span>
                    {streak && <span className="text-[12px] font-bold pb-1" style={{ color: streak.hot ? "#ff6b6b" : "var(--text-tertiary)" }}>{streak.hot ? "🔥" : ""}{streak.text}</span>}
                  </div>
                  <div className="text-[11px] text-text-secondary leading-[16px] mt-1.5">
                    {st.above && <div>{st.rank - 1}위 {getTeamById(st.above.teamId)?.shortName}와 <b className="text-text-primary">{gapLabel(st.above.gap)}게임차</b></div>}
                    {st.below && <div>{st.rank + 1}위 {getTeamById(st.below.teamId)?.shortName}와 <b className="text-text-primary">{gapLabel(st.below.gap)}게임차</b></div>}
                  </div>
                </Link>
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

          {/* 2. 경기 카드 (임베드) */}
          {gameSlot && <div className="mt-4 border-t border-border/40 pt-3.5">{gameSlot}</div>}

          {/* 3. 그래프 — 좌(전체높이) 순위변동(Y축 1~10위 라벨·빗금) + 우(상하) 타율/방어율 */}
          {rg && (
            <div className="mt-4 border-t border-border/40 pt-3.5">
              <p className="text-[11px] text-text-tertiary mb-2">시즌 순위 변동 · 주간 팀 스탯</p>
              <div className="flex gap-2">
                {/* 좌: 순위 변동 — 클릭 → 팀 순위 페이지. Y축에 1~10위 라벨 + 빗금 */}
                <Link href="/standings" className="flex-[1.3] rounded-[10px] bg-bg-secondary/60 px-1.5 py-2 flex gap-1.5">
                  <div className="flex flex-col justify-between text-[8px] leading-none text-text-tertiary/80 h-[120px] py-[7px]">
                    {Array.from({ length: 10 }, (_, i) => <span key={i}>{i + 1}</span>)}
                  </div>
                  <svg width="100%" height="120" viewBox="0 0 300 120" preserveAspectRatio="none" aria-hidden className="flex-1">
                    {Array.from({ length: 10 }, (_, i) => {
                      const y = rg.yOf(i + 1);
                      return <line key={i} x1="0" y1={y} x2="300" y2={y} stroke="currentColor" className="text-text-tertiary/35" strokeWidth="1" strokeDasharray="5 4" />;
                    })}
                    <polyline fill="none" stroke={accent} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" points={rg.line} />
                    <circle cx={rg.lastX} cy={rg.lastY} r="3.5" fill={accent} />
                  </svg>
                </Link>
                {/* 우: 타율 / 방어율 — 클릭 → 팀 기록 페이지 */}
                <Link href={`/teams/${team.slug}/records`} className="flex-1 flex flex-col gap-2">
                  <MiniStatChart title="주간 팀 타율" values={(data?.weeklyBatting ?? []).map((w) => w.avg)} fmt={(v) => v.toFixed(3)} higherIsBetter accent={accent} />
                  <MiniStatChart title="주간 팀 방어율" values={(data?.weeklyPitching ?? []).map((w) => w.era)} fmt={(v) => v.toFixed(2)} higherIsBetter={false} accent={accent} />
                </Link>
              </div>
            </div>
          )}

          {/* 4. 순위권 선수 — 선수별 묶음, 클릭 → 선수 페이지 */}
          {topPlayers.length > 0 && (
            <div className="mt-4 border-t border-border/40 pt-3.5">
              <p className="text-[11px] text-text-tertiary mb-2">순위권 선수</p>
              <div className="flex flex-col gap-1.5">
                {topPlayers.map((p, i) => {
                  const inner = (
                    <>
                      <span className="font-bold text-text-primary">{p.playerName}</span>{" "}
                      <span className="text-text-secondary">
                        {p.titles.map((t, j) => (
                          <span key={j}>
                            {j > 0 && ", "}
                            {catName(t.category)} <b style={{ color: t.rank === 1 ? "#ffd24a" : "var(--text-secondary)" }}>{t.rank}위</b>
                          </span>
                        ))}
                      </span>
                    </>
                  );
                  return p.href ? (
                    <Link key={i} href={p.href} className="text-[12.5px] flex items-center gap-1">
                      <span className="min-w-0">{inner}</span><ChevronRight size={13} className="text-text-tertiary flex-shrink-0" />
                    </Link>
                  ) : (
                    <div key={i} className="text-[12.5px]">{inner}</div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 5. 커뮤니티 새 글 — 클릭 → 커뮤니티 */}
          {(data?.communityNewPosts ?? 0) > 0 && (
            <Link href="/community" className="mt-4 border-t border-border/40 pt-3.5 flex items-center justify-between">
              <span className="text-[12.5px] text-text-secondary">💬 최근 1주 새 글 <b className="text-text-primary">{data!.communityNewPosts}</b>개</span>
              <ChevronRight size={15} className="text-text-tertiary" />
            </Link>
          )}
        </>
      )}
    </GlassCard>
  );
}
