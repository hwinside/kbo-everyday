"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";
import TeamLogo from "@/components/ui/TeamLogo";
import { getTeamById, type TeamData } from "@/lib/constants/teams";
import { getTeamColor } from "@/lib/utils/team";
import { getCanonicalPlayerHref } from "@/lib/utils/resolve-player";
import { computeRosterMovesGroupedDisplay, teamHomeHref } from "@/lib/roster-moves/readiness";
import { gameResultTone, resultToneChipStyle } from "@/lib/ui/result-tone";

type FormResult = "W" | "L" | "D";

interface TopPlayer { playerName: string; href: string | null; titles: { label: string; rank: number }[] }

interface RosterMove {
  kboPlayerId: string;
  playerName: string;
  moveType: "register" | "deregister";
  moveDate: string;
  href: string | null;
}

type RosterMovesState =
  | { status: "loading"; teamId: number }
  | { status: "error"; teamId: number }
  | { status: "ready"; teamId: number; moves: RosterMove[] };

type StatRow = Record<string, unknown>;
const num = (v: unknown) => Number(v ?? 0) || 0;

// 순위 페이지 타이틀 탭(BatterTitleTab/PitcherTitleTab)과 100% 동일한 부문/자격/정렬.
// 자격: rate 스탯(타율·OPS·출루율·장타율·ERA·WHIP)은 규정타석/이닝 충족(qualifiedRate=1),
//       counting 스탯은 전체. (득점·볼넷·사구·2루타+3루타·출전경기는 탭에 없어 자동 제외)
interface CatDef { key: string; label: string; desc: boolean; pool: "qual" | "all" | "ratefield" }
const BATTER_CATS: CatDef[] = [
  { key: "avg", label: "타율", desc: true, pool: "qual" },
  { key: "hr", label: "홈런", desc: true, pool: "all" },
  { key: "rbi", label: "타점", desc: true, pool: "all" },
  { key: "hits", label: "안타", desc: true, pool: "all" },
  { key: "sb", label: "도루", desc: true, pool: "all" },
  { key: "ops", label: "OPS", desc: true, pool: "ratefield" },
  { key: "obp", label: "출루율", desc: true, pool: "ratefield" },
  { key: "slg", label: "장타율", desc: true, pool: "ratefield" },
];
const PITCHER_CATS: CatDef[] = [
  { key: "era", label: "평균자책", desc: false, pool: "qual" },
  { key: "wins", label: "다승", desc: true, pool: "all" },
  { key: "so", label: "탈삼진", desc: true, pool: "all" },
  { key: "saves", label: "세이브", desc: true, pool: "all" },
  { key: "holds", label: "홀드", desc: true, pool: "all" },
  { key: "whip", label: "WHIP", desc: false, pool: "ratefield" },
];

// 공동 순위(competition ranking), 상위 20 — 타이틀 탭 sorted()와 동일.
function rankPool(rows: StatRow[], key: string, desc: boolean): (StatRow & { _rank: number })[] {
  const arr = [...rows].sort((a, b) => (desc ? num(b[key]) - num(a[key]) : num(a[key]) - num(b[key])));
  let cur = 1;
  return arr.slice(0, 20).map((r, i) => {
    if (i > 0 && num(r[key]) !== num(arr[i - 1][key])) cur = i + 1;
    return { ...r, _rank: cur };
  });
}

// /api/stats(batter+pitcher) → 마이팀 선수별 top5 타이틀 묶음(타이틀 탭과 동일).
function computeTopPlayers(batters: StatRow[], pitchers: StatRow[], teamShort: string): TopPlayer[] {
  const byPlayer = new Map<string, TopPlayer>();
  const qualB = batters.filter((b) => b.qualifiedRate === 1);
  const qualP = pitchers.filter((p) => p.qualifiedRate === 1);
  const collect = (allPool: StatRow[], qualPool: StatRow[], cats: CatDef[]) => {
    for (const c of cats) {
      const pool = c.pool === "qual" ? qualPool : c.pool === "ratefield" ? qualPool.filter((r) => r[c.key]) : allPool;
      for (const r of rankPool(pool, c.key, c.desc)) {
        if (r._rank > 5) continue;
        if (String(r.team ?? "") !== teamShort) continue;
        const name = String(r.name ?? "");
        if (!name) continue;
        const entry = byPlayer.get(name) ?? {
          playerName: name,
          href: getCanonicalPlayerHref({ name, team: teamShort, kboId: r.kboId as string }),
          titles: [],
        };
        entry.titles.push({ label: c.label, rank: r._rank });
        byPlayer.set(name, entry);
      }
    }
  };
  collect(batters, qualB, BATTER_CATS);
  collect(pitchers, qualP, PITCHER_CATS);
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
  weeklyBattingRank?: number | null;
  weeklyPitchingRank?: number | null;
  communityNewPosts?: number;
}

