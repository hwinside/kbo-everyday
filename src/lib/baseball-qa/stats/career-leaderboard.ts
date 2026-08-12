import baselineJson from "../../../../data/baseball-qa/kbo-career-hitter-through-2025.json";
import {
  fetchServedBatterSnapshot,
  SERVED_BATTER_FULL_ENTRY_IDS,
} from "./served-record";
import { STATS_STALE_MS, type SeasonRecordRow } from "./season-record";
import { canonicalKboId } from "@/lib/utils/resolve-player";
import { KBO_OFFICIAL_METRIC_TERMS } from "./kbo-official-metric-columns";

const CAREER_SOURCE_URL = "https://www.koreabaseball.com/Record/Player/HitterBasic/BasicTotal.aspx";

export type CareerLeaderboardMetric = "hits";
export interface CareerLeaderboardIntent {
  metric: CareerLeaderboardMetric;
  label: "안타";
}
interface BaselineRow {
  kboId: string;
  name: string;
  team: string;
  hits: number;
}
interface BaselineSnapshot {
  schemaVersion: number;
  throughSeason: number;
  source: { url: string; seasonValue: string; sortKey: string; order: string };
  rowCount: number;
  rows: BaselineRow[];
}
export interface CareerLeaderboardAnswer {
  metric: CareerLeaderboardMetric;
  label: string;
  leaders: Array<{ kboId: string; name: string; team: string; total: number; baseline: number; current: number }>;
  asOf: string;
  baselineThroughSeason: number;
  sourceUrl: string;
}
export type CareerLeaderboardFetcher = (
  intent: CareerLeaderboardIntent,
  now?: Date,
) => Promise<CareerLeaderboardAnswer | null>;

/** 라우터와 intent resolver가 공유하는 유일한 시점어 SSOT. */
export const CAREER_LEADERBOARD_TEMPORAL_WORDS = [
  "통산", "역대", "커리어", "누적", "올타임",
] as const;

function compactCareerQuestion(question: string): string {
  return question
    .normalize("NFKC")
    .toLowerCase()
    .trim()
    .replace(/[?!？！.,。]+$/g, "")
    .replace(/\s+/g, "");
}

/**
 * 통산 리더보드로 물을 수 있는 **누적 기록 지표의 닫힌 SSOT**.
 *
 * ⚠️ 손으로 열거하지 않는다(삼순 #1159 10차 P0). KBO 공식 기록실 컬럼 inventory
 * (`kbo-official-metric-columns.ts`)에서 **기계적으로 파생**한다. 손열거였을 때 실제로
 * `OOB(주루사)`·`PKO(견제사)` 가 빠졌고, 게이트는 그 누락을 "미열거 허용"으로 굳혀
 * "공식 컬럼 전수" 계약과 정면 충돌했다. 컬럼을 추가하면 판정이 자동으로 따라오고,
 * 판정 어휘만 몰래 늘리는 것은 게이트의 exact-set 대조가 막는다.
 *
 * ⚠️ **왜 지표 어휘만으로 판정하는가** (2026-08-12 하린아빠 A안 확정).
 * 종전에는 "순위를 요구하는 표현"(`1위`·`최다`·`많`·`상위`…)도 표지로 봤다. 그 축은
 * **열린 언어**라 반례마다 룰이 늘었다 — 6차(지표 열거) → 7차(`많` 추가) → 9차(`많`
 * 과차단 되돌리기)로 같은 축에서 세 번 왕복했다. 표지 축을 통째로 버리고, 공식 컬럼이라는
 * **닫힌 집합**만 룰로 판정한다. 표현이 어떻든 지표 어휘가 없으면 우리 소관이 아니다.
 *
 * 목록에 없는 지표는 LLM 으로 내려가지만, 그건 이 함수가 아니라 기존 숫자 환각 게이트가
 * 받는 2차 방어다. 공식 컬럼이 늘면 inventory 에 한 줄 추가로 끝난다.
 */
export const CAREER_LEADERBOARD_METRIC_WORDS = KBO_OFFICIAL_METRIC_TERMS;

