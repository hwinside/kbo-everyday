"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import {
  BarChart3,
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  Info,
  RefreshCw,
  Sparkles,
  Star,
  Trophy,
} from "lucide-react";
import { useSafeBack } from "@/lib/hooks/useSafeBack";
import { useAuth } from "@/lib/supabase/AuthContext";
import { getSafeSession } from "@/lib/supabase/client";
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
  C6Value,
  D1Value,
  D5Value,
  D6Value,
  E1Value,
  E2Value,
  E3Value,
  E4Value,
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
  return (
    <div className="mt-2 flex items-center justify-between gap-2 text-[10px] font-semibold">
      <span className={good ? "text-white/70" : "text-amber-300/85"}>
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
}: {
  title: string;
  value: string;
  comparison?: string;
  metric: MetricEnvelope;
  accent?: string;
}) {
  return (
    <div className="min-w-0 rounded-2xl border border-white/8 bg-white/[0.045] p-3.5">
      <p className="text-[11px] font-bold text-white/70">{title}</p>
      <p className={`mt-1 text-[24px] font-black tracking-tight ${accent}`}>{value}</p>
      {comparison && <p className="mt-0.5 text-[11px] font-semibold text-white/70">{comparison}</p>}
      <StatState metric={metric} />
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-2 mt-5 px-0.5 text-[15px] font-black text-white">{children}</h2>;
}

function SplitList({
  title,
  rows,
  metric,
}: {
  title: string;
  rows: Array<{ key: string; label: string; value: string }>;
  metric: MetricEnvelope;
}) {
  return (
    <div className="rounded-2xl border border-white/8 bg-white/[0.045] p-4">
      <p className="text-[12px] font-extrabold text-white/70">{title}</p>
      <div className="mt-2.5 space-y-2">
        {rows.slice(0, 4).map((row) => (
          <div key={row.key} className="flex items-center justify-between gap-3 text-[13px]">
            <span className="truncate text-white/70">{row.label}</span>
            <span className="shrink-0 font-extrabold text-white">{row.value}</span>
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
  const c6 = scope?.metrics.C6 as MetricEnvelope<C6Value> | undefined;
  const d1 = scope?.metrics.D1 as MetricEnvelope<D1Value> | undefined;
  const d5 = scope?.metrics.D5 as MetricEnvelope<D5Value> | undefined;
  const d6 = scope?.metrics.D6 as MetricEnvelope<D6Value> | undefined;
  const e1 = scope?.metrics.E1 as MetricEnvelope<E1Value> | undefined;
  const e2 = scope?.metrics.E2 as MetricEnvelope<E2Value> | undefined;
  const e3 = scope?.metrics.E3 as MetricEnvelope<E3Value> | undefined;
  const e4 = scope?.metrics.E4 as MetricEnvelope<E4Value> | undefined;

  const c1ById = new Map((c1?.value ?? []).map((entry) => [entry.playerId, entry]));
  const c2ById = new Map((c2?.value ?? []).map((entry) => [entry.playerId, entry]));
  const c4ById = new Map((c4?.value ?? []).map((entry) => [entry.playerId, entry]));
  const favoriteIds = [...new Set([...c1ById.keys(), ...c2ById.keys(), ...c4ById.keys()])];
  const mixedA1Items = hero?.mixedTeam ? (a1?.items ?? []) : [];
  const mixedBTeamIds = hero?.mixedTeam
    ? [...new Set(
        [b1, b2, b3, b4]
          .flatMap((metric) => metric?.items ?? [])
          .map((item) => Number(item.key))
          .filter(Number.isInteger),
      )]
    : [];

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

      <div className="mt-4 flex items-center justify-between gap-3">
        <label className="relative">
          <select
            value={season}
            onChange={(event) => selectSeason(Number(event.target.value))}
            className="h-10 appearance-none rounded-full border border-white/10 bg-white/[0.06] pl-4 pr-10 text-[13px] font-extrabold text-white outline-none"
          >
            {SEASONS.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
          <ChevronDown size={14} className="pointer-events-none absolute right-3 top-3 text-white/60" />
        </label>
        <span className="text-[11px] font-semibold text-white/70">정규시즌 기준</span>
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
          <section className="relative mt-4 overflow-hidden rounded-2xl border border-[#ff5263]/45 bg-[radial-gradient(circle_at_88%_8%,rgba(255,82,99,0.18),transparent_35%),linear-gradient(145deg,#211318,#111114_72%)] p-5 shadow-[0_10px_35px_rgba(255,69,84,0.08)]">
            <Sparkles className="absolute right-5 top-5 text-[#ff9aa5]" size={28} />
            <p className="text-[13px] font-black text-[#ff9aa5]">나의 직관 요정 지수</p>
            <div className="mt-2 flex items-end gap-2">
              <span className="text-[54px] font-black leading-none tracking-[-0.06em]">
                {hero.score ?? "–"}
              </span>
              {hero.score != null && <span className="mb-1 text-[16px] font-extrabold text-white/70">점</span>}
              {/* 표본 가드 미달이면 사실값은 그대로 두고 배지로만 참고용임을 알린다. */}
              <span
                className={`mb-1 rounded-full border px-2.5 py-1 text-[11px] font-black ${
                  a1.state === "sample_limited"
                    ? "border-amber-300/55 text-amber-300"
                    : "border-[#ff596a]/55 text-[#ff9aa5]"
                }`}
              >
                {a1.state === "sample_limited" ? METRIC_STATE_LABELS.sample_limited : "승률 요정"}
              </span>
            </div>
            <div className="mt-3 flex items-center gap-3 text-[15px] font-black">
              <span className="text-sky-400">{hero.attendance?.w ?? 0}승</span>
              <span className="text-rose-300">{hero.attendance?.l ?? 0}패</span>
              <span className="text-white/65">{hero.attendance?.d ?? 0}무</span>
              <span>·</span>
              <span>승률 {formatRate(hero.attendance?.rate)}</span>
            </div>
            <p className="mt-2 text-[12px] font-semibold text-white/70">
              {a1.state === "sample_limited"
                ? `종료 경기 ${a1.n}경기 기록이에요 · ${MIN_FINAL_GAMES}경기부터 팀 시즌 비교를 보여드려요`
                : hero.mixedTeam
                  ? "응원팀 변경 포함 · 팀별 구간은 아래에서 확인"
                  : hero.deltaPp == null
                    ? "팀 시즌 비교값을 확인 중이에요"
                    : `팀 시즌 승률 ${formatRate(hero.teamRate)}보다 ${formatSigned(hero.deltaPp, 1, "%p")}`}
            </p>
            {hero.teamIds.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-1.5 rounded-xl border border-white/8 bg-white/[0.035] p-2.5">
                {hero.teamIds.map((teamId) => {
                  const team = getTeamById(teamId);
                  return (
                    <span key={teamId} className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.06] px-2 py-1 text-[10px] font-bold text-white/70">
                      {team && <Image src={team.logoPath} alt="" width={14} height={14} unoptimized />}
                      {team?.shortName ?? `팀 ${teamId}`}
                    </span>
                  );
                })}
                <span className="ml-auto self-center text-[10px] text-white/70">{metricEvidence(a1)}</span>
              </div>
            )}
            {mixedA1Items.length > 0 && (
              <div className="mt-3 grid gap-1.5">
                {mixedA1Items.map((item) => {
                  const team = getTeamById(Number(item.key));
                  const value = item.value as A1Value | null;
                  return (
                    <div
                      key={item.key}
                      className="flex items-center justify-between gap-3 rounded-xl border border-white/8 bg-black/20 px-3 py-2"
                    >
                      <span className="text-[11px] font-extrabold text-white/70">
                        {team?.shortName ?? `팀 ${item.key}`} 응원 구간
                      </span>
                      <span className="text-[11px] font-black text-white/80">
                        {value
                          ? `${value.attendance.w}승 ${value.attendance.l}패 ${value.attendance.d}무 · ${formatRate(value.attendance.rate)}`
                          : METRIC_STATE_LABELS[item.state]}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section className="sticky top-[52px] z-20 -mx-1 mt-3 rounded-2xl border border-white/8 bg-[#111114]/95 p-1.5 shadow-xl backdrop-blur-xl">
            <div className="grid grid-cols-2 gap-1">
              {([
                ["overall", "전체 기록"],
                ["gps", "GPS 인증만"],
              ] as const).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setScopeName(key)}
                  className={`rounded-xl py-2.5 text-[12px] font-black transition-colors ${
                    scopeName === key ? "bg-[#b82d41] text-white" : "text-white/70"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="px-2 pb-1 pt-2 text-center text-[10px] font-semibold text-white/70">
              재미 지표 · 시즌 {season} · 표본 {scope.coverage.attendanceGames}경기
            </p>
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
                  />
                  <MetricCard
                    title="평균 득점"
                    value={b3?.value?.runsPerGame == null ? "–" : b3.value.runsPerGame.toFixed(1)}
                    comparison={b3?.value ? `${b3.value.totalRuns}득점` : undefined}
                    metric={b3!}
                  />
                  <MetricCard
                    title="팀 ERA"
                    value={formatEra(b2?.value?.attendanceEra)}
                    comparison={b2?.value?.seasonEra != null ? `시즌 ${formatEra(b2.value.seasonEra)} · ${formatSigned(b2.value.delta, 2)}` : undefined}
                    metric={b2!}
                  />
                  <MetricCard
                    title="홈런"
                    value={b4?.value?.hr?.attendancePerGame == null ? "–" : b4.value.hr.attendancePerGame.toFixed(1)}
                    comparison={b4?.value?.hr?.seasonPerGame != null ? `시즌 경기당 ${b4.value.hr.seasonPerGame.toFixed(1)}` : undefined}
                    metric={b4!}
                  />
                </div>
              )}
              {mixedBTeamIds.length > 0 && (
                <div className="mt-2 grid gap-2">
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
                      <div key={teamId} className="rounded-2xl border border-white/8 bg-white/[0.045] p-3.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[12px] font-black text-white/70">
                            {team?.shortName ?? `팀 ${teamId}`} 응원 구간
                          </span>
                          <span className="text-[10px] font-semibold text-white/70">
                            {ready
                              ? `${Math.max(...items.map((item) => item.n))}경기`
                              : METRIC_STATE_LABELS[items[0]?.state ?? "empty"]}
                          </span>
                        </div>
                        <div className="mt-2 grid grid-cols-4 gap-1 text-center">
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
                  <div className="rounded-2xl border border-white/8 bg-white/[0.045] p-5 text-sm font-semibold text-white/70">
                    {METRIC_STATE_LABELS[c1?.state ?? "no_favorite"]}
                  </div>
                ) : favoriteIds.map((playerId) => {
                  const player = favoriteById.get(playerId);
                  const batter = c1ById.get(playerId);
                  const pitcher = c2ById.get(playerId);
                  const homer = c4ById.get(playerId);
                  const team = player ? getTeamById(player.teamId) : null;
                  return (
                    <div key={playerId} className="rounded-2xl border border-white/8 bg-white/[0.045] p-4">
                      <div className="flex items-center gap-3">
                        <div className="flex h-12 w-12 items-center justify-center rounded-full border border-white/10 bg-white/[0.06]">
                          {team ? <Image src={team.logoPath} alt="" width={30} height={30} unoptimized /> : <Star size={20} className="text-white/70" />}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[17px] font-black">{player?.name ?? playerId}</p>
                          <p className="text-[11px] font-semibold text-white/70">
                            {team?.shortName ?? "최애 선수"}{player?.position ? ` · ${player.position}` : ""}
                          </p>
                        </div>
                        {homer && (
                          <div className="text-right">
                            <p className="text-[20px] font-black">{homer.homeRuns}개</p>
                            <p className="text-[10px] text-white/70">홈런 목격</p>
                          </div>
                        )}
                      </div>
                      <div className="mt-3 grid grid-cols-2 divide-x divide-white/8 rounded-xl bg-black/20 p-3">
                        <div className="pr-3">
                          <p className="text-[10px] font-bold text-white/70">내 앞에서</p>
                          <p className="mt-1 text-[23px] font-black">
                            {batter ? formatAvg(batter.attendanceAvg) : formatEra(pitcher?.attendanceEra)}
                          </p>
                        </div>
                        <div className="pl-3">
                          <p className="text-[10px] font-bold text-white/70">시즌</p>
                          <p className="mt-1 text-[23px] font-black text-white/70">
                            {batter ? formatAvg(batter.seasonAvg) : formatEra(pitcher?.seasonEra)}
                          </p>
                        </div>
                      </div>
                      <p className="mt-2 text-[10px] font-semibold text-white/70">
                        {batter ? `출전 ${batter.appearances}경기 · AB ${batter.ab}` : `출전 ${pitcher?.appearances ?? 0}경기 · IP ${formatOuts(pitcher?.outs)}`}
                      </p>
                    </div>
                  );
                })}
                {(c5?.value?.length ?? 0) > 0 && (
                  <div className="rounded-2xl border border-white/8 bg-white/[0.045] p-4 text-[12px]">
                    <p className="font-extrabold text-white/70">최애 최고의 직관 경기</p>
                    <p className="mt-1 text-white/70">
                      {c5!.value![0].batterTop
                        ? `${c5!.value![0].batterTop!.date} · ${c5!.value![0].batterTop!.h}안타 ${c5!.value![0].batterTop!.hr}홈런`
                        : c5!.value![0].pitcherTop
                          ? `${c5!.value![0].pitcherTop!.date} · ${formatOuts(c5!.value![0].pitcherTop!.ipOuts)}이닝 ${c5!.value![0].pitcherTop!.k}K`
                          : "기록 확인 중"}
                    </p>
                  </div>
                )}
                {c6?.value && (
                  <div className="rounded-2xl border border-white/8 bg-white/[0.045] p-4 text-[12px]">
                    <p className="font-extrabold text-white/70">내 직관 부스트 순위</p>
                    <p className="mt-1 text-white/70">
                      타자 {c6.value.batterRanking.length}명 · 투수 {c6.value.pitcherRanking.length}명 비교
                    </p>
                    <StatState metric={c6} />
                  </div>
                )}
              </div>

              <SectionTitle>이런 것까지?</SectionTitle>
              <div className="grid grid-cols-2 gap-2">
                <MetricCard title="토요일 승률" value={formatRate(((scope.metrics.A4.value as A4Cell[] | null) ?? []).find((x) => x.weekday === 6)?.rate)} metric={scope.metrics.A4} />
                <MetricCard title="연속 직관" value={`${e1?.value?.current ?? 0}경기`} comparison={`최장 ${e1?.value?.longest ?? 0}경기`} metric={e1!} />
                <MetricCard title="우천·취소" value={`${d5?.value?.cancelledCount ?? 0}회`} metric={d5!} />
                <MetricCard title="최다 득점" value={d6?.value?.maxTeamRuns ? `${d6.value.maxTeamRuns.runs}점` : "–"} comparison={d6?.value?.maxTeamRuns?.date} metric={d6!} />
                <MetricCard title="평균 득점차" value={d1?.value?.avgRunDiff == null ? "–" : formatSigned(d1.value.avgRunDiff, 1)} comparison={d1?.value ? `1점차 경기 ${d1.value.closeGames}회` : undefined} metric={d1!} />
                <MetricCard title="누적 직관" value={`${e2?.value?.seasonCount ?? 0}경기`} comparison={e2?.value?.avgPerActiveMonth == null ? undefined : `활동 월 평균 ${e2.value.avgPerActiveMonth.toFixed(1)}회`} metric={e2!} />
                <MetricCard title="첫 직관부터" value={e3?.value?.daysSinceFirst == null ? "–" : `D+${e3.value.daysSinceFirst}`} comparison={e3?.value?.firstAttendanceDate} metric={e3!} />
                <MetricCard title="주력 구장" value={e4?.value?.topStadium?.name ?? "–"} comparison={e4?.value?.topStadium ? `${e4.value.topStadium.count}회` : undefined} metric={e4!} />
              </div>

              <button
                type="button"
                onClick={() => setDetailsOpen((value) => !value)}
                className="mt-4 flex w-full items-center justify-between rounded-2xl border border-white/8 bg-white/[0.045] px-4 py-3.5 text-[13px] font-extrabold"
              >
                상대·구장·요일 상세 통계
                <ChevronDown size={17} className={`transition-transform ${detailsOpen ? "rotate-180" : ""}`} />
              </button>
              {detailsOpen && (
                <div className="mt-2 grid gap-2">
                  <SplitList
                    title="상대팀별"
                    metric={scope.metrics.A2}
                    rows={((scope.metrics.A2.value as A2Cell[] | null) ?? []).map((cell) => ({
                      key: String(cell.opponentTeamId),
                      label: `${getTeamById(cell.opponentTeamId)?.shortName ?? `팀 ${cell.opponentTeamId}`}전`,
                      value: `${cell.w}승 ${cell.l}패 ${cell.d}무 · ${formatRate(cell.rate)}`,
                    }))}
                  />
                  <SplitList
                    title="구장별"
                    metric={scope.metrics.A3}
                    rows={((scope.metrics.A3.value as A3Cell[] | null) ?? []).map((cell) => ({
                      key: `${cell.stadium}:${cell.homeAway}`,
                      label: `${cell.stadium} · ${cell.homeAway === "home" ? "홈" : "원정"}`,
                      value: `${cell.w}승 ${cell.l}패 · ${formatRate(cell.rate)}`,
                    }))}
                  />
                  <SplitList
                    title="요일별"
                    metric={scope.metrics.A4}
                    rows={((scope.metrics.A4.value as A4Cell[] | null) ?? []).map((cell) => ({
                      key: String(cell.weekday),
                      label: `${WEEKDAYS[cell.weekday]}요일`,
                      value: `${cell.w}승 ${cell.l}패 · ${formatRate(cell.rate)}`,
                    }))}
                  />
                  <SplitList
                    title="낮·밤"
                    metric={scope.metrics.A5}
                    rows={((scope.metrics.A5.value as A5Cell[] | null) ?? []).map((cell) => ({
                      key: cell.dayNight,
                      label: cell.dayNight === "day" ? "낮 경기" : "야간 경기",
                      value: `${cell.w}승 ${cell.l}패 · ${formatRate(cell.rate)}`,
                    }))}
                  />
                  <SplitList
                    title="월별"
                    metric={scope.metrics.A6}
                    rows={((scope.metrics.A6.value as A6Cell[] | null) ?? []).map((cell) => ({
                      key: String(cell.month),
                      label: `${cell.month}월`,
                      value: `${cell.w}승 ${cell.l}패 · ${formatRate(cell.rate)}`,
                    }))}
                  />
                </div>
              )}
            </>
          )}

          <section className="mt-4 rounded-2xl border border-white/8 bg-white/[0.045] p-4">
            <div className="flex items-center gap-2">
              <BarChart3 size={16} className="text-[#ff6574]" />
              <p className="text-[12px] font-extrabold">데이터 기준</p>
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-white/70">{coverageCaption(scope)}</p>
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/8">
              <div
                className="h-full rounded-full bg-gradient-to-r from-[#ff4053] to-[#ff7180]"
                style={{
                  width: `${scope.coverage.finalGames === 0
                    ? 0
                    : Math.max(4, ((scope.coverage.finalGames - scope.coverage.incompleteFinalGames) / scope.coverage.finalGames) * 100)}%`,
                }}
              />
            </div>
            <p className="mt-2 flex items-center gap-1 text-[10px] text-white/70">
              <CalendarDays size={11} /> 표본이 적거나 기록이 누락된 지표는 참고용으로 표시돼요
            </p>
          </section>
        </>
      ) : null}
    </div>
  );
}