interface TeamCardProps {
  team: TeamData;
  gameSlot?: ReactNode;
  /** Pull-to-refresh 트리거. 값이 바뀌면 순위/주간기록/순위권 선수를 재페치한다. */
  refreshNonce?: number;
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

// 와/과 조사 — 마지막 글자 받침 유무로 판단. 영문 약어(KT·LG·SSG·NC·KIA)는 모음 발음 종결 → 와.
function withGwaWa(name: string): string {
  if (!name) return name;
  const last = name.charCodeAt(name.length - 1);
  if (last >= 0xac00 && last <= 0xd7a3) {
    return (last - 0xac00) % 28 !== 0 ? `${name}과` : `${name}와`;
  }
  return `${name}와`;
}

// 오늘을 포함한 최근 7개 KST 달력일. moveDate가 YYYY-MM-DD라 문자열 비교가 안전하다.
function recentWeekCutoff(): string {
  const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
  const SIX_DAYS_MS = 6 * 24 * 60 * 60 * 1000;
  return new Date(Date.now() + KST_OFFSET_MS - SIX_DAYS_MS).toISOString().slice(0, 10);
}

function shortMoveDate(iso: string): string {
  const [, month, day] = iso.split("-");
  return `${Number(month)}/${Number(day)}`;
}

function MiniStatChart({ title, values, fmt, higherIsBetter, accent, rank }: {
  title: string; values: number[]; fmt: (v: number) => string; higherIsBetter: boolean; accent: string; rank?: number | null;
}) {
  const line = buildSeriesLine(values, 140, 38, 5, higherIsBetter);
  const current = values.length ? values[values.length - 1] : null;
  return (
    <div className="flex min-h-0 flex-1 flex-col rounded-[10px] bg-bg-secondary/60 px-2.5 py-2">
      <div className="flex items-baseline justify-between">
        <span className="text-[10.5px] text-text-tertiary">{title}</span>
        {current != null && <span className="text-[12px] font-bold text-text-primary">{fmt(current)}{rank ? ` (${rank}위)` : ""}</span>}
      </div>
      {line ? (
        <svg width="100%" height="34" viewBox="0 0 140 38" preserveAspectRatio="none" aria-hidden className="mt-1 min-h-0 flex-1">
          <polyline fill="none" stroke={accent} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" points={line.line} />
          <circle cx={line.lastX} cy={line.lastY} r="2.6" fill={accent} />
        </svg>
      ) : (
        <div className="flex min-h-0 flex-1 items-center text-[10px] text-text-tertiary">데이터 부족</div>
      )}
    </div>
  );
}

export default function TeamCard({ team, gameSlot, refreshNonce = 0 }: TeamCardProps) {
  const [data, setData] = useState<TeamCardData | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [topPlayers, setTopPlayers] = useState<TopPlayer[]>([]);
  // 괄호 순위 = team-card API가 그래프와 같은 최신 주차·10구단 competition ranking으로 반환(timebase 일치).
  // 이전 /api/team-records 시즌 누적 순위 fetch는 제거(주간 그래프↔시즌 순위 불일치 사고).
  const [rosterMoves, setRosterMoves] = useState<RosterMovesState>({ status: "loading", teamId: team.id });
  const accent = getTeamColor(team.id);

  useEffect(() => {
    let cancelled = false;
    // cache: no-store — 응답이 `cache-control: public`이라 웹봰 HTTP 캐시가 오래된 그래프를
    // 물고 있다(당겨서 새로고침해도 fetch URL이 동일해 캐시 적중). 항상 서버
    // 최신(순위변동/주간그래프)를 반영하도록 클라 캐시를 우회(CDN s-maxage=300이 origin 보호).
    fetch(`/api/team-card?team=${team.slug}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: TeamCardData | null) => { if (!cancelled) { setData(d && !("error" in d) ? d : null); setLoaded(true); } })
      .catch(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [team.slug, refreshNonce]);

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
  }, [team.shortName, refreshNonce]);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/roster-moves?teamId=${team.id}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d: { moves?: RosterMove[] }) => {
        if (cancelled) return;
        const cutoff = recentWeekCutoff();
        const moves = Array.isArray(d?.moves)
          ? d.moves.filter((m) =>
              m.moveDate >= cutoff && (m.moveType !== "register" || Boolean(m.href)),
            )
          : [];
        setRosterMoves({ status: "ready", teamId: team.id, moves });
      })
      .catch(() => {
        if (!cancelled) setRosterMoves({ status: "error", teamId: team.id });
      });
    return () => { cancelled = true; };
  }, [team.id, refreshNonce]);

  // 경기 링크는 fan-out 결과와 독립이다. team-card 가 빈 응답/실패여도 gameSlot 이 있으면
  // 카드 자체를 유지해 MY TEAM 경기 진입 동선을 없애지 않는다.
  if (loaded && !gameSlot && !data?.standing && !data?.nextGame && !data?.recentForm?.length) return null;

  const streak = formatStreak(data?.standing?.streak ?? null);
  const st = data?.standing;
  const rg = data?.rankHistory ? rankPoints(data.rankHistory, 300, 96, 6) : null;
  const currentRosterMoves: RosterMovesState =
    rosterMoves.teamId === team.id ? rosterMoves : { status: "loading", teamId: team.id };

  return (
    <GlassCard className="p-5 mb-3">
      {/* 헤더 — 팀명 옆 화살표 클릭 시 팀 페이지 */}
      <Link href={`/teams/${team.slug}`} prefetch={false} className="flex items-center gap-2.5 mb-3.5">
        <TeamLogo team={team} size={34} />
        <span className="text-base font-bold text-text-primary">{team.name}</span>
        <ChevronRight size={18} className="text-text-tertiary -ml-1" />
        <span className="ml-auto text-[10px] font-bold text-white px-1.5 py-0.5 rounded-md" style={{ background: accent }}>MY TEAM</span>
      </Link>

      {/* 1. 순위 정보 (클릭 → 순위 페이지) + 최근 5경기 2분할 — 항상 최상단 */}
      {!loaded ? (
        <div className="h-24 animate-pulse rounded-xl bg-bg-secondary" />
      ) : (
        <>
          {(st || (data?.recentForm?.length ?? 0) > 0) && (
            <div className="flex items-start gap-3">
              {st && (
                <Link href="/standings" prefetch={false} className="flex-1 min-w-0 block">
                  <div className="flex items-end gap-2">
                    <span className="text-[34px] font-extrabold leading-none text-text-primary">{st.rank}위</span>
                    {streak && <span className="text-[12px] font-bold pb-1" style={{ color: streak.hot ? "#ff6b6b" : "var(--text-tertiary)" }}>{streak.hot ? "🔥" : ""}{streak.text}</span>}
                  </div>
                  <div className="text-[11px] text-text-secondary leading-[16px] mt-1.5">
                    {st.above && <div>{st.rank - 1}위 {withGwaWa(getTeamById(st.above.teamId)?.shortName ?? "")} <b className="text-text-primary">{gapLabel(st.above.gap)}게임차</b></div>}
                    {st.below && <div>{st.rank + 1}위 {withGwaWa(getTeamById(st.below.teamId)?.shortName ?? "")} <b className="text-text-primary">{gapLabel(st.below.gap)}게임차</b></div>}
                  </div>
                </Link>
              )}
              {data?.recentForm && data.recentForm.length > 0 && (
                <div className="flex-shrink-0 text-right">
                  <p className="text-[11px] text-text-tertiary mb-2">최근 {data.recentForm.length}경기</p>
                  <div className="flex gap-1.5 justify-end">
                    {data.recentForm.map((r, i) => (
                      <span key={i} className="w-[22px] h-[22px] rounded-[7px] flex items-center justify-center text-[11px] font-extrabold"
                        style={resultToneChipStyle(gameResultTone(r))}>
                        {r === "W" ? "승" : r === "L" ? "패" : "무"}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

        </>
      )}

      {/* 2. 경기 카드 (임베드) — fan-out(loaded)과 독립 렌더는 유지하되, 위치는 순위 정보 아래(#1156 이전 순서 원복).
          team-card 지연/실패여도 gameSlot 클릭 가능 시점은 늦춰지지 않는다(순위 스켈레톤 아래 즉시 렌더). */}
      {gameSlot && <div className="mt-4 border-t border-border/40 pt-3.5">{gameSlot}</div>}

      {loaded && (
        <>
          {/* 3. 그래프 — 좌(전체높이) 순위변동(Y축 1~10위 라벨·빗금) + 우(상하) 타율/방어율 */}
          {rg && (
            <div className="mt-4 border-t border-border/40 pt-3.5">
              <div className="flex items-stretch gap-2">
                {/* 좌: 순위 변동 — 클릭 → 팀 순위 페이지. Y축에 1~10위 라벨 + 빗금 */}
                <Link href="/standings" prefetch={false} className="flex h-[136px] flex-1 flex-col rounded-[10px] bg-bg-secondary/60 px-1.5 py-2">
                  <span className="px-0.5 text-[10.5px] leading-[14px] text-text-tertiary">시즌 순위 변동</span>
                  <div className="mt-2 flex min-h-0 flex-1 gap-1.5">
                    <div className="flex h-full flex-col justify-between py-[6px] text-[8px] leading-none text-text-tertiary/80">
                      {Array.from({ length: 10 }, (_, i) => <span key={i}>{i + 1}</span>)}
                    </div>
                    <svg width="100%" height="96" viewBox="0 0 300 96" preserveAspectRatio="none" aria-hidden className="min-h-0 flex-1">
                      {Array.from({ length: 10 }, (_, i) => {
                        const y = rg.yOf(i + 1);
                        return <line key={i} x1="0" y1={y} x2="300" y2={y} stroke="currentColor" className="text-text-tertiary/35" strokeWidth="1" strokeDasharray="5 4" />;
                      })}
                      <polyline fill="none" stroke={accent} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" points={rg.line} />
                      <circle cx={rg.lastX} cy={rg.lastY} r="3.5" fill={accent} />
                    </svg>
                  </div>
                </Link>
                {/* 우: 타율 / 방어율 — 클릭 → 팀 기록 페이지 */}
                <Link href={`/teams/${team.slug}/records`} prefetch={false} className="flex h-[136px] flex-1 flex-col gap-2">
                  <MiniStatChart title="주간 팀 타율" values={(data?.weeklyBatting ?? []).map((w) => w.avg)} fmt={(v) => v.toFixed(3).replace(/^0\./, ".")} higherIsBetter accent={accent} rank={data?.weeklyBattingRank ?? null} />
                  <MiniStatChart title="주간 팀 방어율" values={(data?.weeklyPitching ?? []).map((w) => w.era)} fmt={(v) => v.toFixed(2)} higherIsBetter={false} accent={accent} rank={data?.weeklyPitchingRank ?? null} />
                </Link>
              </div>
            </div>
          )}

          {/* 4. 순위권 선수 — 선수별 묶음, 클릭 → 선수 페이지 */}
          {topPlayers.length > 0 && (
            <div className="mt-4 border-t border-border/40 pt-3.5">
              <p className="text-[11px] text-text-tertiary mb-2">순위권 선수</p>
              <div className="flex flex-wrap items-start gap-x-1.5 gap-y-0.5">
                {topPlayers.map((p, i) => {
                  const isLong = p.titles.length >= 4;
                  const inner = (
                    <>
                      <span className="font-bold text-text-primary">{p.playerName}</span>{" "}
                      <span className="text-text-secondary">
                        {p.titles.map((t, j) => (
                          <span key={j}>
                            {j > 0 && ", "}
                            {t.label} <b style={{ color: t.rank === 1 ? "#ffd24a" : "var(--text-secondary)" }}>{t.rank}위</b>
                          </span>
                        ))}
                      </span>
                    </>
                  );
                  const itemClassName = [
                    "inline-flex max-w-full items-center gap-0.5 rounded-full border border-border bg-white/[0.05] px-1.5 py-0.5 text-[11px] leading-[15px]",
                    isLong ? "basis-full rounded-[10px]" : "",
                  ].join(" ");
                  return p.href ? (
                    <Link key={i} href={p.href} prefetch={false} className={itemClassName}>
                      <span className="min-w-0 whitespace-normal">{inner}</span><ChevronRight size={12} className="text-text-tertiary flex-shrink-0" />
                    </Link>
                  ) : (
                    <div key={i} className={itemClassName}>
                      <span className="min-w-0 whitespace-normal">{inner}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 5. 최근 7일 등록·말소 */}
          <div className="mt-4 border-t border-border/40 pt-3.5">
            <p className="text-[11px] text-text-tertiary mb-2">최근 7일 등록·말소</p>
            {currentRosterMoves.status === "loading" ? (
              <div className="h-7 animate-pulse rounded-lg bg-bg-secondary" />
            ) : currentRosterMoves.status === "error" ? (
              <p className="text-[12px] text-text-tertiary">등록·말소 내역을 불러오지 못했어요.</p>
            ) : currentRosterMoves.moves.length === 0 ? (
              <Link href={teamHomeHref(team.slug)} prefetch={false} className="block text-[12px] text-text-tertiary">
                최근 7일 변동이 없어요.
              </Link>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {computeRosterMovesGroupedDisplay(currentRosterMoves.moves).visibleGroups.map((group) => (
                  <li key={group.date} className="relative">
                    {/* 행 배경(날짜·chevron 영역) → 팀홈. absolute 형제라 중첩 anchor 없음 */}
                    <Link
                      href={teamHomeHref(team.slug)}
                      prefetch={false}
                      aria-label={`${team.name} 팀 페이지`}
                      className="absolute inset-0 z-0"
                    />
                    <div className="pointer-events-none relative z-10 flex items-center gap-2 py-0.5">
                      <span className="w-8 flex-shrink-0 text-[11px] text-text-tertiary">{shortMoveDate(group.date)}</span>
                      {/* 한 줄 강제: nowrap + overflow-hidden (삼순 NO-GO 반영 — flex-wrap 제거) */}
                      <div className="flex min-w-0 flex-1 flex-nowrap items-center gap-x-2 overflow-hidden">
                        {group.moves.map((move, index) => {
                          const isRegister = move.moveType === "register";
                          const label = isRegister ? "등록" : "말소";
                          // 긍부정 색·배경 모두 이 파일 위쪽 `최근 N경기` 칩과 같은 SSOT(@/lib/ui/result-tone).
                          // ⚠️ 배경을 `${color}1f` 로 파생 생성하면 SSOT 배경값을 우회한다(삼순 3차 지적).
                          return (
                            <span
                              key={`${move.moveType}-${move.kboPlayerId}-${index}`}
                              className="inline-flex min-w-0 items-center gap-1"
                            >
                              <span
                                className="flex-shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-bold"
                                style={resultToneChipStyle(isRegister ? "positive" : "negative")}
                              >
                                {label}
                              </span>
                              {move.href ? (
                                <Link
                                  href={move.href}
                                  prefetch={false}
                                  className="pointer-events-auto truncate text-[12.5px] font-semibold text-text-primary"
                                >
                                  {move.playerName}
                                </Link>
                              ) : (
                                <span className="truncate text-[12.5px] font-semibold text-text-primary">
                                  {move.playerName}
                                </span>
                              )}
                            </span>
                          );
                        })}
                        {group.hiddenInGroup > 0 && (
                          <span className="flex-shrink-0 text-[11.5px] text-text-tertiary">외 {group.hiddenInGroup}명</span>
                        )}
                      </div>
                      <ChevronRight size={14} className="flex-shrink-0 text-text-tertiary" />
                    </div>
                  </li>
                ))}
                {computeRosterMovesGroupedDisplay(currentRosterMoves.moves).overflowCount > 0 && (
                  <li>
                    <Link
                      href={teamHomeHref(team.slug)}
                      prefetch={false}
                      className="flex items-center justify-between py-0.5 text-[12px] text-text-secondary"
                    >
                      <span>외 {computeRosterMovesGroupedDisplay(currentRosterMoves.moves).overflowCount}건 더보기</span>
                      <ChevronRight size={14} className="flex-shrink-0 text-text-tertiary" />
                    </Link>
                  </li>
                )}
              </ul>
            )}
          </div>

          {/* 6. 커뮤니티 새 글 — 클릭 → 커뮤니티 */}
          {(data?.communityNewPosts ?? 0) > 0 && (
            <Link href="/community" prefetch={false} className="mt-4 border-t border-border/40 pt-3.5 flex items-center justify-between">
              <span className="text-[12.5px] text-text-secondary">💬 최근 1주 새 글 <b className="text-text-primary">{data!.communityNewPosts}</b>개</span>
              <ChevronRight size={15} className="text-text-tertiary" />
            </Link>
          )}
        </>
      )}
    </GlassCard>
  );
}