/**
 * 통산 리더보드 질문인가 — **미지원 지표까지 포함해** hold 로 닫아야 하는 범위.
 *
 * 판정은 **한 줄**이다: `시점어(통산·역대·커리어·누적·올타임) + 공식 지표 컬럼 어휘`.
 * 두 축 모두 닫힌 집합이라 반례가 와도 inventory 한 줄로 끝나고, 표현 변이를 쫓지 않는다.
 *
 * ⚠️ 별도 prefilter 를 두지 않는다(삼순 8차 P0). 앞단에 ask regex 를 따로 두었더니
 * 뒤의 계약과 어긋나 `통산 끝내기 상위 10명` 류가 앞단에서 탈락해 generic LLM 으로 샜다.
 * 이 함수 하나가 라우터·게이트·prefilter 전부의 유일한 계약이다.
 *
 * ⚠️ 일반명사와 충돌하는 공식 컬럼(`G=경기`·`GS=선발`)은 판정 어휘에서 제외돼 있다.
 * 그래서 `역대 최고의 경기 알려줘`·`커리어 선발로 가장 기억나는 경기는?` 은 여기서 빠져
 * LLM 범위 판정으로 내려간다(삼순 10차 P0). 같은 컬럼은 `경기수`·`선발등판` 같은
 * 비일반 공식 표기로만 결속한다.
 */
export function isCareerLeaderboardHoldScope(question: string): boolean {
  const normalized = compactCareerQuestion(question);
  if (!CAREER_LEADERBOARD_TEMPORAL_WORDS.some((word) => normalized.includes(word))) return false;
  return CAREER_LEADERBOARD_METRIC_WORDS.some((word) => normalized.includes(word));
}

/**
 * 넓은 리더보드 scope. **hold scope 와 같은 함수다** — 이름만 다른 두 판정이 존재하면
 * 다시 drift 가 난다(위 주석의 실측 사고). 재수출로 물리적으로 하나임을 강제한다.
 */
export const isCareerLeaderboardQuestion = isCareerLeaderboardHoldScope;

/** 첫 수직 슬라이스: 질문 **전체를 consume하는 안타+단일 1위 positive grammar**만 지원한다.
 *
 * 부분문자열 매칭은 `안타 1위는 누구고 2위는?`의 앞 절만 먹거나, `홈런 1위는? 안타도`
 * 에서 다른 절의 안타를 지표로 오결속한다(삼순 4차 NO-GO). 끝 문장부호만 제거한 전체 문자열이
 * 아래 두 폐쇄 문법 중 하나와 완전히 일치할 때만 지원한다. */
export function resolveCareerLeaderboardIntent(question: string): CareerLeaderboardIntent | null {
  const normalized = compactCareerQuestion(question);
  const temporal = `(?:${CAREER_LEADERBOARD_TEMPORAL_WORDS.join("|")})`;
  const who = "(?:누구(?:야|인가|인가요|예요)?|누가|누군(?:데|가요)?|알려(?:줘|주세요)?)";
  const explicitFirst = new RegExp(`^${temporal}안타(?:기록)?1위(?:는|가|를)?${who}$`);
  const singularLeader = new RegExp(
    `^${temporal}(?:최다안타|안타최다|안타선두)(?:기록)?(?:는|가|를)?` +
    `(?:${who}|누가(?:갖고있어|보유하고있어))$`,
  );
  if (!explicitFirst.test(normalized) && !singularLeader.test(normalized)) return null;
  return { metric: "hits", label: "안타" };
}

function validSnapshot(value: unknown): value is BaselineSnapshot {
  const s = value as Partial<BaselineSnapshot>;
  if (s.schemaVersion !== 1 || s.throughSeason !== 2025 || s.source?.url !== CAREER_SOURCE_URL) return false;
  if (s.source.seasonValue !== "9999" || s.source.sortKey !== "HIT_CN" || s.source.order !== "DESC") return false;
  if (!Array.isArray(s.rows) || s.rows.length < 100 || s.rowCount !== s.rows.length) return false;
  const ids = new Set<string>();
  for (const row of s.rows) {
    if (!/^\d+$/.test(row.kboId) || !row.name || typeof row.team !== "string" || !Number.isInteger(row.hits) || row.hits < 0) return false;
    if (ids.has(row.kboId)) return false;
    ids.add(row.kboId);
  }
  return true;
}

