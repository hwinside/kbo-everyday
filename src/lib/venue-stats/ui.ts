import type {
  A1Value,
  B1Value,
  B2Value,
  B3Value,
  B4Value,
  C1Entry,
  C2Entry,
  D7Value,
  MetricEnvelope,
  MetricId,
  VenueStatsScopePayload,
} from "@/lib/venue-stats/types";
// 순수 leaf 모듈 — aggregate.ts 는 node 전용 의존을 끌어서 클라이언트 번들에 넣으면 안 된다.
import { MIN_FINAL_GAMES } from "@/lib/venue-stats/state";

export const VENUE_STATS_UI_GROUPS = {
  hero: ["A1"],
  splits: ["A2", "A3", "A4", "A5", "A6"],
  team: ["B1", "B2", "B3", "B4"],
  favorites: ["C1", "C2", "C4", "C5", "C6"],
  story: ["D1", "D5", "D6", "D7"],
  habits: ["E1", "E2", "E3", "E4"],
} as const satisfies Record<string, readonly MetricId[]>;

export const METRIC_STATE_LABELS: Record<string, string> = {
  unsupported: "지원하지 않는 시즌",
  empty: "기록 없음",
  attendance_only: "비교 데이터 준비 중",
  invalid_snapshot: "응원팀 기록 확인 필요",
  mixed_team: "응원팀 변경 포함",
  partial_data: "일부 기록 확인 중",
  no_final: "종료 경기 없음",
  no_favorite: "최애 선수 미설정",
  // 표본 가드 미달이어도 사실값(승·패·무·비율)은 노출하고 이 배지로만 경고한다.
  // (값을 숨기면 2경기 기록이 `0승 0패 · 승률 –`으로 보여 더 나쁜 오정보가 된다 — 2026-07-31 하린아빠 결정)
  sample_limited: "표본 부족(참고용)",
  ready: "집계 완료",
  no_wins: "승리 기록 없음",
};

export function formatRate(value: number | null | undefined, digits = 1): string {
  return value == null || !Number.isFinite(value) ? "–" : `${(value * 100).toFixed(digits)}%`;
}

export function formatAvg(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "–";
  return value.toFixed(3).replace(/^0/, "");
}

export function formatEra(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? "–" : value.toFixed(2);
}

