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
  C6Value,
  D1Value,
  D5Value,
  D6Value,
  D7Value,
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
  batterCompatibility,
  coverageCaption,
  formatAvg,
  formatEra,
  formatOuts,
  formatRate,
  formatSigned,
  METRIC_STATE_LABELS,
  awayFanTag,
  venueErrorTags,
  scoreBadgeLabel,
  SCORE_CONFIDENCE_LABELS,
  scoreConfidenceLevel,
  splitCells,
  metricEvidence,
  metricTrend,
  pitcherCompatibility,
  type MetricTrend,
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

/**
 * 최애 선수 사진 — runtime 로드 실패 시 팀 로고로 폴백한다.
 *
 * 삼순 P1 (2026-08-02): `photoUrl` 이 있으면 `Image` 만 렌더해서, 파일이 지워졌거나
 * 404 인 URL 에서 깨진 이미지가 그대로 남았다. `onError` 로 실제 로드 실패를 잡아 폴백한다.
 *
 * 공용 `PlayerAvatar` 는 쓰지 않는다 — 그 이니셜 폴백은 팀색 글자라 어두운 배경에서
 * AA 대비를 못 넘긴다(실측 2.75·3.36 < 4.5, S2 browser gate).
 */
function FavoritePhoto({
  photoUrl,
  playerName,
  teamLogoPath,
}: {
  photoUrl: string | null;
  playerName: string;
  teamLogoPath: string | null;
}) {
  const [failed, setFailed] = useState(false);
  const showPhoto = photoUrl !== null && !failed;
  return (
    <div
      data-testid="venue-favorite-photo"
      data-photo-state={showPhoto ? "photo" : teamLogoPath ? "team-logo" : "placeholder"}
      className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full border border-white/10 bg-white/[0.06] shadow-[0_0_18px_rgba(255,82,99,.12)]"
    >
      {showPhoto ? (
        <Image
          src={photoUrl}
          alt={playerName}
          width={48}
          height={48}
          unoptimized
          onError={() => setFailed(true)}
          className="h-12 w-12 rounded-full object-cover"
        />
      ) : teamLogoPath ? (
        <Image src={teamLogoPath} alt="" width={30} height={30} unoptimized />
      ) : (
        <Star size={20} className="text-white/70" />
      )}
    </div>
  );
}

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
  actual,
  baseline,
  trend,
  metric,
  icon,
  embedded = false,
  className = "",
}: {
  title: string;
  actual: string;
  baseline?: string;
  trend: MetricTrend;
  metric: MetricEnvelope;
  icon?: React.ReactNode;
  embedded?: boolean;
  className?: string;
}) {
  const tone = {
    positive: "text-emerald-300",
    negative: "text-rose-300",
    neutral: "text-slate-300",
    unavailable: "text-white/65",
  }[trend.tone];
  return (
    <div className={`min-w-0 p-3 ${embedded ? "" : "rounded-xl border border-white/8 bg-[#151519]"} ${className}`}>
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-[10px] font-bold text-white/70">{icon}{title}</p>
        <span className="text-[9px] font-semibold text-white/60">{metric.n}경기 기준</span>
      </div>
      <p data-testid="venue-metric-trend" className={`mt-1 text-[24px] font-black leading-none tracking-tight ${tone}`}>
        {trend.arrow && <span aria-hidden="true">{trend.arrow} </span>}{trend.label}
      </p>
      <p className="mt-1 text-[10px] font-semibold text-white/70">
        직관 <strong className="text-white/90">{actual}</strong>
        {baseline && <> · 시즌 <strong className="text-white/90">{baseline}</strong></>}
      </p>
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
  const [favoritesOpen, setFavoritesOpen] = useState(false);
  const [tagsOpen, setTagsOpen] = useState(false);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
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
  const d7 = scope?.metrics.D7 as MetricEnvelope<D7Value> | undefined;
  const e1 = scope?.metrics.E1 as MetricEnvelope<E1Value> | undefined;
  const e2 = scope?.metrics.E2 as MetricEnvelope<E2Value> | undefined;
  const e3 = scope?.metrics.E3 as MetricEnvelope<E3Value> | undefined;
  const e4 = scope?.metrics.E4 as MetricEnvelope<E4Value> | undefined;

  const c1ById = new Map((c1?.value ?? []).map((entry) => [entry.playerId, entry]));
  const c2ById = new Map((c2?.value ?? []).map((entry) => [entry.playerId, entry]));
  const c4ById = new Map((c4?.value ?? []).map((entry) => [entry.playerId, entry]));
  const favoriteRegistrationOrder = new Map(
    (profile?.favorite_players ?? []).map((player, index) => [player.playerId, index]),
  );
  const allFavoriteIds = [...new Set([...c1ById.keys(), ...c2ById.keys(), ...c4ById.keys()])]
    .sort((left, right) =>
      (favoriteRegistrationOrder.get(left) ?? Number.MAX_SAFE_INTEGER)
      - (favoriteRegistrationOrder.get(right) ?? Number.MAX_SAFE_INTEGER));
  // C6의 타자·투수 boostPct는 서로 다른 지표라 역할을 가로질러 숫자로 비교하지 않는다.
  // 역할별 1위 후보만 만든 뒤, 후보 간 메인은 사용자의 최애 등록순으로 결정한다.
  const favoriteBoostLeaders = [
    c6?.value?.batterRanking?.[0]
      ? { ...c6.value.batterRanking[0], role: "batter" as const }
      : null,
    c6?.value?.pitcherRanking?.[0]
      ? { ...c6.value.pitcherRanking[0], role: "pitcher" as const }
      : null,
  ].filter((entry): entry is NonNullable<typeof entry> => entry != null && allFavoriteIds.includes(entry.playerId));
  const mainFavorite = favoriteBoostLeaders.reduce<(typeof favoriteBoostLeaders)[number] | null>(
    (selected, candidate) => {
      if (!selected) return candidate;
      const selectedOrder = favoriteRegistrationOrder.get(selected.playerId) ?? Number.MAX_SAFE_INTEGER;
      const candidateOrder = favoriteRegistrationOrder.get(candidate.playerId) ?? Number.MAX_SAFE_INTEGER;
      return candidateOrder < selectedOrder ? candidate : selected;
    },
    null,
  );
  const favoriteBoostLabelById = new Map(
    favoriteBoostLeaders.map((entry) => [
      entry.playerId,
      entry.role === "batter" ? "타자 부스트 1위" : "투수 부스트 1위",
    ] as const),
  );
  const favoriteIds = mainFavorite
    ? [mainFavorite.playerId, ...allFavoriteIds.filter((playerId) => playerId !== mainFavorite.playerId)]
    : allFavoriteIds;
  const visibleFavoriteIds = favoritesOpen ? favoriteIds : favoriteIds.slice(0, 1);
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
  const dayNightCells = scope ? splitCells<A5Cell>(scope.metrics.A5) : [];
  const monthCells = scope ? splitCells<A6Cell>(scope.metrics.A6) : [];
  const bestSplit = <T extends { w: number; l: number; d: number; rate: number | null }>(
    cells: Array<{ key: string; cell: T; sampleLimited: boolean }>,
  ) => [...cells]
    .filter(({ cell, sampleLimited }) =>
      !sampleLimited && cell.rate != null && cell.w + cell.l + cell.d >= MIN_FINAL_GAMES)
    .sort((a, b) =>
      (b.cell.rate ?? -1) - (a.cell.rate ?? -1) ||
      (b.cell.w + b.cell.l + b.cell.d) - (a.cell.w + a.cell.l + a.cell.d) ||
      a.key.localeCompare(b.key))[0];
  const bestOpponent = bestSplit(opponentCells);
  const bestStadium = bestSplit(stadiumCells);
  const bestWeekday = bestSplit(weekdayCells);
  const bestMonth = bestSplit(monthCells);
  const bestOpponentName = bestOpponent
    ? getTeamById(bestOpponent.cell.opponentTeamId)?.shortName ?? `팀 ${bestOpponent.cell.opponentTeamId}`
    : null;
  const bestOpponentLabel = bestOpponent
    ? `${bestOpponentName}${(bestOpponent.cell.rate ?? 0) >= 0.6 ? " 킬러" : "전 궁합 1위"}`
    : null;
  const bestWeekdayLabel = bestWeekday
    ? `${WEEKDAYS[bestWeekday.cell.weekday]}요일${(bestWeekday.cell.rate ?? 0) >= 0.6 ? "의 승요" : "이 최선"}`
    : null;
  const bestStadiumLabel = bestStadium
    ? `${bestStadium.cell.stadium}${(bestStadium.cell.rate ?? 0) >= 0.6 ? " 강자" : " 궁합 1위"}`
    : null;
  // 삼순 P1 (2026-08-02) — "최고의 스플릿"이라도 승률이 낮으면 긍정 태그를 붙이지 않는다.
  // 예전엔 표본만 충족하면 0승3패에도 `야간 경기 체질`/`7월의 승요`가 렌더됐다.
  const POSITIVE_TAG_RATE = 0.5;
  const isPositiveSplit = (rate: number | null | undefined) => (rate ?? 0) > POSITIVE_TAG_RATE;

  // ── 낮 경기 관람 성향 태그 (하린아빠 2026-08-02) ──────────────────────────
  // "야간경기가 대부분인데 야간 경기 체질은 애매해. 차라리 낮 경기를 유독 많이 보는
  //  사람에게 별칭을 주는 게 자연스러움" → `야간 경기 체질` 폐기.
  // 삼순: 단순 횟수가 아니라 **낮 경기 기회 대비 참석 비율**로 판단.
  const dayOpportunity = (scope?.metrics.A5?.coverage as {
    dayGameOpportunity?: {
      attendanceDayGames: number;
      attendanceTotal: number;
      seasonDayGames: number;
      seasonTotal: number;
    };
  } | undefined)?.dayGameOpportunity;
  // 내 낮경기 비중이 팀 일정의 낮경기 비중보다 유의미하게 높을 때만 별칭을 준다.
  const dayGameTag = (() => {
    if (!dayOpportunity || dayOpportunity.attendanceTotal < MIN_FINAL_GAMES) return null;
    if (dayOpportunity.seasonTotal === 0 || dayOpportunity.attendanceDayGames === 0) return null;
    // 삼순 P1 (2026-08-02) — baseline 0이면 배수가 Infinity 로 렌더됐다
    // (`낮경기 수집가 · 평균의 Infinity배`). 기회가 0인데 참석이 있다는 건 데이터 모순이므로
    // "유독 많이 본다"를 주장할 근거가 없다 → 태그 자체를 fail-close 한다.
    if (dayOpportunity.seasonDayGames === 0) return null;
    const mine = dayOpportunity.attendanceDayGames / dayOpportunity.attendanceTotal;
    const baseline = dayOpportunity.seasonDayGames / dayOpportunity.seasonTotal;
    if (!Number.isFinite(baseline) || baseline <= 0) return null;
    const ratio = mine / baseline;
    if (!Number.isFinite(ratio) || ratio < 1.5) return null;
    return {
      label: mine >= 0.5 ? "햇살 직관러" : "낮경기 수집가",
      value: `낮 ${dayOpportunity.attendanceDayGames}경기 · 평균의 ${ratio.toFixed(1)}배`,
    };
  })();
  // 성적을 암시하는 `낮경기 승요`는 낮 경기 초과성과가 실제 플러스일 때만 별도 노출(삼순).
  const dayGameWinTag = (() => {
    const dayCell = dayNightCells.find(({ cell }) => cell.dayNight === "day");
    if (!dayCell || dayCell.sampleLimited) return null;
    if (!isPositiveSplit(dayCell.cell.rate)) return null;
    return {
      label: "낮경기 승요",
      value: `${dayCell.cell.w}승 ${dayCell.cell.l}패 · ${formatRate(dayCell.cell.rate, 0)}`,
    };
  })();

  // ── 실책 목격 태그 (하린아빠 2026-08-02) ─────────────────────────────────
  // "유독 실책을 많이 보는 발암경기 인내형". 임계·근거는 `venueErrorTags` 가 SSOT.
  // D7 이 ready 가 아니면(=확인된 경기 부족/조회 실패) 태그를 만들지 않는다.
  const errorTags = venueErrorTags(d7?.state === "ready" ? d7.value : null);
  const errorTag = errorTags.heavy;
  const cleanDefenseTag = errorTags.clean;

  // ── 원정 찐팬 태그 (하린아빠 2026-08-02) ────────────────────────────────
  // "보통 홈구장만 가는 팬이 대부분인데 원정까지 많이 가는 팬은 정말 찐팬이니 이것도 추가".
  // 임계는 `awayFanTag` 가 SSOT — 실측 분포 근거·회귀는 ui.ts 주석 참조.
  const awayCells = stadiumCells.filter(({ cell }) => cell.homeAway === "away");
  const awayGames = awayCells.reduce((sum, { cell }) => sum + cell.w + cell.l + cell.d, 0);
  const awayStadiums = new Set(awayCells.map(({ cell }) => cell.stadium)).size;
  const totalSplitGames = stadiumCells.reduce(
    (sum, { cell }) => sum + cell.w + cell.l + cell.d, 0,
  );
  const awayTag = awayFanTag({ awayGames, awayStadiums, totalGames: totalSplitGames });
  // 원정 성적 태그는 원정 승률이 실제 플러스일 때만 분리 노출(삼순).
  const awayWinTag = (() => {
    if (awayGames < MIN_FINAL_GAMES) return null;
    const w = awayCells.reduce((sum, { cell }) => sum + cell.w, 0);
    const l = awayCells.reduce((sum, { cell }) => sum + cell.l, 0);
    const rate = w + l > 0 ? w / (w + l) : null;
    if (!isPositiveSplit(rate)) return null;
    return { label: "원정 승요", value: `${w}승 ${l}패 · ${formatRate(rate, 0)}` };
  })();
  const bestMonthLabel = bestMonth
    ? isPositiveSplit(bestMonth.cell.rate)
      ? `${bestMonth.cell.month}월의 승요`
      : (bestMonth.cell.rate ?? 0) === 0
        ? `${bestMonth.cell.month}월 인내형`
        : `${bestMonth.cell.month}월이 그나마`
    : null;
  const summarySampleReady = (a1?.n ?? 0) >= MIN_FINAL_GAMES && !hero?.sampleLimited;
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
  if (bestWeekday) interestingFacts.push({
    key: "weekday", label: bestWeekdayLabel!, value: `${bestWeekday.cell.w}승 · ${formatRate(bestWeekday.cell.rate, 0)}`,
    icon: <CalendarDays size={16} className="text-rose-300" />,
  });
  if (bestOpponent) interestingFacts.push({
    key: "opponent",
    label: bestOpponentLabel!,
    value: `${bestOpponent.cell.w}승 ${bestOpponent.cell.l}패`,
    icon: <Swords size={16} className="text-orange-300" />,
  });
  if (summarySampleReady && homeRunsSeen > 0) interestingFacts.push({
    key: "home-runs", label: "홈런", value: `${homeRunsSeen}개 목격`,
    icon: <span className="text-[16px] leading-none">⚾</span>,
  });
  if (summarySampleReady && (e1?.value?.longest ?? 0) >= 2) interestingFacts.push({
    key: "streak", label: "연속 직관", value: `최장 ${e1!.value!.longest}경기`,
    icon: <Flame size={16} className="text-amber-300" />,
  });
  if (summarySampleReady && (d5?.value?.cancelledCount ?? 0) > 0) interestingFacts.push({
    key: "cancelled", label: "우천·취소", value: `${d5!.value!.cancelledCount}회`,
    icon: <CloudRain size={16} className="text-blue-300" />,
  });
  if (summarySampleReady && d6?.value?.maxTeamRuns) interestingFacts.push({
    key: "max-runs", label: "최다 득점", value: `${d6.value.maxTeamRuns.runs}점`,
    icon: <Target size={16} className="text-emerald-300" />,
  });
  if (summarySampleReady && (d1?.value?.closeGames ?? 0) > 0) interestingFacts.push({
    key: "close-games", label: "1점차 승부", value: `${d1!.value!.closeGames}경기`,
    icon: <Trophy size={16} className="text-violet-300" />,
  });
  // `야간 경기 체질`은 폐기 — 야간이 기본값이라 정보가 없다(하린아빠 2026-08-02).
  // 낮 경기를 유독 많이 보는 사람에게만 관람 성향 별칭을 준다(기회 대비 비율 기준).
  if (summarySampleReady && dayGameTag) interestingFacts.push({
    key: "day-game",
    label: dayGameTag.label,
    value: dayGameTag.value,
    icon: <span className="text-[15px]">☀️</span>,
  });
  if (summarySampleReady && dayGameWinTag) interestingFacts.push({
    key: "day-game-win",
    label: dayGameWinTag.label,
    value: dayGameWinTag.value,
    icon: <span className="text-[15px]">🌤️</span>,
  });
  // ── 실책 목격 태그 (하린아빠 2026-08-02 "유독 실책을 많이 보는 발암경기 인내형") ──
  // 분모는 **실책을 아는 경기(D7.knownGames)** 뿐이다. 모르는 경기를 0으로 세면
  // "실책을 안 본 사람"으로 둔갑한다. 그래서 D7 이 ready 일 때만 태그를 만든다.
  if (summarySampleReady && errorTag) interestingFacts.push({
    key: "errors-seen",
    label: errorTag.label,
    value: errorTag.value,
    icon: <span className="text-[15px]">🤯</span>,
  });
  if (summarySampleReady && cleanDefenseTag) interestingFacts.push({
    key: "clean-defense",
    label: cleanDefenseTag.label,
    value: cleanDefenseTag.value,
    icon: <span className="text-[15px]">🧤</span>,
  });
  if (summarySampleReady && awayTag) interestingFacts.push({
    key: "away-fan",
    label: awayTag.label,
    value: awayTag.value,
    icon: <span className="text-[15px]">🚄</span>,
  });
  if (summarySampleReady && awayWinTag) interestingFacts.push({
    key: "away-win",
    label: awayWinTag.label,
    value: awayWinTag.value,
    icon: <Trophy size={16} className="text-sky-300" />,
  });
  if (bestMonth) interestingFacts.push({
    key: "month", label: bestMonthLabel!, value: `${bestMonth.cell.w}승 ${bestMonth.cell.l}패 · ${formatRate(bestMonth.cell.rate, 0)}`,
    icon: <CalendarDays size={16} className="text-cyan-300" />,
  });
  if (summarySampleReady && (d6?.value?.maxMarginWin?.margin ?? 0) >= 3) interestingFacts.push({
    key: "margin", label: "대승 수집가", value: `최대 ${d6!.value!.maxMarginWin!.margin}점 차`,
    icon: <Trophy size={16} className="text-amber-300" />,
  });
  if (summarySampleReady && (hero?.attendance?.w ?? 0) >= 3) interestingFacts.push({
    key: "wins-seen", label: "승리 목격자", value: `${hero!.attendance!.w}승 수집`,
    icon: <Trophy size={16} className="text-emerald-300" />,
  });
  if (summarySampleReady && (hero?.attendance?.l ?? 0) >= 3) interestingFacts.push({
    key: "loss-endurance", label: "패배 인내형", value: `${hero!.attendance!.l}패 견딤`,
    icon: <span className="text-[15px]">🧘</span>,
  });
  if (summarySampleReady && (hero?.attendance?.d ?? 0) > 0) interestingFacts.push({
    key: "draw-seen", label: "무승부 희귀종", value: `${hero!.attendance!.d}무 목격`,
    icon: <span className="text-[15px]">🦄</span>,
  });
  if (summarySampleReady && (e2?.value?.seasonCount ?? 0) > 0) interestingFacts.push({
    key: "season-count", label: "구장 출석부", value: `${e2!.value!.seasonCount}경기`,
    icon: <MapPin size={16} className="text-emerald-300" />,
  });
  if (summarySampleReady && (e3?.value?.daysSinceFirst ?? 0) >= 30) interestingFacts.push({
    key: "days", label: "직관 인생", value: `D+${e3!.value!.daysSinceFirst}`,
    icon: <Sparkles size={16} className="text-violet-300" />,
  });
  if (summarySampleReady && (e4?.value?.topStadium?.count ?? 0) >= 2) interestingFacts.push({
    key: "home-ground", label: "나의 홈그라운드", value: `${e4!.value!.topStadium!.name} ${e4!.value!.topStadium!.count}회`,
    icon: <MapPin size={16} className="text-sky-300" />,
  });
  const visibleInterestingFacts = tagsOpen ? interestingFacts : interestingFacts.slice(0, 6);

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
                  ? "bg-gradient-to-r from-[#a51f36] to-[#7f182e] text-white shadow-[0_3px_12px_rgba(165,31,54,.3)]"
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
                {hero.sampleLimited
                  ? METRIC_STATE_LABELS.sample_limited
                  : hero.score == null
                    ? "지수 준비 중"
                    : scoreBadgeLabel(hero.score)}
              </span>
            </div>
            {/* 지수는 승률이 아니라 합성값이라 기준점 50을 명시해야 읽힌다. */}
            {!hero.sampleLimited && hero.score != null && (
              <div className="mt-2 flex items-center gap-1.5" data-testid="venue-score-axes">
                <span className="shrink-0 text-[9px] font-bold text-white/70">50 = 평소</span>
                <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
                  <span className="absolute inset-y-0 left-1/2 w-px bg-white/30" />
                  <span
                    className={`absolute inset-y-0 ${hero.score >= 50 ? "bg-emerald-300" : "bg-rose-300"}`}
                    style={{
                      left: `${Math.min(hero.score, 50)}%`,
                      width: `${Math.abs(hero.score - 50)}%`,
                    }}
                  />
                </div>
              </div>
            )}
            {!hero.sampleLimited && hero.scoreAxes.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {[...hero.scoreAxes]
                  .sort((a, b) => Math.abs(b.normalized * b.weight) - Math.abs(a.normalized * a.weight))
                  .slice(0, 3)
                  .map((axis) => (
                    <span
                      key={axis.key}
                      data-testid="venue-score-axis"
                      className={`rounded-full border px-1.5 py-0.5 text-[9px] font-black ${
                        axis.normalized > 0.02
                          ? "border-emerald-300/40 bg-emerald-300/10 text-emerald-300"
                          : axis.normalized < -0.02
                            ? "border-rose-300/40 bg-rose-300/10 text-rose-300"
                            : "border-slate-300/30 bg-slate-300/10 text-slate-300"
                      }`}
                    >
                      {axis.normalized > 0.02 ? "▲" : axis.normalized < -0.02 ? "▼" : "→"} {axis.label}
                    </span>
                  ))}
              </div>
            )}
            {/* 삼순 2026-08-02 — 지수 아래에 상·하향 근거와 신뢰도를 1줄로 노출.
                ⚠️ 절댓값 1위 축을 고른 뒤 총점 방향을 붙이면 `승리 열세가 높은 이유`처럼
                모순 문장이 나온다(삼순 P1). 총점과 **같은 방향** 근거를 우선 고르고,
                반대 방향 축이 있으면 보조로 함께 노출한다. */}
            {!hero.sampleLimited && hero.score != null && (
              <p data-testid="venue-score-basis" className="mt-1.5 text-[10px] font-bold text-white/70">
                {(() => {
                  const byImpact = [...hero.scoreAxes].sort(
                    (a, b) => Math.abs(b.normalized * b.weight) - Math.abs(a.normalized * a.weight),
                  );
                  const confidence =
                    `${SCORE_CONFIDENCE_LABELS[scoreConfidenceLevel(a1.n)]}(${a1.n}경기)`;
                  // 삼순 P1 (2026-08-02) — 50점은 화면 계약상 `50 = 평소`(중립)다.
                  // 예전에는 `score >= 50` 을 positive 로 보고 normalized 0 인 축까지
                  // `우세` 라고 적어, 모든 축이 0인 화면에서
                  // `50점 / 기대 대비 승리 우세가 높은 이유예요` 라는 모순이 나왔다.
                  // 중립은 중립이라고 말한다.
                  if (hero.score === 50 || byImpact.every((axis) => axis.normalized === 0)) {
                    return `기대와 비슷했어요 · ${confidence}`;
                  }
                  const positiveScore = hero.score > 50;
                  const aligned = byImpact.filter((axis) =>
                    positiveScore ? axis.normalized > 0 : axis.normalized < 0);
                  const opposing = byImpact.filter((axis) =>
                    positiveScore ? axis.normalized < 0 : axis.normalized > 0);
                  // 총점과 같은 방향 축이 없으면 방향을 단정하지 않는다(0 축을 우세로 읽지 않음).
                  const lead = aligned[0] ?? null;
                  if (lead == null) return `기대 대비 성과 기준이에요 · ${confidence}`;
                  const leadText =
                    `${lead.label} ${lead.normalized > 0 ? "우세" : "열세"}`;
                  const counter = opposing[0];
                  const counterText = counter
                    ? `, ${counter.label} ${counter.normalized > 0 ? "우세" : "열세"}는 반대`
                    : "";
                  return `${leadText}가 ${positiveScore ? "높은" : "낮은"} 이유예요${counterText} · ${confidence}`;
                })()}
              </p>
            )}
            <div className="mt-2 flex items-center gap-2.5 text-[14px] font-black">
              <span className="text-sky-400">{hero.attendance?.w ?? 0}승</span>
              <span className="text-rose-300">{hero.attendance?.l ?? 0}패</span>
              <span className="text-white/65">{hero.attendance?.d ?? 0}무</span>
              <span>·</span>
              <span>승률 {formatRate(hero.attendance?.rate)}</span>
            </div>
            <p data-testid="venue-score-note" className="mt-1.5 text-[11px] font-semibold text-white/70">
              {hero.sampleLimited
                ? `종료 경기 ${a1.n}경기 기록이에요 · ${MIN_FINAL_GAMES}경기부터 팀 시즌 비교를 보여드려요`
                : hero.score == null
                  // 삼순 P1 (2026-08-02) — 표본은 충족했는데 지수만 없는 경우, 화면에
                  // `– / 지수 준비 중`만 보이면 원인을 알 수 없다. pregame 기대치를 만들
                  // 데이터가 부족하다는 사실을 명시한다(시즌 승률 비교로 대체 설명하지 않는다).
                  ? `직관 ${a1.n}경기 기록은 아래에 있어요 · 상대전력 기준 기대치를 만들 경기 데이터가 아직 부족해요`
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
              {(bestOpponent || bestWeekday || bestStadium) && (
                <div data-testid="venue-primary-insights" className="mb-2 grid grid-cols-3 gap-1.5">
                  {bestOpponent && (
                    <div className="min-w-0 rounded-xl border border-emerald-400/20 bg-emerald-400/[0.07] px-2.5 py-2.5">
                      <Swords size={13} className="text-emerald-300" />
                      <p className="mt-1 truncate text-[11px] font-black text-white">
                        {bestOpponentLabel}
                      </p>
                      <p className="text-[9px] font-bold text-emerald-300">{bestOpponent.cell.w}승 · {formatRate(bestOpponent.cell.rate, 0)}</p>
                    </div>
                  )}
                  {bestWeekday && (
                    <div className="min-w-0 rounded-xl border border-amber-300/20 bg-amber-300/[0.07] px-2.5 py-2.5">
                      <CalendarDays size={13} className="text-amber-300" />
                      <p className="mt-1 truncate text-[11px] font-black text-white">{bestWeekdayLabel}</p>
                      <p className="text-[9px] font-bold text-amber-300">{bestWeekday.cell.w}승 · {formatRate(bestWeekday.cell.rate, 0)}</p>
                    </div>
                  )}
                  {bestStadium && (
                    <div className="min-w-0 rounded-xl border border-sky-300/20 bg-sky-300/[0.07] px-2.5 py-2.5">
                      <MapPin size={13} className="text-sky-300" />
                      <p className="mt-1 truncate text-[11px] font-black text-white">{bestStadiumLabel}</p>
                      <p className="text-[9px] font-bold text-sky-300">{bestStadium.cell.w}승 · {formatRate(bestStadium.cell.rate, 0)}</p>
                    </div>
                  )}
                </div>
              )}
              {!hero.mixedTeam && (
                <div
                  data-testid="venue-team-metrics"
                  className="grid grid-cols-2 overflow-hidden rounded-2xl border border-white/8 bg-[#151519]"
                >
                  {/* 표본 미달이면 baseline이 null로 내려오므로 비교문구 자체를 감춘다("시즌 – · –" 방지). */}
                  <MetricCard
                    title="팀 타율"
                    actual={formatAvg(b1?.value?.attendanceAvg)}
                    baseline={b1?.value?.seasonAvg != null ? formatAvg(b1.value.seasonAvg) : undefined}
                    trend={metricTrend(b1?.value?.delta, { higherIsBetter: true, digits: 3, neutralThreshold: 0.004, trimLeadingZero: true })}
                    metric={b1!}
                    icon={<span className="text-[12px]">⚾</span>}
                    embedded
                    className="border-b border-r border-white/8"
                  />
                  <MetricCard
                    title="평균 득점"
                    actual={b3?.value?.runsPerGame == null ? "–" : b3.value.runsPerGame.toFixed(1)}
                    baseline={b3?.value?.seasonRunsPerGame != null ? b3.value.seasonRunsPerGame.toFixed(1) : undefined}
                    trend={metricTrend(b3?.value?.delta, { higherIsBetter: true, digits: 1, neutralThreshold: 0.15 })}
                    metric={b3!}
                    icon={<Target size={12} />}
                    embedded
                    className="border-b border-white/8"
                  />
                  <MetricCard
                    title="팀 ERA"
                    actual={formatEra(b2?.value?.attendanceEra)}
                    baseline={b2?.value?.seasonEra != null ? formatEra(b2.value.seasonEra) : undefined}
                    trend={metricTrend(b2?.value?.delta, { higherIsBetter: false, digits: 2, neutralThreshold: 0.1 })}
                    metric={b2!}
                    icon={<span className="text-[12px]">⚾</span>}
                    embedded
                    className="border-r border-white/8"
                  />
                  <MetricCard
                    title="홈런"
                    actual={b4?.value?.hr?.attendancePerGame == null ? "–" : b4.value.hr.attendancePerGame.toFixed(1)}
                    baseline={b4?.value?.hr?.seasonPerGame != null ? b4.value.hr.seasonPerGame.toFixed(1) : undefined}
                    trend={metricTrend(b4?.value?.hr?.delta, { higherIsBetter: true, digits: 1, neutralThreshold: 0.05 })}
                    metric={b4!}
                    icon={<Flame size={12} />}
                    embedded
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
                ) : visibleFavoriteIds.map((playerId) => {
                  const player = favoriteById.get(playerId);
                  const batter = c1ById.get(playerId);
                  const pitcher = c2ById.get(playerId);
                  const highlight = c4ById.get(playerId);
                  const topGame = c5?.value?.find((entry) => entry.playerId === playerId);
                  const team = player ? getTeamById(player.teamId) : null;
                  const photoUrl = player ? getPlayerPhotoUrl(player.name, playerId, player.teamId) : null;
                  const attendanceValue = batter ? formatAvg(batter.attendanceAvg) : formatEra(pitcher?.attendanceEra);
                  const seasonValue = batter ? formatAvg(batter.seasonAvg) : formatEra(pitcher?.seasonEra);
                  const boostTrend = batter
                    ? metricTrend(batter.deltaAvg, { higherIsBetter: true, digits: 3, neutralThreshold: 0.004, trimLeadingZero: true })
                    : metricTrend(pitcher?.eraImprovement == null ? null : -pitcher.eraImprovement, {
                        higherIsBetter: false, digits: 2, neutralThreshold: 0.1,
                      });
                  const compatibility = batterCompatibility(batter) ?? pitcherCompatibility(pitcher);
                  const boostTone = {
                    positive: "border-emerald-300/40 bg-emerald-300/10 text-emerald-300",
                    negative: "border-rose-300/40 bg-rose-300/10 text-rose-300",
                    neutral: "border-slate-300/30 bg-slate-300/10 text-slate-300",
                    unavailable: "border-white/10 bg-white/[0.04] text-white/60",
                  }[boostTrend.tone];
                  return (
                    <div key={playerId} data-testid="venue-favorite-card" className="rounded-2xl border border-white/8 bg-[#151519] p-3">
                      <div className="flex items-center gap-2.5">
                        <FavoritePhoto
                          photoUrl={photoUrl}
                          playerName={player?.name ?? ""}
                          teamLogoPath={team?.logoPath ?? null}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <p className="truncate text-[16px] font-black">{player?.name ?? playerId}</p>
                            {favoriteBoostLabelById.has(playerId) && (
                              <span className="shrink-0 rounded-full bg-amber-300/15 px-1.5 py-0.5 text-[9px] font-black text-amber-300">
                                {favoriteBoostLabelById.get(playerId)}
                              </span>
                            )}
                          </div>
                          {boostTrend.tone !== "unavailable" && (
                            <span data-testid="venue-favorite-trend" className={`mt-0.5 inline-flex rounded-full border px-1.5 py-0.5 text-[9px] font-black ${boostTone}`}>
                              {boostTrend.arrow} {batter ? "타율" : "ERA"} {boostTrend.label}
                            </span>
                          )}
                          <p className="mt-0.5 text-[9px] font-semibold text-white/70">
                            {team?.shortName ?? "최애 선수"}{player?.position ? ` · ${player.position}` : ""}
                          </p>
                        </div>
                        <div className="shrink-0 text-right">
                          {compatibility ? (
                            <>
                              <p className="text-[9px] font-bold text-white/60">성적 궁합</p>
                              <p data-testid="venue-compatibility-score" className={`text-[24px] font-black leading-none ${
                                compatibility.tone === "positive"
                                  ? "text-emerald-300"
                                  : compatibility.tone === "negative"
                                    ? "text-rose-300"
                                    : "text-slate-300"
                              }`}>{compatibility.score}<span className="text-[10px] text-white/60">점</span></p>
                              <p className="mt-0.5 text-[10px] font-bold text-white/70">{compatibility.evidence}</p>
                            </>
                          ) : (
                            <p className="max-w-[54px] text-[9px] font-bold leading-tight text-white/60">궁합 측정 중</p>
                          )}
                        </div>
                      </div>
                      {(batter || pitcher) && (
                        <div className="mt-2 flex items-center justify-between rounded-lg bg-white/[0.045] px-2.5 py-1.5 text-[10px] font-bold">
                          <span className="text-white/70">내 앞에서 <strong className="text-white">{attendanceValue}</strong></span>
                          {seasonValue !== "–" && <span className="text-white/55">시즌 {seasonValue}</span>}
                        </div>
                      )}
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
                {favoriteIds.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setFavoritesOpen((value) => !value)}
                    className="flex w-full items-center justify-center gap-1 rounded-xl border border-white/8 bg-white/[0.045] py-2.5 text-[11px] font-extrabold text-white/75"
                  >
                    {favoritesOpen ? "최애 접기" : `다른 최애 ${favoriteIds.length - 1}명 보기`}
                    <ChevronDown size={13} className={favoritesOpen ? "rotate-180" : ""} />
                  </button>
                )}
              </div>

              {visibleInterestingFacts.length > 0 && (
                <>
                  <SectionTitle>나의 직관 캐릭터</SectionTitle>
                  <div data-testid="venue-character-tags" className="flex flex-wrap gap-1.5">
                    {visibleInterestingFacts.map((fact) => (
                      <div
                        key={fact.key}
                        data-testid="venue-interesting-fact"
                        className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-white/10 bg-[#151519] px-2.5 py-1.5"
                      >
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                          {fact.icon}
                        </span>
                        <p className="min-w-0 truncate text-[10px] font-bold text-white/75">
                          {fact.label} <strong className="text-white">{fact.value}</strong>
                        </p>
                      </div>
                    ))}
                  </div>
                  {interestingFacts.length > 6 && (
                    <button
                      type="button"
                      onClick={() => setTagsOpen((value) => !value)}
                      className="mt-1.5 inline-flex items-center gap-1 text-[10px] font-black text-white/65"
                    >
                      {tagsOpen ? "태그 접기" : `태그 ${interestingFacts.length - 6}개 더 보기`}
                      <ChevronDown size={12} className={tagsOpen ? "rotate-180" : ""} />
                    </button>
                  )}
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
            <button
              type="button"
              onClick={() => setEvidenceOpen((value) => !value)}
              className="flex w-full items-center gap-2 text-left"
            >
              <BarChart3 size={16} className="text-[#ff6574]" />
              <p className="flex-1 text-[12px] font-extrabold">데이터 기준</p>
              <span className="truncate text-[9px] text-white/55">종료 {scope.coverage.finalGames}경기</span>
              <ChevronDown size={14} className={evidenceOpen ? "rotate-180" : ""} />
            </button>
            {evidenceOpen && (
              <>
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
                <p className="mt-1 text-[9px] leading-relaxed text-white/60">
                  성적 궁합은 타자의 타율·홈런·타점, 투수의 ERA·K/9 시즌 대비 변화에 표본 신뢰도를 반영한 100점 지표예요.
                </p>
              </>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