export function resolveCareerLeaderboard(
  snapshot: unknown,
  currentRows: SeasonRecordRow[],
  updatedAt: string,
  intent: CareerLeaderboardIntent,
  now = new Date(),
): CareerLeaderboardAnswer | null {
  if (!validSnapshot(snapshot)) return null;
  const updatedMs = Date.parse(updatedAt);
  if (!Number.isFinite(updatedMs) || now.getTime() - updatedMs > STATS_STALE_MS || updatedMs > now.getTime() + 5 * 60_000) {
    return null;
  }
  // 빈/부분 2026 스냅샷 fail-close — 행수 하한은 리더를 뺀 임의 N행도 통과한다.
  // 실제 full=1 merge 입력인 static ID 전집합을 모두 포함해야 현재 스냅샷으로 인정한다.
  const currentById = new Map<string, SeasonRecordRow>();
  for (const row of currentRows) {
    const id = String(row.kbo_id ?? row.player_key ?? "");
    if (!id || currentById.has(id)) return null;
    // 서빙 컬럼 원타입 계약: 문자열 "109" 는 Number() 로 통과하지만 스키마 변형의 증거다.
    const raw = row[intent.metric];
    if (raw === undefined || raw === null || typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
      return null;
    }
    currentById.set(id, row);
  }
  if (!SERVED_BATTER_FULL_ENTRY_IDS.every((id) => currentById.has(id))) return null;
  const ranked = snapshot.rows.map((base) => {
    const canonicalId = canonicalKboId(base.kboId);
    const current = currentById.get(canonicalId);
    if (current && current.name !== base.name) return null;
    // delta 는 위 루프에서 원타입 검증을 통과한 값만 온다 — 이중 가드를 두면
    // mutation 이 서로를 가려 검출력이 0이 된다(단일 권위 가드 원칙).
    const delta = current == null ? 0 : (current[intent.metric] as number);
    return {
      kboId: canonicalId,
      name: base.name,
      team: (current?.team as string | null | undefined) || base.team,
      total: base[intent.metric] + delta,
      baseline: base[intent.metric],
      current: delta,
    };
  });
  if (ranked.some((row) => row === null)) return null;
  const rows = ranked.filter((row): row is NonNullable<typeof row> => row !== null)
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, "ko"));
  const top = rows[0]?.total;
  if (top == null) return null;
  return {
    metric: intent.metric,
    label: intent.label,
    leaders: rows.filter((row) => row.total === top),
    asOf: updatedAt,
    baselineThroughSeason: snapshot.throughSeason,
    sourceUrl: snapshot.source.url,
  };
}

export function composeCareerLeaderboardAnswer(result: CareerLeaderboardAnswer): string {
  const date = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(result.asOf)).replace(/\.\s*/g, "-").replace(/-$/, "");
  const names = result.leaders.map((row) => `${row.name}(${row.team})`).join("·");
  const total = result.leaders[0].total.toLocaleString("ko-KR");
  const breakdown = result.leaders.length === 1
    ? ` (${result.baselineThroughSeason}년 말 ${result.leaders[0].baseline.toLocaleString("ko-KR")} + 2026시즌 ${result.leaders[0].current.toLocaleString("ko-KR")})`
    : "";
  return `${date} 기준 KBO 통산 ${result.label} 1위는 ${names}, ${total}${result.label}입니다.${breakdown}\n📄 출처: KBO 공식 기록실(${result.baselineThroughSeason}년 말 통산) + 크보팬 2026 시즌 기록`;
}

export function createCareerLeaderboardFetcher(): CareerLeaderboardFetcher {
  return async (intent, now = new Date()) => {
    const current = await fetchServedBatterSnapshot();
    return resolveCareerLeaderboard(baselineJson, current.rows, current.updatedAt, intent, now);
  };
}
