import { rankByStat } from "../../stats/title-rankings";
import { STATS_STALE_MS, SUPPORTED_SEASON } from "./season-record";
import type { ServedBatterSnapshot } from "./served-record";
import { KBO_REGULAR_SEASON_GAMES, LIVE_TEAM_BLOCK_MAX_AGE_MS, kstSeasonOf, type StandingsSnapshot } from "./team-record";

/** An operation is not a statistic: a rank/duration/remainder cannot be answered
 * with the player's value or the team's games played. No generated facts live here. */
export type QuestionOperation = "rank" | "remaining" | "elapsed";
export { readRankRequestContext, type RankRequestContext } from "./rank-request-context";

export function requestedOperation(question: string): QuestionOperation | null {
  const q = question.normalize("NFKC").toLowerCase();
  if (/(?:며칠|몇\s*일|얼마)\s*만|얼마나.*(?:지났|걸렸)/.test(q)) return "elapsed";
  if (/(?:잔여|남은|남아\s*있는)\s*경기|경기.*(?:얼마나|몇).*남|경기.*남았/.test(q)) return "remaining";
  if (/순위|랭킹|몇\s*(?:등|위)|\d+\s*(?:등|위)/u.test(q)) return "rank";
  return null;
}

/** Only a bare operation may borrow its operands. An explicit new subject,
 * metric or condition must not inherit a previous player's ranking. */
export function isBareRankFollowup(question: string): boolean {
  return /^(?:(?:그럼|그러면|그래서|그\s*선수는|그는)\s*)?(?:몇\s*(?:등|위)(?:이야|야|인가요|입니까|인데|인데요)?|순위(?:는|가)?)[?! .~]*$/.test(question.normalize("NFKC").trim());
}

export function unsupportedOperationScope(question: string): boolean {
  const q = question.normalize("NFKC").toLowerCase();
  const years = q.match(/(?:19|20)\d{2}/g) ?? [];
  return years.some((year) => Number(year) !== SUPPORTED_SEASON)
    || /통산|역대|지난|작년|내년|최근|오늘|어제|이번\s*(?:주|달)|월간|주간|후반기|전반기|포스트\s*시즌|시범|상대|맞대결|\S+전(?:에서|의|\s)|가을|플레이오프|한국\s*시리즈/.test(q);
}

export const RANK_SCOPE_ANSWER = "요청하신 조건의 순위를 확인할 자료가 부족합니다. 현재 시즌 누적 타율의 선수 순위는 확인할 수 있습니다. 구단별 선수 순위는 구단명이 필요합니다.";
export const OPERATION_DATA_ANSWER = "요청하신 계산에 필요한 최신 자료를 확인하지 못해 수치를 안내하기 어렵습니다.";
export const ELAPSED_DATA_ANSWER = "며칠 만의 기록인지는 직전 기록과 이번 기록의 경기 날짜가 모두 필요합니다. 해당 날짜 자료를 확인하지 못해 경과일을 단정할 수 없습니다.";

function dateOf(value: string): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
}

export interface RankTarget { player?: { id: string; name: string }; team?: { id: number; name: string } }

/** Use the same qualification, sorting and competition ranks as the app.
 * Unlike the UI's legacy fallback, missing qualification metadata is not proof
 * that a player is eligible. Reject the snapshot instead of inventing a rank. */
export function renderAverageRank(
  snapshot: ServedBatterSnapshot, target: RankTarget, now: number,
  teamIdOf: (name: string) => number | null,
): string | null {
  const at = Date.parse(snapshot.updatedAt);
  if (!Number.isFinite(at) || at > now || now - at > STATS_STALE_MS
    || kstSeasonOf(now) !== SUPPORTED_SEASON || kstSeasonOf(at) !== SUPPORTED_SEASON || snapshot.rows.length === 0) return null;
  const ids = new Set<string>();
  for (const row of snapshot.rows) {
    if (!/^\d{1,8}$/.test(row.kbo_id) || ids.has(row.kbo_id)
      || !row.name || /[\r\n<>]/.test(row.name)
      || ![0, 1, "0", "1"].includes(row.qualifiedRate as number)
      || row.avg === null || row.avg === undefined || row.avg === "" || !Number.isFinite(Number(row.avg))
      || Number(row.avg) < 0 || Number(row.avg) > 1) return null;
    ids.add(row.kbo_id);
  }
  // A club ranking re-ranks that club's qualified players, not league ranks
  // filtered afterwards. An explicit league request supplies no team filter.
  if (target.team && snapshot.rows.some((row) => !row.team || teamIdOf(row.team) === null)) return null;
  const rows = target.team ? snapshot.rows.filter((row) => teamIdOf(row.team ?? "") === target.team!.id) : snapshot.rows;
  if (rows.length === 0) return null;
  const ranked = rankByStat(rows, "avg");
  const scope = target.team ? `${target.team.name} 선수 중` : "KBO 전체 타자 중";
  const stamp = `${SUPPORTED_SEASON}시즌 ${dateOf(snapshot.updatedAt)} 수집 기록 기준`;
  if (target.player) {
    const player = rows.find((row) => row.kbo_id === target.player!.id);
    if (!player || player.name !== target.player.name) return null;
    const result = ranked.find((row) => row.kbo_id === target.player!.id);
    if (!result) return `${stamp}, ${target.player.name} 선수는 규정타석 미달로 타율 순위에 포함되지 않습니다.`;
    return `${stamp}, ${target.player.name} 선수는 ${scope} 규정타석을 채운 선수의 타율 ${result.rank}위입니다(타율 ${Number(result.avg).toFixed(3)}). 같은 타율은 공동 순위입니다.`;
  }
  if (!ranked.length) return `${stamp}, ${scope} 규정타석을 채운 타자가 없어 타율 순위를 안내할 수 없습니다.`;
  const top = ranked.slice(0, 5).map((row) => `${row.rank}위 ${row.name} ${Number(row.avg).toFixed(3)}`).join(", ");
  return `${stamp}, ${scope} 규정타석 충족자의 타율 순위 상위 ${Math.min(5, ranked.length)}명은 ${top}입니다. 같은 타율은 공동 순위입니다. 전체 목록은 선수 기록실에서 확인할 수 있습니다.`;
}

export function renderRemainingGames(snapshot: StandingsSnapshot, team: { id: number; name: string }, now: number): string | null {
  const at = Date.parse(snapshot.fetchedAt ?? "");
  if (snapshot.season !== SUPPORTED_SEASON || kstSeasonOf(now) !== SUPPORTED_SEASON
    || !Number.isFinite(at) || at > now || now - at > LIVE_TEAM_BLOCK_MAX_AGE_MS) return null;
  const rows = snapshot.rows.filter((row) => row.teamId === team.id);
  if (rows.length !== 1) return null;
  const row = rows[0];
  if (![row.games, row.wins, row.losses, row.draws].every((value) => Number.isInteger(value) && value >= 0)
    || row.games !== row.wins + row.losses + row.draws || row.games > KBO_REGULAR_SEASON_GAMES) return null;
  return `${SUPPORTED_SEASON}시즌 ${dateOf(snapshot.fetchedAt!)} 수집 기록 기준, ${team.name}의 정규시즌 잔여 경기는 ${KBO_REGULAR_SEASON_GAMES - row.games}경기입니다. 팀당 ${KBO_REGULAR_SEASON_GAMES}경기에서 치른 ${row.games}경기를 뺀 수치입니다.`;
}
