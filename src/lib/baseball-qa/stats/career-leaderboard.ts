import baselineJson from "../../../../data/baseball-qa/kbo-career-hitter-through-2025.json";
import {
  fetchServedBatterSnapshot,
  SERVED_BATTER_FULL_ENTRY_IDS,
} from "./served-record";
import { STATS_STALE_MS, type SeasonRecordRow } from "./season-record";
import { canonicalKboId } from "@/lib/utils/resolve-player";

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
 * ⚠️ 이 목록은 라우터가 아니라 여기 한 곳에만 있다(삼순 5차 P0). `STAT_WORDS` 는
 * 선수 개인 기록 축의 토큰 매칭용이라 `다승`·`이닝`·`실책` 같은 통산 표현이 없고,
 * 라우터에 별도 regex 를 두면 두 목록이 조용히 어긋난다.
 *
 * ⚠️ **왜 지표 어휘만으로 판정하는가** (2026-08-12 하린아빠 A안 확정).
 * 종전에는 여기에 더해 "순위를 요구하는 표현"(`1위`·`최다`·`많`·`상위`…)도 표지로 봤다.
 * 그 축은 **열린 언어**라 반례마다 룰이 늘었다 — 6차(지표 열거) → 7차(`많` 추가) →
 * 9차(`많` 과차단 되돌리기)로 같은 축에서 세 번 왕복했고, 좁히면 누락이 생기고 넓히면
 * 무관한 서술형(`누적 피로가 많으면 구속이 떨어져?`)까지 차단됐다.
 * 그래서 표지 축을 **통째로 버린다**. KBO 기록 지표는 공식 기록실 컬럼이라 **유한한
 * 닫힌 집합**이고, 닫힌 집합만 룰로 판정한다는 계약(`MEMORY: 열린 자연어는 룰로 안 닫힌다`)에
 * 정확히 맞는 축이다. 표현이 어떻든 **지표 어휘가 없으면 우리 소관이 아니다**.
 *
 * 목록에 없는 지표(`통산 폭투 1위`)는 LLM 으로 내려가지만, 그건 이 함수가 아니라
 * 기존 숫자 환각 게이트가 받는 2차 방어다. 새 반례가 오면 **이 배열에 한 줄 추가**로 끝난다.
 */
export const CAREER_LEADERBOARD_METRIC_WORDS = [
  // ── 타자 누적 (KBO 공식 기록실 HitterBasic/HitterDetail 컬럼) ──
  "타율", "경기", "타석", "타수", "득점", "안타", "1루타", "2루타", "3루타", "이루타", "삼루타",
  "루타", "홈런", "타점", "도루", "도루자", "도루실패", "희생번트", "희생플라이", "희생타",
  "볼넷", "고의사구", "사구", "몸에맞는공", "사사구", "삼진", "병살", "병살타", "장타율",
  "출루율", "ops", "장타", "멀티히트", "만루홈런", "연속경기", "출장", "경기출장",
  "wrc", "war", "득점권",
  // ── 투수 누적 (PitcherBasic/PitcherDetail 컬럼) ──
  "평균자책", "방어율", "다승", "승수", "승리", "패전", "패수", "세이브", "홀드", "승률",
  "이닝", "투구수", "피안타", "피홈런", "피안타율", "탈삼진", "자책점", "실점", "완투", "완봉",
  "선발", "선발등판", "등판", "구원", "세이브포인트", "퀄리티스타트", "블론세이브", "보크",
  "폭투", "whip", "무4사구",
  // ── 수비·주루·기타 ──
  "실책", "수비율", "자살", "보살", "실책수", "도루저지", "포일",
] as const;

/**
 * 통산 리더보드 질문인가 — **미지원 지표까지 포함해** hold 로 닫아야 하는 범위.
 *
 * 판정은 **한 줄**이다: `시점어(통산·역대·커리어·누적·올타임) + 지표 닫힌 집합`.
 * 두 축 모두 닫힌 집합이라 반례가 와도 목록 한 줄로 끝나고, 표현 변이를 쫓지 않는다.
 *
 * ⚠️ 별도 prefilter 를 두지 않는다(삼순 8차 P0). 앞단에 ask regex 를 따로 두었더니
 * 뒤의 계약과 어긋나 `통산 끝내기 상위 10명` 류가 앞단에서 탈락해 generic LLM 으로 샜다.
 * 이 함수 하나가 라우터·게이트·prefilter 전부의 유일한 계약이다.
 *
 * `역대 최고의 타자는 누구야?`·`누적 피로가 많으면 구속이 떨어져?` 처럼 지표 어휘가 없는
 * 질문은 여기서 빠져 LLM 범위 판정으로 내려간다(우리가 조회할 대상 자체가 없는 축).
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
