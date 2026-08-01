"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import {
  BarChart3,
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  CloudRain,
  Flame,
  Info,
  MapPin,
  RefreshCw,
  Sparkles,
  Star,
  Swords,
  Target,
  Trophy,
} from "lucide-react";
import { useSafeBack } from "@/lib/hooks/useSafeBack";
import { useAuth } from "@/lib/supabase/AuthContext";
import { getSafeSession } from "@/lib/supabase/client";
import { getPlayerPhotoUrl } from "@/lib/constants/player-photos";
import { getTeamById } from "@/lib/constants/teams";
import type {
  A1Value,
  A2Cell,
  A3Cell,
  A4Cell,
  A5Cell,
  A6Cell,
  B1Value,
  B2Value,
  B3Value,
  B4Value,
  C1Entry,
  C2Entry,
  C4Entry,
  C5Entry,
  D1Value,
  D5Value,
  D6Value,
  E1Value,
  MetricEnvelope,
  ScopeName,
  VenueStatsScopePayload,
} from "@/lib/venue-stats/types";
import {
  buildVenueStatsHero,
  coverageCaption,
  formatAvg,
  formatEra,
  formatOuts,
  formatRate,
  formatSigned,
  METRIC_STATE_LABELS,
  splitCells,
  metricEvidence,
} from "@/lib/venue-stats/ui";
// 순수 leaf 모듈에서 가져온다 — aggregate.ts 는 node 전용 의존(node:crypto)을 끌어서
// 클라이언트 번들에서 import 하면 안 된다.
import { MIN_FINAL_GAMES } from "@/lib/venue-stats/state";

interface VenueStatsResponse {
  season: number;
  seasonSupport: { status: "supported" | "attendance_only" | "unsupported"; supportedSeason: number };
  overall: VenueStatsScopePayload;
  gps: VenueStatsScopePayload;
}

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
const SEASONS = [2026, 2025] as const;