export function formatSigned(
  value: number | null | undefined,
  digits: number,
  suffix = "",
): string {
  if (value == null || !Number.isFinite(value)) return "–";
  const fixed = Math.abs(value).toFixed(digits);
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${fixed}${suffix}`;
}

export function formatOuts(outs: number | null | undefined): string {
  if (outs == null || !Number.isFinite(outs)) return "–";
  const whole = Math.floor(outs / 3);
  const rest = outs % 3;
  return rest === 0 ? `${whole}` : `${whole} ${rest === 1 ? "⅓" : "⅔"}`;
}

export type TrendTone = "positive" | "negative" | "neutral" | "unavailable";

export interface MetricTrend {
  tone: TrendTone;
  arrow: "▲" | "▼" | "→" | "";
  label: string;
}

/**
 * 실제 수치 방향(▲/▼)과 좋은지 나쁜지(tone)를 분리한다.
 * ERA처럼 낮을수록 좋은 지표도 ▼와 positive를 동시에 가질 수 있다.
 */
export function metricTrend(
  delta: number | null | undefined,
  options: {
    higherIsBetter: boolean;
    digits: number;
    neutralThreshold?: number;
    suffix?: string;
    trimLeadingZero?: boolean;
  },
): MetricTrend {
  if (delta == null || !Number.isFinite(delta)) {
    return { tone: "unavailable", arrow: "", label: "비교 준비 중" };
  }
  const threshold = options.neutralThreshold ?? 0;
  if (Math.abs(delta) <= threshold) {
    return { tone: "neutral", arrow: "→", label: "시즌과 비슷" };
  }
  const increased = delta > 0;
  const positive = options.higherIsBetter ? increased : !increased;
  const raw = Math.abs(delta).toFixed(options.digits);
  const value = options.trimLeadingZero ? raw.replace(/^0/, "") : raw;
  return {
    tone: positive ? "positive" : "negative",
    arrow: increased ? "▲" : "▼",
    label: `${increased ? "+" : "−"}${value}${options.suffix ?? ""}`,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export interface FavoriteCompatibility {
  score: number;
  tone: Exclude<TrendTone, "unavailable">;
  evidence: string;
}

/**
 * 삼순 P1 (2026-08-02) — 궁합점수는 여러 지표의 합성인데 근거를 한 개만 고정 노출하면
 * 초록 점수 옆에 "타율 ▼"만 보이는 모순이 생긴다.
 * → 합성에 기여한 지표를 기여도 순으로 정렬해 점수 방향과 같은 부호의 것을 먼저 보여주고,
 * 단일 지표로 방향이 설명되지 않으면 두 개를 함께 표기한다.
 */
interface CompatibilityContribution {
  label: string;
  delta: number;
  weightedSigned: number;
  higherIsBetter: boolean;
  digits: number;
  trimLeadingZero?: boolean;
}

function buildCompatibilityEvidence(
  contributions: CompatibilityContribution[],
  tone: Exclude<TrendTone, "unavailable">,
): string {
  const format = (c: CompatibilityContribution) => {
    const trend = metricTrend(c.delta, {
      higherIsBetter: c.higherIsBetter,
      digits: c.digits,
      trimLeadingZero: c.trimLeadingZero,
    });
    return `${c.label} ${trend.arrow} ${trend.label}`;
  };
  const ranked = [...contributions].sort(
    (a, b) => Math.abs(b.weightedSigned) - Math.abs(a.weightedSigned),
  );
  if (tone === "neutral") return format(ranked[0]);
  const wanted = tone === "positive" ? 1 : -1;
  const aligned = ranked.filter((c) => Math.sign(c.weightedSigned) === wanted);
  // 점수 방향과 같은 기여가 없을 수는 없지만(합성 부호가 그렇게 정해짐),
  // 방어적으로 비면 상위 기여 2개를 그대로 보여준다.
  const base = aligned.length > 0 ? aligned : ranked;
  const opposing = ranked.filter((c) => Math.sign(c.weightedSigned) === -wanted);
  // 반대 부호 지표가 있으면 그것도 같이 노출해야 "초록 점수 ↔ 나빠진 근거" 모순이 사라진다.
  const picked = opposing.length > 0 ? [base[0], opposing[0]] : base.slice(0, 1);
  return picked.map(format).join(" · ");
}

/** 표본 신뢰도를 50점 쪽으로 수축한 최애선수 직관 성적 궁합점수. */
export function batterCompatibility(entry: C1Entry | null | undefined): FavoriteCompatibility | null {
  if (
    !entry || entry.ab < 10 || entry.deltaAvg == null ||
    entry.seasonHrPerGame == null || entry.seasonRbiPerGame == null ||
    entry.attendanceHrPerGame == null || entry.attendanceRbiPerGame == null
  ) return null;
  const avg = clamp(entry.deltaAvg / 0.08, -1, 1);
  const hrDelta = entry.attendanceHrPerGame - entry.seasonHrPerGame;
  const rbiDelta = entry.attendanceRbiPerGame - entry.seasonRbiPerGame;
  const avgWeighted = avg * 0.6;
  const hrWeighted = clamp(hrDelta / 0.5, -1, 1) * 0.2;
  const rbiWeighted = clamp(rbiDelta / 0.8, -1, 1) * 0.2;
  const composite = avgWeighted + hrWeighted + rbiWeighted;
  const confidence = Math.sqrt(clamp(entry.ab / 40, 0, 1));
  const score = Math.round(clamp(50 + 50 * composite * confidence, 0, 100));
  const tone = score >= 56 ? "positive" : score <= 44 ? "negative" : "neutral";
  return {
    score,
    tone,
    evidence: buildCompatibilityEvidence([
      { label: "타율", delta: entry.deltaAvg, weightedSigned: avgWeighted, higherIsBetter: true, digits: 3, trimLeadingZero: true },
      { label: "홈런", delta: hrDelta, weightedSigned: hrWeighted, higherIsBetter: true, digits: 2 },
      { label: "타점", delta: rbiDelta, weightedSigned: rbiWeighted, higherIsBetter: true, digits: 2 },
    ], tone),
  };
}

export function pitcherCompatibility(entry: C2Entry | null | undefined): FavoriteCompatibility | null {
  if (
    !entry || entry.outs < 15 || entry.eraImprovement == null ||
    entry.k9Delta == null
  ) return null;
  const eraWeighted = clamp(entry.eraImprovement / 2, -1, 1) * 0.65;
  const k9Weighted = clamp(entry.k9Delta / 3, -1, 1) * 0.35;
  const composite = eraWeighted + k9Weighted;
  const confidence = Math.sqrt(clamp(entry.outs / 60, 0, 1));
  const score = Math.round(clamp(50 + 50 * composite * confidence, 0, 100));
  const tone = score >= 56 ? "positive" : score <= 44 ? "negative" : "neutral";
  return {
    score,
    tone,
    // ERA는 낮을수록 좋으므로 표기는 실제 수치 변화(-eraImprovement) 기준으로 보여준다.
    evidence: buildCompatibilityEvidence([
      { label: "ERA", delta: -entry.eraImprovement, weightedSigned: eraWeighted, higherIsBetter: false, digits: 2 },
      { label: "K/9", delta: entry.k9Delta, weightedSigned: k9Weighted, higherIsBetter: true, digits: 1 },
    ], tone),
  };
}

export interface VenueStatsScoreAxis {
  key: "winLift" | "quality" | "offense" | "mound" | "bonus";
  label: string;
  /** 정규화 기여도(-1~1). */
  normalized: number;
  weight: number;
}

export interface VenueStatsHero {
  score: number | null;
  /**
   * 요정 지수 해석 기준점. 50 = 평소와 같음(요정도 흑염룡도 아님).
   * 순수 승률이 아니라 "내가 갔을 때 평소보다 얼마나 잘했나"의 합성이다.
   */
  scoreAxes: VenueStatsScoreAxis[];
  /** 지수 수축에 쓴 신뢰도(0~1). 경기가 쌓일수록 1에 수렴. */
  scoreConfidence: number | null;
  attendance: A1Value["attendance"] | null;
  teamRate: number | null;
  deltaPp: number | null;
  mixedTeam: boolean;
  teamIds: number[];
  /**
   * 표본 미달 여부(참고용 계약 적용 대상).
   * `state === "sample_limited"` 뿐 아니라 mixed_team 이어도 총 final < MIN_FINAL_GAMES 면 true —
   * 파이프라인에서 복수 팀은 표본 가드보다 먼저 mixed_team 으로 확정되어 표본 미달이 가려진다.
   */
  sampleLimited: boolean;
}

/**
 * mixed_team 에서 B 지표는 top-level 이 null 이고 items[] 에만 팀별 값이 있다.
 * 경기수(n) 가중 평균으로 합친다 — 한 팀이라도 delta 가 없으면 추정하지 않고 null(축 제외).
 */
function weightedDelta<T>(
  metric: MetricEnvelope | undefined,
  pick: (value: T) => number | null | undefined,
): number | null {
  if (!metric) return null;
  // mixed_team 은 top-level value 가 존재하되 비교값만 null 인 shape 이다
  // (`{attendance, teamComparable:null, deltaPp:null}`). value 유무로만 분기하면
  // 팀별 items 에 살아있는 리프트를 통째로 버리게 된다 — 실제 비교값 기준으로 판정한다.
  const topLevel =
    metric.value != null && pick(metric.value as T) != null
      ? [{ value: metric.value, n: metric.n || 1 }]
      : [];
  const sources: Array<{ value: unknown; n: number }> =
    topLevel.length > 0
      ? topLevel
      : (metric.items ?? [])
          .filter((item) => item.value != null)
          .map((item) => ({ value: item.value, n: item.n || 1 }));
  if (sources.length === 0) return null;
  let weight = 0;
  let total = 0;
  for (const source of sources) {
    const delta = pick(source.value as T);
    if (delta == null || !Number.isFinite(delta)) return null;
    total += delta * source.n;
    weight += source.n;
  }
  return weight > 0 ? total / weight : null;
}

/**
 * 직관 요정 지수 v2 — 단순 승률이 아니라 "내가 갔을 때 평소보다 얼마나 잘했나"의 합성.
 *
 * v1 은 `round(직관승률×100)` 이라 강팀 팬이 자동으로 높았고 3승1패와 30승10패가 같은 75점이었다.
 * v2 는 5축 가중합 → `50 + 50·합성·신뢰도` 로, **50 = 평소와 같음**이 기준점이다.
 *  ① winLift 35% — 직관 승률 − 팀 시즌 승률(deltaPp)
 *  ② quality 25% — 경기 질 평균(D1.qualityAvg). 하린아빠 2026-08-02:
 *      "이겨도 얼마나 크게 이기는지, 져도 얼마나 박빙으로 지는지"가 긍정적으로 작용
 *  ③ offense 15% — 팀 타율 delta + 경기당 득점 delta
 *  ④ mound 15% — 팀 ERA 개선 + 피안타 개선
 *  ⑤ bonus 10% — 박빙패·대승 등 명경기 목격(가점 전용, 감점 없음)
 *
 * 값이 없는 축은 **추정하지 않고 제외**한 뒤 남은 축으로 가중치를 재정규화한다.
 * 축이 하나도 없으면 지수 자체를 null 로 fail-close 한다 — 승률로 몰래 대체하지 않는다.
 */
/**
 * 신뢰도 수축 — `r = √(n / (n + 1))`.
 *
 * 하린아빠 2026-08-02(3회 반복 지시): **"신뢰도 구간은 경기수 기준을 너무 높게 잡지 마"**
 * (+ "20경기씩 직관 가는 사람들이 많지는 않아", "10번 가는 사람도 상위 5%일듯").
 *
 * 실측(`venue_attendance` 전량 55행 / 48명, 7/4~8/1):
 *   1경기 43명 · 2경기 4명 · 4경기 1명 — **P50 1 · P95 2 · P99 4, 최대 4경기.**
 *   3경기 이상이 이미 상위 2.1%, 5경기 이상·10경기 이상은 **0명**.
 *
 * 즉 k=3(5경기에서 해제)은 **실사용자가 사실상 도달하지 못하는 기준**이었다.
 * k=1 로 낮춘다: 3경기 .87 · 4경기 .89 · 5경기 .91 · 8경기 .94.
 * → **3경기(=`MIN_FINAL_GAMES`, 지수 산출 최소 표본)에서 이미 보정이 거의 해제**된다.
 *
 * 하한을 더 내리지 않는 이유: 지수 자체가 3경기 미만이면 `sample_limited` 로
 * fail-close 되므로, r 은 "지수를 보여주는 구간" 안에서만 의미가 있다.
 *
 * ⚠️ 위 백분위는 '이용 빈도' 근거이지 통계적 신뢰도 근거가 아니다(삼순 지적).
 * 그래서 점수 반응성(r)과 사용자에게 보이는 신뢰도 라벨을 분리해 둔다.
 * ⚠️ 이 분포는 기능 오픈 직후 한 달치다. 시즌이 쌓이면 재측정 대상.
 */
const SCORE_CONFIDENCE_K = 1;

/** 실측 직관 횟수 분포 — 라벨 임계가 이 분포를 벗어나면 회귀가 FAIL. */
export const MEASURED_ATTENDANCE_DISTRIBUTION = {
  users: 48,
  p50: 1,
  p95: 2,
  p99: 4,
  max: 4,
} as const;

/**
 * 지수 배지 — 화면에 뜨는 등급 문구. 정규화 스케일 민감도 회귀가 이 함수로
 * "스케일을 바꿔도 배지 구간이 흔들리지 않는가"를 검증한다(삼순 P0 2026-08-02).
 */
export function scoreBadgeLabel(score: number): string {
  if (score >= 70) return "진짜 요정";
  if (score >= 56) return "약간 요정";
  if (score >= 45) return "평소와 비슷";
  if (score >= 30) return "살짝 흑염룡";
  return "흑염룡";
}

export type ScoreConfidenceLevel = "measuring" | "low" | "medium" | "high";

/**
 * **기록 충분도** 라벨 — 삼순 P1(2026-08-02) 반영으로 `신뢰도`에서 의미를 바꿨다.
 *
 * 이전에는 `신뢰도 높음` 이라고 썼는데, 근거는 이용 빈도 백분위였다.
 * 주석에서 스스로 "백분위는 통계적 신뢰도 근거가 아니다" 라고 해놓고 라벨은
 * 신뢰도라고 부른 것 자체가 모순이다. holdout 기반 불확실성 추정이 없는 이상
 * **통계적 신뢰도를 주장할 수 없으므로, 주장하지 않는 이름으로 바꾼다.**
 *
 * `기록 충분도` 는 "이 사람의 직관 기록이 지수를 만들기에 얼마나 쌓였나" 라는
 * 순수 표본량 서술이다. 실측 최대 4경기 분포 안에서 3 적음 · 4 보통 · 5+ 충분.
 * (3경기 미만은 지수를 아예 안 보여주므로 `측정 중`.)
 */
export function scoreConfidenceLevel(finalGames: number): ScoreConfidenceLevel {
  if (finalGames < MIN_FINAL_GAMES) return "measuring";
  if (finalGames < 4) return "low";
  if (finalGames < 5) return "medium";
  return "high";
}

export const SCORE_CONFIDENCE_LABELS: Record<ScoreConfidenceLevel, string> = {
  measuring: "측정 중",
  low: "기록 적음",
  medium: "기록 보통",
  high: "기록 충분",
};

/**
 * 요정 지수 축 — 오직 "내가 간 날의 팀 초과성과"만 다룬다.
 *
 * 관전가치(경기 질)·명경기 보너스는 제거했다 — 둘이 같은 것을 이중 가산했고,
 * 무엇보다 "재밌는 경기"는 팀 성과가 아니다(하린아빠 2026-08-02:
 * "관전가치 기준이 아니라 무조건 팀퍼포먼스와의 상관도를 봐야지").
 *
 * 삼순 2026-08-02 확정 가중:
 *  ① winExcess 55% — pregame 기대승률(상대전력 log5 + 홈/원정) 대비 실제 승점
 *  ② marginExcess 30% — pregame 기대 마진 대비 실제 마진(상한 적용)
 *  ③ 타선·마운드 15% — 팀 시즌 대비 초과성과(둘 다 있으면 7.5%씩)
 *
 * 핵심: 1점차 패는 5점차 패보다 높지만 **자동 플러스가 아니다.**
 * 강팀 상대 기대 −3인데 −1이면 플러스 / 약팀 상대 기대 +2인데 −1이면 마이너스.
 *
 * pregame 기대치가 없으면 축 재정규화가 아니라 **지수 전체 fail-close**(삼순 P0).
 */
/**
 * 축 정규화 스케일 — **제품 정책 상수**(삼순 P0 2026-08-02).
 *
 * ⚠️ 이전에는 주석만 "실전 평균 ±0.35" 라고 써 두고 근거도 회귀도 없었다.
 * 삼순 지적: `.35/3` 을 `.25/2` 로 바꾸면 같은 경기가 71점 → 80점이 되어
 * `약간 요정 ↔ 진짜 요정` 배지가 뒤집히는데, 어떤 게이트도 그걸 막지 못했다.
 *
 * **holdout 보정이 아니라 정책 경로를 택한다.** 이유:
 *  - 초과성과의 "얼마면 극단인가"는 통계량이 아니라 **점수 체감**의 문제다.
 *    (같은 데이터에서도 100점 만점을 어디에 걸지는 제품 결정)
 *  - 현재 표본(직관 최대 4경기)으로는 분위수 추정 자체가 불안정하다.
 *
 * 대신 **정책 상수로 명시 선언**하고, 아래 두 가지를 회귀로 잠근다:
 *  ① 값 자체 고정 — 바꾸면 FAIL(무단 재튜닝 차단)
 *  ② raw-game 민감도 행렬 — 스케일이 바뀌어도 **순서·부호·배지 구간**이
 *     흔들리지 않는지. 즉 상수 하나로 사용자 체감이 뒤집히지 않음을 증명한다.
 *
 * 재튜닝하려면 회귀를 함께 고쳐야 하므로, 근거 없이 조용히 바뀔 수 없다.
 */
export const SCORE_SCALE = {
  /** 승점 초과 ±0.35 를 축 끝(±1)으로. 기대보다 35%p 더/덜 이긴 상태. */
  winExcess: 0.35,
  /** 마진 초과 ±3점을 축 끝으로. 기대보다 평균 3점 더/덜 = 압도적. */
  marginExcess: 3,
} as const;

function buildScoreAxes(scope: VenueStatsScopePayload): VenueStatsScoreAxis[] {
  const axes: VenueStatsScoreAxis[] = [];
  const push = (
    key: VenueStatsScoreAxis["key"],
    label: string,
    normalized: number | null,
    weight: number,
  ) => {
    if (normalized == null || !Number.isFinite(normalized)) return;
    axes.push({ key, label, normalized: clamp(normalized, -1, 1), weight });
  };

  const a1 = scope.metrics.A1 as MetricEnvelope<A1Value> | undefined;
  const excess = a1?.value?.excess ?? null;
  // 기대치 없음 → 빈 축 배열 → 호출측이 score=null 로 닫는다. 승률로 대체하지 않는다.
  if (excess == null) return [];

  push("winLift", "기대 대비 승리", excess.winExcess / SCORE_SCALE.winExcess, 0.55);
  push("quality", "기대 대비 득실", excess.marginExcess / SCORE_SCALE.marginExcess, 0.3);

  const avgDelta = weightedDelta<B1Value>(scope.metrics.B1, (v) => v.delta);
  const runsDelta = weightedDelta<B3Value>(scope.metrics.B3, (v) => v.delta);
  const offenseParts: number[] = [];
  if (avgDelta != null) offenseParts.push(clamp(avgDelta / 0.05, -1, 1));
  if (runsDelta != null) offenseParts.push(clamp(runsDelta / 2, -1, 1));

  // ERA·피안타는 낮을수록 좋으므로 부호를 뒤집어 "개선량"으로 맞춘다.
  const eraDelta = weightedDelta<B2Value>(scope.metrics.B2, (v) => v.delta);
  const hitsAllowedDelta = weightedDelta<B4Value>(
    scope.metrics.B4,
    (v) => v.hitsAllowed?.delta ?? null,
  );
  const moundParts: number[] = [];
  if (eraDelta != null) moundParts.push(clamp(-eraDelta / 1.5, -1, 1));
  if (hitsAllowedDelta != null) moundParts.push(clamp(-hitsAllowedDelta / 2, -1, 1));

  const mean = (parts: number[]) =>
    parts.length > 0 ? parts.reduce((s, v) => s + v, 0) / parts.length : null;
  const offense = mean(offenseParts);
  const mound = mean(moundParts);
  const sideCount = (offense == null ? 0 : 1) + (mound == null ? 0 : 1);
  if (sideCount > 0) {
    push("offense", "팀 타선", offense, 0.15 / sideCount);
    push("mound", "팀 마운드", mound, 0.15 / sideCount);
  }
  return axes;
}

export function buildVenueStatsHero(scope: VenueStatsScopePayload): VenueStatsHero {
  const metric = scope.metrics.A1 as MetricEnvelope<A1Value>;
  const value = metric.value;
  const attendance = value?.attendance ?? null;
  const teamIds = new Set<number>();
  if (value?.teamComparable?.teamId != null) teamIds.add(value.teamComparable.teamId);
  for (const item of metric.items ?? []) {
    const teamId = Number(item.key);
    if (Number.isInteger(teamId)) teamIds.add(teamId);
  }
  // 표본 미달이면 사실값(W/L/D·승률)만 노출하고 파생 '요정 지수'는 확정값처럼 보이지 않게 비운다.
  // (2승 0패 → score 100 같은 과대 확정 표기 차단 — 2026-07-31 삼순 리뷰)
  //
  // ⚠️ state 열거로 막으면 계속 구멍이 생긴다. 판정 사다리에서 mixed_team·attendance_only 등이
  // sample_limited 보다 먼저 확정되므로, state 가 무엇이든 실제 종료 경기수가 가드 미만이면
  // 참고용 계약을 적용한다 (삼순 P0-2 mixed / P0-1 attendance_only 연속 재발 → 사실 기준으로 결속).
  //
  // `ready` 는 집계가 이미 표본을 보장한 상태라 그대로 둔다. 그 밖의 state 에서만
  // 실제 종료 경기수로 한 번 더 막는다 — mixed_team·attendance_only 등이 사다리 앞쪽에서
  // 확정되면 표본 미달이 state 에 가려지기 때문이다.
  const finalGames = metric.denominator?.attendanceFinalGames ?? metric.n;
  const sampleLimited =
    metric.state === "sample_limited" ||
    (metric.state !== "ready" && finalGames < MIN_FINAL_GAMES);

  // v2 합성 지수. 축이 하나도 없으면 null — 승률로 조용히 대체하지 않는다.
  const scoreAxes = sampleLimited ? [] : buildScoreAxes(scope);
  const axisWeight = scoreAxes.reduce((sum, axis) => sum + axis.weight, 0);
  const scoreConfidence = sampleLimited
    ? null
    : Math.sqrt(finalGames / (finalGames + SCORE_CONFIDENCE_K));
  const composite =
    axisWeight > 0
      ? scoreAxes.reduce((sum, axis) => sum + axis.normalized * axis.weight, 0) / axisWeight
      : null;
  const score =
    composite == null || scoreConfidence == null
      ? null
      : Math.round(clamp(50 + 50 * composite * scoreConfidence, 0, 100));

  return {
    score,
    scoreAxes,
    scoreConfidence,
    attendance,
    teamRate: value?.teamComparable?.rate ?? null,
    deltaPp: value?.deltaPp ?? null,
    mixedTeam: metric.state === "mixed_team",
    teamIds: [...teamIds],
    sampleLimited,
  };
}

/**
 * A2~A6 스플릿 cell 목록.
 *
 * 집계는 표본 충족 cell 만 top-level `value` 에 두고, 표본 미달 cell 은 `items[].value` 에만
 * 사실값을 보존한다. UI 가 top-level 만 읽으면 "두산전 1승" 같은 실제 기록이
 * `표시할 기록이 없어요` 로 사라진다(삼순 P0-2). items 를 우선해 합친다.
 *
 * items 가 없는 구버전 payload 는 top-level 로 폴백한다.
 */
export function splitCells<T>(metric: MetricEnvelope): Array<{ key: string; cell: T; sampleLimited: boolean }> {
  const items = metric.items ?? [];
  if (items.length > 0) {
    return items
      .filter((item) => item.value != null)
      .map((item) => ({
        key: item.key,
        cell: item.value as T,
        sampleLimited: item.state === "sample_limited",
      }));
  }
  return ((metric.value as T[] | null) ?? []).map((cell, index) => ({
    key: String(index),
    cell,
    sampleLimited: false,
  }));
}

export function metricEvidence(metric: MetricEnvelope): string {
  const bits: string[] = [];
  const d = metric.denominator ?? {};
  const games =
    d.finalGames ??
    d.attendanceFinalGames ??
    d.attendanceGames ??
    d.eligibleTeamFinalGames;
  if (typeof games === "number") bits.push(`경기 ${games}`);
  const ab = d.attendanceAB;
  if (typeof ab === "number") bits.push(`AB ${ab}`);
  const outs = d.attendanceOuts;
  if (typeof outs === "number") bits.push(`IP ${formatOuts(outs)}`);
  if (bits.length === 0) bits.push(`표본 ${metric.n}`);
  return bits.join(" · ");
}

/**
 * 원정 직관 성향 — 하린아빠 2026-08-02:
 * **"보통 홈구장만 가는 팬이 대부분인데 원정까지 많이 가는 팬은 정말 찐팬이니 이것도 추가"**
 *
 * ⚠️ 이전 구현(대시보드 인라인)은 임계가 `원정 8경기 & 4개 구장`(원정대장) /
 * `3개 구장`(전국구 팬) 이었다. 신뢰도 때와 **같은 실수** — 실측 분포를 안 보고 잡았다.
 *
 * 실측(`venue_attendance` 55행, 응원팀 실제 출전 49행 · 유효 42명):
 *   홈 36 · 원정 13 → **원정 비중 26.5%**
 *   유저별 원정: 0경기 30명 · 1경기 11명 · **2경기 1명(최대)**
 *   원정 구장 수: 0개 30명 · 1개 11명 · 2개 1명
 *   원정 경험자 12/42 = **29%** (= 하린아빠 말대로 "대부분은 홈만 간다")
 *
 * 즉 구 임계는 **전 유저가 `첫 원정` 하나에만 걸리는** 구조였다.
 * 관측된 분포 안에서 등급을 나눈다 — 원정 1회부터 이미 상위 29%다.
 *
 * ⚠️ 오픈 직후 한 달치 분포이므로 시즌이 쌓이면 재측정 대상.
 */
export const MEASURED_AWAY_DISTRIBUTION = {
  validUsers: 42,
  awayExperiencedUsers: 12,
  /** 원정 경험자 비율 — 원정 1회만으로도 상위 29%. */
  awayExperiencedShare: 12 / 42,
  /** 관측된 유저별 원정 경기 최대치. */
  maxAwayGames: 2,
  /** 관측된 유저별 원정 구장 수 최대치. */
  maxAwayStadiums: 2,
  /** 전체 직관 중 원정 비중. */
  awayShare: 13 / 49,
} as const;

export interface AwayFanTag {
  label: string;
  value: string;
  /** 단계 — 회귀에서 임계 재상향을 감지하기 위한 서수. */
  tier: 1 | 2 | 3 | 4;
}

/**
 * 원정 성향 태그. 원정 **경기수·구장수·비중**을 함께 본다.
 *
 * 단계(실측 기준):
 *  1 `첫 원정`     원정 1경기 — 이미 상위 29%
 *  2 `원정러`      원정 2경기(관측 최대) 또는 원정 비중이 전체 평균(26.5%)의 1.5배 이상
 *  3 `전국구 팬`   원정 구장 2곳 이상 — 관측 최대치
 *  4 `원정대장`    원정 3경기+ & 구장 2곳+ — 현재 아무도 없는 "미래 등급"
 *
 * ④만 관측 밖에 두는 이유: 성장 여지를 남기되, ①~③으로 **현재 유저가 반드시 어딘가에
 * 도달**하도록 만든다. 도달 불가 등급만 잔뜩 만드는 게 직전 결함이었다.
 */
export function awayFanTag(input: {
  awayGames: number;
  awayStadiums: number;
  totalGames: number;
}): AwayFanTag | null {
  const { awayGames, awayStadiums, totalGames } = input;
  if (!Number.isFinite(awayGames) || awayGames <= 0) return null;
  const evidence = awayStadiums > 1
    ? `원정 ${awayGames}경기 · ${awayStadiums}개 구장`
    : `원정 ${awayGames}경기`;
  const share = totalGames > 0 ? awayGames / totalGames : 0;
  if (awayGames >= 3 && awayStadiums >= 2) return { label: "원정대장", value: evidence, tier: 4 };
  if (awayStadiums >= 2) return { label: "전국구 팬", value: evidence, tier: 3 };
  if (awayGames >= 2 || share >= MEASURED_AWAY_DISTRIBUTION.awayShare * 1.5) {
    return { label: "원정러", value: evidence, tier: 2 };
  }
  return { label: "첫 원정", value: evidence, tier: 1 };
}

/**
 * 팀-경기 실책 실측 분포 — 2026 시즌 **493경기 / 986 팀-경기 전수**
 * (Naver record `scoreBoard.rheb.e`, 조회 성공 493/493).
 *
 * ```
 * 0실책 518 (52.5%) · 1실책 308 (31.2%) · 2실책 109 (11.1%)
 * 3실책  46 ( 4.7%) · 4실책   4 ( 0.4%) · 5실책   1 ( 0.1%)
 * 팀-경기 평균 0.695개
 * ```
 *
 * 누적: `≥1` 47.5% · **`≥2` 16.2%** · `≥3` 5.2% · `≥4` 0.5%
 *
 * ⚠️ 이 상수는 회귀가 임계 근거로 직접 검증한다. 임계를 바꾸려면 회귀도 함께 고쳐야
 * 하므로 근거 없는 재튜닝이 불가능하다(#1055 신뢰도·원정 임계에서 같은 실수를 반복한 뒤 도입).
 */
export const MEASURED_TEAM_GAME_ERRORS = {
  games: 493,
  teamGames: 986,
  histogram: { 0: 518, 1: 308, 2: 109, 3: 46, 4: 4, 5: 1 } as Record<number, number>,
  meanPerTeamGame: 0.695,
} as const;

/**
 * `발암경기` 판정 임계 — **한 경기에서 내 팀 실책 2개 이상**.
 *
 * 실측 상위 16.2% 구간이다. 1개로 내리면 47.5%가 발암경기가 되어 변별력이 없고,
 * 3개로 올리면 5.2%라 대부분의 유저가 도달하지 못한다(직관 최대 4경기).
 *
 * 경기당 평균이 아니라 **경기 단위 판정**을 쓰는 이유: 유저 직관 표본이 1~4경기라
 * 평균은 잡음이 크고, `발암경기 인내형`이라는 이름 자체가 "그런 경기를 봤다"는 뜻이다.
 */
export const ERROR_PRONE_MIN = 2;

export interface VenueErrorTags {
  /** 실책을 많이 본 쪽 태그. */
  heavy: { label: string; value: string } | null;
  /** 실책을 거의 못 본 쪽 태그. */
  clean: { label: string; value: string } | null;
}

/**
 * 실책 목격 태그 — 하린아빠 2026-08-02:
 * **"유독 실책을 많이 보는 발암경기 인내형"** (+ "태그는 사소하고 많을수록 좋아").
 *
 * ⚠️ 분모 계약이 핵심이다. 실책은 linescore 조회가 실패할 수 있어 경기별로 **미확인**이
 * 존재하고, D7 은 확인된 경기만 `knownGames` 로 센다. 미확인을 0으로 세면 "실책을 안 본
 * 사람"으로 둔갑하므로, D7 이 `ready` 가 아니면 태그를 아예 만들지 않는다.
 */
export function venueErrorTags(value: D7Value | null | undefined): VenueErrorTags {
  const empty: VenueErrorTags = { heavy: null, clean: null };
  if (!value) return empty;
  const { myTeamErrors, opponentErrors, errorProneGames, knownGames, worstGame } = value;
  if (!Number.isFinite(knownGames) || knownGames < MIN_FINAL_GAMES) return empty;
  if (!Number.isFinite(errorProneGames)) return empty;

  const evidence = `내 팀 ${myTeamErrors}실책 · ${knownGames}경기`;

  if (errorProneGames > 0) {
    // 발암경기를 절반 이상 봤으면 강한 신호, 아니면 목격 사실만.
    const heavyShare = errorProneGames / knownGames;
    const worstText = worstGame && worstGame.errors >= ERROR_PRONE_MIN
      ? `한 경기 ${worstGame.errors}실책 · `
      : "";
    return {
      heavy: heavyShare >= 0.5
        ? { label: "발암경기 인내형", value: `${worstText}발암경기 ${errorProneGames}/${knownGames}` }
        : { label: "실책 목격자", value: `${worstText}${evidence}` },
      clean: null,
    };
  }
  if (myTeamErrors === 0) {
    return {
      heavy: null,
      clean: { label: "무결점 수비 관람", value: `${knownGames}경기 내 팀 실책 0` },
    };
  }
  // 상대 실책을 더 많이 본 경우 — 반사이익 태그.
  if (opponentErrors > myTeamErrors * 2 && opponentErrors >= 2) {
    return {
      heavy: null,
      clean: {
        label: "상대 실책 수집가",
        value: `상대 ${opponentErrors}실책 vs 내 팀 ${myTeamErrors}`,
      },
    };
  }
  return empty;
}

export function coverageCaption(scope: VenueStatsScopePayload): string {
  const { attendanceGames, finalGames, incompleteFinalGames, unavailableGames } = scope.coverage;
  const gaps = incompleteFinalGames + unavailableGames;
  return gaps > 0
    ? `직관 ${attendanceGames}경기 · 종료 ${finalGames}경기 · 확인 중 ${gaps}경기`
    : `직관 ${attendanceGames}경기 · 종료 ${finalGames}경기 · 기록 확인 완료`;
}