function StatState({ metric }: { metric: MetricEnvelope }) {
  const good = metric.state === "ready";
  if (good) return null;
  return (
    <div className="mt-1 flex items-center justify-between gap-2 text-[9px] font-semibold">
      <span className="text-amber-300/90">
        {METRIC_STATE_LABELS[metric.state] ?? metric.state}
      </span>
      <span className="text-white/70">{metricEvidence(metric)}</span>
    </div>
  );
}
function MetricCard({
  title,
  value,
  comparison,
  metric,
  accent = "text-white",
  icon,
}: {
  title: string;
  value: string;
  comparison?: string;
  metric: MetricEnvelope;
  accent?: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="min-w-0 rounded-xl border border-white/8 bg-[#151519] p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-[10px] font-bold text-white/70">{icon}{title}</p>
        <span className="text-[9px] font-semibold text-white/60">{metric.n}경기 기준</span>
      </div>
      <p className={`mt-0.5 text-[23px] font-black leading-tight tracking-tight ${accent}`}>{value}</p>
      {comparison && <p className="mt-0.5 text-[10px] font-semibold text-white/70">{comparison}</p>}
      <StatState metric={metric} />
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-2 mt-4 px-0.5 text-[14px] font-black text-white">{children}</h2>;
}

function SplitList({
  title,
  rows,
  metric,
}: {
  title: string;
  rows: Array<{ key: string; label: string; value: string; sampleLimited?: boolean }>;
  metric: MetricEnvelope;
}) {
  return (
    <div className="rounded-2xl border border-white/8 bg-white/[0.045] p-4">
      <p className="text-[12px] font-extrabold text-white/70">{title}</p>
      <div className="mt-2.5 space-y-2">
        {rows.slice(0, 4).map((row) => (
          <div key={row.key} className="flex items-center justify-between gap-3 text-[13px]">
            <span className="truncate text-white/70">{row.label}</span>
            <span className="flex shrink-0 items-center gap-1.5">
              <span className="font-extrabold text-white">{row.value}</span>
              {/* 표본 미달 cell 은 사실값을 보여주되 참고용임을 행 단위로 표시한다. */}
              {row.sampleLimited && (
                <span className="rounded-full border border-amber-300/45 px-1.5 py-0.5 text-[9px] font-black text-amber-300">
                  참고용
                </span>
              )}
            </span>
          </div>
        ))}
        {rows.length === 0 && <p className="text-[12px] text-white/70">표시할 기록이 없어요</p>}
      </div>
      <StatState metric={metric} />
    </div>
  );
}

export default function VenueStatsDashboard() {
  const { user, profile } = useAuth();
  const goBack = useSafeBack("/my");
  const [season, setSeason] = useState<number>(2026);
  const [scopeName, setScopeName] = useState<ScopeName>("overall");
  const [data, setData] = useState<{ season: number; payload: VenueStatsResponse } | null>(null);
  // 실패는 "어느 시즌이 실패했는가"로 보관한다.
  // 로딩 여부는 별도 state 없이 (현재 시즌 데이터 없음 + 현재 시즌 실패 아님)으로 파생시켜
  // 시즌 전환 직후에도 effect 안 setState 없이 즉시 로딩 UI로 수렴한다.
  const [failedSeason, setFailedSeason] = useState<number | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const requestGeneration = useRef(0);
  const requestController = useRef<AbortController | null>(null);

  const userId = user?.id ?? null;

  // 시즌 선택은 사용자 event에서만 일어난다.
  // 이전에 실패했던 시즌을 다시 고를 때 묵은 실패가 한 프레임 다시 보이지 않도록
  // 선택과 같은 틱에 실패 상태를 무효화한다(effect 아닌 event 경로).
  const selectSeason = (nextSeason: number) => {
    setSeason(nextSeason);
    setFailedSeason(null);
  };

  const load = useCallback(async (generation?: number) => {
    if (!userId) return;
    const activeGeneration = generation ?? requestGeneration.current + 1;
    requestGeneration.current = activeGeneration;
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    setFailedSeason((current) => (current === season ? null : current));
    try {
      const token = (await getSafeSession())?.access_token;
      if (!token) throw new Error("missing session");
      const res = await fetch(`/api/me/venue-stats?season=${season}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
        signal: controller.signal,
      });
      if (!res.ok) throw new Error("request failed");
      const nextData = (await res.json()) as VenueStatsResponse;
      if (requestGeneration.current === activeGeneration && !controller.signal.aborted) {
        setData({ season, payload: nextData });
      }
    } catch (error) {
      if (
        requestGeneration.current === activeGeneration &&
        !controller.signal.aborted &&
        !(error instanceof DOMException && error.name === "AbortError")
      ) {
        setFailedSeason(season);
      }
    }
  }, [season, userId]);

  useEffect(() => {
    if (!userId) return;
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    requestController.current?.abort();
    const timer = window.setTimeout(() => void load(generation), 0);
    return () => {
      window.clearTimeout(timer);
      if (requestGeneration.current === generation) requestController.current?.abort();
    };
  }, [load, userId]);

  // 표시 데이터는 현재 선택 시즌과 결속한다(다른 시즌 응답은 표시 대상이 아니다).
  const activeData = data && data.season === season ? data.payload : null;
  const showFailure = !activeData && failedSeason === season;
  const showLoading = !activeData && !showFailure;
  const scope = activeData?.[scopeName] ?? null;
  const hero = useMemo(() => (scope ? buildVenueStatsHero(scope) : null), [scope]);
  const favoriteById = useMemo(
    () => new Map((profile?.favorite_players ?? []).map((player) => [player.playerId, player])),
    [profile?.favorite_players],
  );

  const a1 = scope?.metrics.A1 as MetricEnvelope<A1Value> | undefined;
  const b1 = scope?.metrics.B1 as MetricEnvelope<B1Value> | undefined;
  const b2 = scope?.metrics.B2 as MetricEnvelope<B2Value> | undefined;
  const b3 = scope?.metrics.B3 as MetricEnvelope<B3Value> | undefined;
  const b4 = scope?.metrics.B4 as MetricEnvelope<B4Value> | undefined;
  const c1 = scope?.metrics.C1 as MetricEnvelope<C1Entry[]> | undefined;
  const c2 = scope?.metrics.C2 as MetricEnvelope<C2Entry[]> | undefined;
  const c4 = scope?.metrics.C4 as MetricEnvelope<C4Entry[]> | undefined;
  const c5 = scope?.metrics.C5 as MetricEnvelope<C5Entry[]> | undefined;
  const d1 = scope?.metrics.D1 as MetricEnvelope<D1Value> | undefined;
  const d5 = scope?.metrics.D5 as MetricEnvelope<D5Value> | undefined;
  const d6 = scope?.metrics.D6 as MetricEnvelope<D6Value> | undefined;
  const e1 = scope?.metrics.E1 as MetricEnvelope<E1Value> | undefined;

  const c1ById = new Map((c1?.value ?? []).map((entry) => [entry.playerId, entry]));
  const c2ById = new Map((c2?.value ?? []).map((entry) => [entry.playerId, entry]));
  const c4ById = new Map((c4?.value ?? []).map((entry) => [entry.playerId, entry]));
  const favoriteIds = [...new Set([...c1ById.keys(), ...c2ById.keys(), ...c4ById.keys()])];
  const mixedBTeamIds = hero?.mixedTeam
    ? [...new Set(
        [b1, b2, b3, b4]
          .flatMap((metric) => metric?.items ?? [])
          .map((item) => Number(item.key))
          .filter(Number.isInteger),
      )]
    : [];
  const opponentCells = scope ? splitCells<A2Cell>(scope.metrics.A2) : [];
  const stadiumCells = scope ? splitCells<A3Cell>(scope.metrics.A3) : [];
  const weekdayCells = scope ? splitCells<A4Cell>(scope.metrics.A4) : [];
  const bestOpponent = [...opponentCells]
    .filter(({ cell }) => cell.w + cell.l + cell.d >= 2)
    .sort((a, b) => (b.cell.w + b.cell.l + b.cell.d) - (a.cell.w + a.cell.l + a.cell.d))[0];
  const bestStadium = [...stadiumCells]
    .filter(({ cell }) => cell.w + cell.l + cell.d >= 2)
    .sort((a, b) => (b.cell.w + b.cell.l + b.cell.d) - (a.cell.w + a.cell.l + a.cell.d))[0];
  const saturday = weekdayCells.find(({ cell }) => cell.weekday === 6 && cell.w + cell.l + cell.d > 0);
  const hrGames = b4?.denominator?.attendanceFinalGames ?? b4?.n ?? 0;
  const homeRunsSeen = b4?.value?.hr?.attendancePerGame == null
    ? 0
    : Math.round(b4.value.hr.attendancePerGame * hrGames);
  const interestingFacts: Array<{ key: string; label: string; value: string; icon: React.ReactNode }> = [];
  if (bestStadium) interestingFacts.push({
    key: "stadium", label: bestStadium.cell.stadium,
    value: `${bestStadium.cell.w}승 ${bestStadium.cell.l}패`,
    icon: <MapPin size={16} className="text-sky-300" />,
  });
  if (saturday) interestingFacts.push({
    key: "saturday", label: "토요일", value: `승률 ${formatRate(saturday.cell.rate, 0)}`,
    icon: <CalendarDays size={16} className="text-rose-300" />,
  });
  if (bestOpponent) interestingFacts.push({
    key: "opponent",
    label: `${getTeamById(bestOpponent.cell.opponentTeamId)?.shortName ?? `팀 ${bestOpponent.cell.opponentTeamId}`}전`,
    value: `${bestOpponent.cell.w}승 ${bestOpponent.cell.l}패`,
    icon: <Swords size={16} className="text-orange-300" />,
  });
  if (homeRunsSeen > 0) interestingFacts.push({
    key: "home-runs", label: "홈런", value: `${homeRunsSeen}개 목격`,
    icon: <span className="text-[16px] leading-none">⚾</span>,
  });
  if ((e1?.value?.longest ?? 0) >= 2) interestingFacts.push({
    key: "streak", label: "연속 직관", value: `최장 ${e1!.value!.longest}경기`,
    icon: <Flame size={16} className="text-amber-300" />,
  });
  if ((d5?.value?.cancelledCount ?? 0) > 0) interestingFacts.push({
    key: "cancelled", label: "우천·취소", value: `${d5!.value!.cancelledCount}회`,
    icon: <CloudRain size={16} className="text-blue-300" />,
  });
  if (d6?.value?.maxTeamRuns) interestingFacts.push({
    key: "max-runs", label: "최다 득점", value: `${d6.value.maxTeamRuns.runs}점`,
    icon: <Target size={16} className="text-emerald-300" />,
  });
  if ((d1?.value?.closeGames ?? 0) > 0) interestingFacts.push({
    key: "close-games", label: "1점차 승부", value: `${d1!.value!.closeGames}경기`,
    icon: <Trophy size={16} className="text-violet-300" />,
  });
  const visibleInterestingFacts = interestingFacts.slice(0, 6);

  if (!user) return null;

  return (
    <div
      data-testid="venue-stats-dashboard"
      className="mx-auto min-h-screen max-w-lg bg-[#0A0A0B] px-5 pb-28 text-white"
    >
      <header
        className="sticky top-0 z-30 -mx-5 flex min-h-[52px] items-center gap-2 border-b border-white/8 bg-[#0A0A0B]/95 px-3 backdrop-blur-xl"
        // 공용 고정헤더 규격: 부모 `main.pt-safe`가 이미 safe-area를 주므로
        // padding만 더하면 이중 적용된다. 음수 marginTop으로 상쇄해야
        // 상단 여백이 정상이고 sticky top-0 기준도 상태바 아래에 고정된다.
        style={{
          paddingTop: "env(safe-area-inset-top, 0px)",
          marginTop: "calc(env(safe-area-inset-top, 0px) * -1)",
        }}
      >
        <button onClick={goBack} aria-label="뒤로가기" className="flex h-11 w-11 items-center justify-center">
          <ChevronLeft size={26} />
        </button>
        <h1 className="flex-1 text-[18px] font-black">직관 통계</h1>
        <div className="flex h-11 w-11 items-center justify-center text-white/65" aria-label="통계 안내">
          <Info size={21} />
        </div>
      </header>

      <div className="mt-3 flex items-center gap-2">
        <label className="relative">
          <select
            value={season}
            onChange={(event) => selectSeason(Number(event.target.value))}
            className="h-9 appearance-none rounded-full border border-white/10 bg-white/[0.06] pl-4 pr-9 text-[12px] font-extrabold text-white outline-none"
          >
            {SEASONS.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
          <ChevronDown size={13} className="pointer-events-none absolute right-3 top-[11px] text-white/60" />
        </label>
        <div className="grid min-w-0 flex-1 grid-cols-2 rounded-full border border-white/10 bg-white/[0.05] p-0.5">
          {([["overall", "전체 기록"], ["gps", "GPS 인증만"]] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setScopeName(key)}
              className={`rounded-full py-2 text-[11px] font-black transition-colors ${
                scopeName === key
                  ? "bg-gradient-to-r from-[#ee4055] to-[#c8324c] text-white shadow-[0_3px_12px_rgba(238,64,85,.24)]"
                  : "text-white/70"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {showLoading ? (
        <div className="mt-5 space-y-3">
          <div className="h-52 animate-pulse rounded-2xl bg-white/[0.05]" />
          <div className="h-28 animate-pulse rounded-2xl bg-white/[0.05]" />
        </div>
      ) : showFailure ? (
        <button
          onClick={() => void load()}
          className="mt-6 flex w-full items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/[0.05] py-5 text-sm font-bold text-white/70"
        >
          <RefreshCw size={16} /> 통계를 불러오지 못했어요 · 다시 시도
        </button>
      ) : scope && hero && a1 ? (
        <>
          <section className="relative mt-3 overflow-hidden rounded-2xl border border-[#ff5263]/50 bg-[radial-gradient(circle_at_88%_8%,rgba(255,82,99,0.22),transparent_34%),linear-gradient(145deg,#241318,#111114_72%)] p-4 shadow-[0_10px_35px_rgba(255,69,84,0.1)]">
            <Sparkles className="absolute right-4 top-4 text-[#ff9aa5]" size={24} />
            <p className="text-[12px] font-black text-[#ff9aa5]">나의 직관 요정 지수</p>
            <div className="mt-1.5 flex items-end gap-2">
              <span className="text-[54px] font-black leading-none tracking-[-0.06em]">
                {hero.score ?? "–"}
              </span>
              {hero.score != null && <span className="mb-1 text-[16px] font-extrabold text-white/70">점</span>}
              {/* 표본 가드 미달이면 사실값은 그대로 두고 배지로만 참고용임을 알린다.
                  mixed_team 이어도 총 final 이 모자라면 참고용 — hero.sampleLimited 가 SSOT. */}
              <span
                className={`mb-1 rounded-full border px-2.5 py-1 text-[11px] font-black ${
                  hero.sampleLimited
                    ? "border-amber-300/55 text-amber-300"
                    : "border-[#ff596a]/55 text-[#ff9aa5]"
                }`}
              >
                {hero.sampleLimited ? METRIC_STATE_LABELS.sample_limited : "승률 요정"}
              </span>
            </div>
            <div className="mt-2 flex items-center gap-2.5 text-[14px] font-black">
              <span className="text-sky-400">{hero.attendance?.w ?? 0}승</span>
              <span className="text-rose-300">{hero.attendance?.l ?? 0}패</span>
              <span className="text-white/65">{hero.attendance?.d ?? 0}무</span>
              <span>·</span>
              <span>승률 {formatRate(hero.attendance?.rate)}</span>
            </div>
            <p className="mt-1.5 text-[11px] font-semibold text-white/70">
              {hero.sampleLimited
                ? `종료 경기 ${a1.n}경기 기록이에요 · ${MIN_FINAL_GAMES}경기부터 팀 시즌 비교를 보여드려요`
                : hero.mixedTeam
                  ? "응원팀 변경 포함 · 팀별 구간은 아래에서 확인"
                  : hero.deltaPp == null
                    ? "팀 시즌 비교값을 확인 중이에요"
                    : `팀 시즌 승률 ${formatRate(hero.teamRate)}보다 ${formatSigned(hero.deltaPp, 1, "%p")}`}
            </p>
            {hero.teamIds.length > 0 && (
              <div className="mt-3 flex items-center gap-1.5 overflow-hidden rounded-lg border border-white/8 bg-white/[0.035] px-2.5 py-2">
                {hero.teamIds.map((teamId) => {
                  const team = getTeamById(teamId);
                  return (
                    <span key={teamId} className="inline-flex shrink-0 items-center gap-1 rounded-full bg-white/[0.06] px-1.5 py-0.5 text-[9px] font-bold text-white/70">
                      {team && <Image src={team.logoPath} alt="" width={14} height={14} unoptimized />}
                      {team?.shortName ?? `팀 ${teamId}`}
                    </span>
                  );
                })}
                <span className="ml-auto truncate text-[9px] text-white/70">{metricEvidence(a1)}</span>
              </div>
            )}
          </section>

          {scope.state === "empty" ? (
            <div className="mt-5 rounded-2xl border border-white/8 bg-white/[0.04] px-5 py-10 text-center">
              <Trophy className="mx-auto text-white/70" size={28} />
              <p className="mt-3 text-sm font-extrabold text-white/70">아직 직관 통계가 없어요</p>
              <p className="mt-1 text-xs text-white/70">직관 기록이 쌓이면 요정 지수와 상세 통계가 열려요</p>
            </div>
          ) : (
            <>
              <SectionTitle>내가 간 경기, 우리 팀은</SectionTitle>
              {!hero.mixedTeam && (
                <div className="grid grid-cols-2 gap-2">
                  {/* 표본 미달이면 baseline이 null로 내려오므로 비교문구 자체를 감춘다("시즌 – · –" 방지). */}
                  <MetricCard
                    title="팀 타율"
                    value={formatAvg(b1?.value?.attendanceAvg)}
                    comparison={b1?.value?.seasonAvg != null ? `시즌 ${formatAvg(b1.value.seasonAvg)} · ${formatSigned(b1.value.delta, 3)}` : undefined}
                    metric={b1!}
                    accent="text-emerald-300"
                    icon={<span className="text-[12px]">⚾</span>}
                  />
                  <MetricCard
                    title="평균 득점"
                    value={b3?.value?.runsPerGame == null ? "–" : b3.value.runsPerGame.toFixed(1)}
                    comparison={b3?.value ? `${b3.value.totalRuns}득점` : undefined}
                    metric={b3!}
                    accent="text-amber-300"
                    icon={<Target size={12} />}
                  />
                  <MetricCard
                    title="팀 ERA"
                    value={formatEra(b2?.value?.attendanceEra)}
                    comparison={b2?.value?.seasonEra != null ? `시즌 ${formatEra(b2.value.seasonEra)} · ${formatSigned(b2.value.delta, 2)}` : undefined}
                    metric={b2!}
                    accent="text-sky-300"
                    icon={<span className="text-[12px]">⚾</span>}
                  />
                  <MetricCard
                    title="홈런"
                    value={b4?.value?.hr?.attendancePerGame == null ? "–" : b4.value.hr.attendancePerGame.toFixed(1)}
                    comparison={b4?.value?.hr?.seasonPerGame != null ? `시즌 경기당 ${b4.value.hr.seasonPerGame.toFixed(1)}` : undefined}
                    metric={b4!}
                    accent="text-rose-300"
                    icon={<Flame size={12} />}
                  />
                </div>
              )}
              {mixedBTeamIds.length > 0 && (
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {mixedBTeamIds.map((teamId) => {
                    const key = String(teamId);
                    const b1Item = b1?.items?.find((item) => item.key === key);
                    const b2Item = b2?.items?.find((item) => item.key === key);
                    const b3Item = b3?.items?.find((item) => item.key === key);
                    const b4Item = b4?.items?.find((item) => item.key === key);
                    const b1Value = b1Item?.value as B1Value | null | undefined;
                    const b2Value = b2Item?.value as B2Value | null | undefined;
                    const b3Value = b3Item?.value as B3Value | null | undefined;
                    const b4Value = b4Item?.value as B4Value | null | undefined;
                    const items = [b1Item, b2Item, b3Item, b4Item].filter(
                      (item): item is NonNullable<typeof item> => item != null,
                    );
                    const ready = items.some((item) => item.state === "ready");
                    const team = getTeamById(teamId);
                    return (
                      <div key={teamId} className="rounded-xl border border-white/8 bg-[#151519] p-3">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-[11px] font-black text-white/75">
                            {team?.shortName ?? `팀 ${teamId}`} 응원 구간
                          </span>
                          <span className="text-[10px] font-semibold text-white/70">
                            {ready
                              ? `${Math.max(...items.map((item) => item.n))}경기`
                              : METRIC_STATE_LABELS[items[0]?.state ?? "empty"]}
                          </span>
                        </div>
                        <div className="mt-2 grid grid-cols-2 gap-x-1 gap-y-2 text-center">
                          <div>
                            <p className="text-[9px] text-white/70">타율</p>
                            <p className="mt-0.5 text-[12px] font-black">{formatAvg(b1Value?.attendanceAvg)}</p>
                          </div>
                          <div>
                            <p className="text-[9px] text-white/70">ERA</p>
                            <p className="mt-0.5 text-[12px] font-black">{formatEra(b2Value?.attendanceEra)}</p>
                          </div>
                          <div>
                            <p className="text-[9px] text-white/70">득점</p>
                            <p className="mt-0.5 text-[12px] font-black">{b3Value?.runsPerGame?.toFixed(1) ?? "–"}</p>
                          </div>
                          <div>
                            <p className="text-[9px] text-white/70">홈런</p>
                            <p className="mt-0.5 text-[12px] font-black">{b4Value?.hr?.attendancePerGame?.toFixed(1) ?? "–"}</p>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              <SectionTitle>내 앞에서 더 빛난 최애</SectionTitle>
              <div className="space-y-2">
                {favoriteIds.length === 0 ? (
                  <div className="rounded-2xl border border-white/8 bg-white/[0.045] p-4 text-sm font-semibold text-white/70">
                    {METRIC_STATE_LABELS[c1?.state ?? "no_favorite"]}
                  </div>
                ) : favoriteIds.map((playerId) => {
                  const player = favoriteById.get(playerId);
                  const batter = c1ById.get(playerId);
                  const pitcher = c2ById.get(playerId);
                  const highlight = c4ById.get(playerId);
                  const topGame = c5?.value?.find((entry) => entry.playerId === playerId);
                  const team = player ? getTeamById(player.teamId) : null;
                  const photoUrl = player ? getPlayerPhotoUrl(player.name, playerId, player.teamId) : null;
                  const attendanceValue = batter ? formatAvg(batter.attendanceAvg) : formatEra(pitcher?.attendanceEra);
                  const seasonValue = batter ? formatAvg(batter.seasonAvg) : formatEra(pitcher?.seasonEra);
                  const boostLabel = batter?.deltaAvg != null
                    ? `타율 ${formatSigned(batter.deltaAvg, 3).replace("+0.", "+.")}`
                    : pitcher?.eraImprovement != null
                      ? `ERA ${formatSigned(pitcher.eraImprovement, 2)}`
                      : null;
                  return (
                    <div key={playerId} className="rounded-2xl border border-white/8 bg-[#151519] p-3">
                      <div className="flex items-center gap-2.5">
                        {/* 선수 사진이 있으면 사진, 없으면 종전 팀 로고/별 폴백.
                            공용 PlayerAvatar 는 쓰지 않는다 — 그 이니셜 폴백은 팀색 글자라
                            어두운 배경에서 AA 대비를 못 넘긴다(실측 2.75·3.36 < 4.5, S2 browser gate).
                            이 PR 은 사진 배선만 한다 — 공용 컴포넌트 대비 개선은 별건. */}
                        <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full border border-white/10 bg-white/[0.06] shadow-[0_0_18px_rgba(255,82,99,.12)]">
                          {photoUrl ? (
                            <Image
                              src={photoUrl}
                              alt={player?.name ?? ""}
                              width={48}
                              height={48}
                              unoptimized
                              className="h-12 w-12 rounded-full object-cover"
                            />
                          ) : team ? (
                            <Image src={team.logoPath} alt="" width={30} height={30} unoptimized />
                          ) : (
                            <Star size={20} className="text-white/70" />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[16px] font-black">{player?.name ?? playerId}</p>
                          {boostLabel && (
                            <span className="mt-0.5 inline-flex rounded-full border border-[#ff596a]/45 bg-[#ff4053]/10 px-1.5 py-0.5 text-[9px] font-black text-[#ff9aa5]">
                              직관 부스트 {boostLabel}
                            </span>
                          )}
                          <p className="mt-0.5 text-[9px] font-semibold text-white/70">
                            {team?.shortName ?? "최애 선수"}{player?.position ? ` · ${player.position}` : ""}
                          </p>
                        </div>
                        <div className="grid shrink-0 grid-cols-2 divide-x divide-white/10 text-right">
                          <div className="px-2">
                            <p className="text-[9px] font-bold text-white/60">내 앞에서</p>
                            <p className="mt-0.5 text-[20px] font-black leading-none text-[#ffb0b8]">{attendanceValue}</p>
                          </div>
                          <div className="pl-2">
                            <p className="text-[9px] font-bold text-white/60">시즌</p>
                            <p className="mt-0.5 text-[20px] font-black leading-none text-white/75">{seasonValue}</p>
                          </div>
                        </div>
                      </div>
                      {(highlight?.batter || highlight?.pitcher) && (
                        <div className="mt-2 flex items-center gap-1.5 text-[10px] font-bold text-white/80">
                          <Sparkles size={12} className="text-amber-300" />
                          {highlight?.batter
                            ? `${highlight.batter.hits}안타 · ${highlight.batter.rbi}타점 · ${highlight.batter.homeRuns}홈런`
                            : `${highlight!.pitcher!.strikeouts}K · ${highlight!.pitcher!.zeroEarnedRunGames}경기 0자책`}
                        </div>
                      )}
                      {topGame && (
                        <p className="mt-1.5 truncate text-[9px] font-semibold text-white/70">
                          최애 최고의 직관 경기 · {topGame.batterTop
                            ? `${topGame.batterTop.date} ${topGame.batterTop.h}안타 ${topGame.batterTop.hr}홈런`
                            : topGame.pitcherTop
                              ? `${topGame.pitcherTop.date} ${formatOuts(topGame.pitcherTop.ipOuts)}이닝 ${topGame.pitcherTop.k}K`
                              : "기록 확인 중"}
                        </p>
                      )}
                      <StatState metric={batter ? c1! : c2!} />
                    </div>
                  );
                })}
              </div>

              {visibleInterestingFacts.length > 0 && (
                <>
                  <SectionTitle>이런 것까지?</SectionTitle>
                  <div className="grid grid-cols-2 gap-1.5">
                    {visibleInterestingFacts.map((fact) => (
                      <div
                        key={fact.key}
                        data-testid="venue-interesting-fact"
                        className="flex min-w-0 items-center gap-2 rounded-xl border border-white/8 bg-[#151519] px-3 py-2.5"
                      >
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/[0.07]">
                          {fact.icon}
                        </span>
                        <p className="min-w-0 truncate text-[11px] font-bold text-white/75">
                          {fact.label} <strong className="text-white">{fact.value}</strong>
                        </p>
                      </div>
                    ))}
                  </div>
                </>
              )}

              <button
                type="button"
                onClick={() => setDetailsOpen((value) => !value)}
                className="mt-3 flex w-full items-center justify-between rounded-xl border border-white/8 bg-white/[0.045] px-3.5 py-3 text-[12px] font-extrabold"
              >
                상대·구장·요일 상세 통계
                <ChevronDown size={17} className={`transition-transform ${detailsOpen ? "rotate-180" : ""}`} />
              </button>
              {detailsOpen && (
                <div className="mt-2 grid gap-2">
                  {/* 표본 미달 cell 은 top-level value 에 없고 items 에만 사실값이 있다 —
                      splitCells() 로 items 를 우선 합쳐 실제 기록이 사라지지 않게 한다(삼순 P0-2). */}
                  <SplitList
                    title="상대팀별"
                    metric={scope.metrics.A2}
                    rows={splitCells<A2Cell>(scope.metrics.A2).map(({ key, cell, sampleLimited }) => ({
                      key,
                      label: `${getTeamById(cell.opponentTeamId)?.shortName ?? `팀 ${cell.opponentTeamId}`}전`,
                      value: `${cell.w}승 ${cell.l}패 ${cell.d}무 · ${formatRate(cell.rate)}`,
                      sampleLimited,
                    }))}
                  />
                  <SplitList
                    title="구장별"
                    metric={scope.metrics.A3}
                    rows={splitCells<A3Cell>(scope.metrics.A3).map(({ key, cell, sampleLimited }) => ({
                      key,
                      label: `${cell.stadium} · ${cell.homeAway === "home" ? "홈" : "원정"}`,
                      value: `${cell.w}승 ${cell.l}패 · ${formatRate(cell.rate)}`,
                      sampleLimited,
                    }))}
                  />
                  <SplitList
                    title="요일별"
                    metric={scope.metrics.A4}
                    rows={splitCells<A4Cell>(scope.metrics.A4).map(({ key, cell, sampleLimited }) => ({
                      key,
                      label: `${WEEKDAYS[cell.weekday]}요일`,
                      value: `${cell.w}승 ${cell.l}패 · ${formatRate(cell.rate)}`,
                      sampleLimited,
                    }))}
                  />
                  <SplitList
                    title="낮·밤"
                    metric={scope.metrics.A5}
                    rows={splitCells<A5Cell>(scope.metrics.A5).map(({ key, cell, sampleLimited }) => ({
                      key,
                      label: cell.dayNight === "day" ? "낮 경기" : "야간 경기",
                      value: `${cell.w}승 ${cell.l}패 · ${formatRate(cell.rate)}`,
                      sampleLimited,
                    }))}
                  />
                  <SplitList
                    title="월별"
                    metric={scope.metrics.A6}
                    rows={splitCells<A6Cell>(scope.metrics.A6).map(({ key, cell, sampleLimited }) => ({
                      key,
                      label: `${cell.month}월`,
                      value: `${cell.w}승 ${cell.l}패 · ${formatRate(cell.rate)}`,
                      sampleLimited,
                    }))}
                  />
                </div>
              )}
            </>
          )}

          <section className="mt-3 rounded-xl border border-white/8 bg-white/[0.045] p-3">
            <div className="flex items-center gap-2">
              <BarChart3 size={16} className="text-[#ff6574]" />
              <p className="text-[12px] font-extrabold">데이터 기준</p>
            </div>
            <p className="mt-1.5 text-[10px] leading-relaxed text-white/70">{coverageCaption(scope)}</p>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/8">
              <div
                className="h-full rounded-full bg-gradient-to-r from-[#ff4053] to-[#ff7180]"
                style={{
                  width: `${scope.coverage.finalGames === 0
                    ? 0
                    : Math.max(4, ((scope.coverage.finalGames - scope.coverage.incompleteFinalGames) / scope.coverage.finalGames) * 100)}%`,
                }}
              />
            </div>
            <p className="mt-1.5 flex items-center gap-1 text-[9px] text-white/70">
              <CalendarDays size={11} /> 표본이 적거나 기록이 누락된 지표는 참고용으로 표시돼요
            </p>
          </section>
        </>
      ) : null}
    </div>
  );
}
