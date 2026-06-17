import { STAT_DEFS } from "./title-defs";

/**
 * 선수 부문 랭킹 SSOT — 랭킹 페이지(rankings/[stat])와 홈 최애선수 카드 타이틀 라벨이
 * **완벽히 동일한 데이터**를 보이도록, 자격/정렬/공동순위 계산을 단일 함수로 공유한다.
 * 두 화면 모두 이 `rankByStat`을 호출하므로 로직 드리프트가 원천 차단된다.
 */

export type StatRow = Record<string, unknown>;
export type RankedRow = StatRow & { rank: number };

export interface PlayerTitle {
  statKey: string;
  name: string; // 카드 표기용 부문명 ("홈런", "타율", "ERA"...)
  rank: number;
}

// 비율 스탯은 규정 미달 제외 (랭킹 페이지와 동일 기준)
const RATE_STATS = ["avg", "era", "obp", "ops", "whip"];

// 카드에 한 개만 노출할 때의 우선순위(같은 순위면 대표 타이틀 먼저)
const TITLE_PRIORITY: string[] = [
  "hr", "avg", "era", "rbi", "saves", "so_pitcher", "wins", "ops",
  "obp", "sb", "holds", "runs", "bb", "ip", "whip", "doubles", "hbp",
  "so_batter", "games_batter", "games_pitcher",
];

function parseIP(ip: string | number): number {
  if (typeof ip === "number") return ip;
  const s = String(ip).trim();
  const match = s.match(/^(\d+)(?:\s+(\d+)\/(\d+))?$/);
  if (!match) return 0;
  const whole = parseInt(match[1]) || 0;
  const frac = match[2] && match[3] ? parseInt(match[2]) / parseInt(match[3]) : 0;
  return whole + frac;
}

/**
 * 한 부문(statKey) 기준 자격 필터 → 정렬 → 공동순위 적용한 전체 랭킹 배열.
 * 랭킹 페이지 useEffect의 filtered/sorted/withRank 로직을 그대로 옮긴 것 — 동작 동일.
 */
export function rankByStat(rows: StatRow[], statKey: string): RankedRow[] {
  const def = STAT_DEFS[statKey];
  if (!def || !Array.isArray(rows)) return [];

  const isRateStat = RATE_STATS.includes(statKey);
  const filtered = isRateStat
    ? def.type === "batter"
      ? rows.filter((p) => (Number(p["pa"]) || 0) >= 30) // 타자: 최소 30타석
      : rows.filter((p) => parseIP((p["ip"] as string | number) || 0) >= 12) // 투수: 최소 12이닝
    : def.type === "batter"
      ? rows.filter((p) => (Number(p["games"]) || 0) >= 10)
      : rows.filter((p) => (Number(p["games"]) || 0) >= 5);

  const valueOf = (p: StatRow): number => {
    if (statKey === "doubles") {
      return (Number(p["doubles"]) || 0) + (Number(p["triples"]) || 0);
    }
    return Number(p[def.key] ?? 0) || 0;
  };

  const sorted = [...filtered].sort((a, b) =>
    def.higherIsBetter ? valueOf(b) - valueOf(a) : valueOf(a) - valueOf(b)
  );

  // 공동 순위 (competition ranking: 같은 값이면 같은 rank, 다음 순위는 건너뛰기)
  return sorted.map((p, i) => {
    let rank = 1;
    if (i > 0) {
      if (valueOf(p) === valueOf(sorted[i - 1])) {
        rank = (sorted[i - 1] as { rank?: number }).rank || i;
      } else {
        rank = i + 1;
      }
    }
    return { ...p, rank };
  });
}

// "홈런 랭킹" / "삼진 랭킹 (타자)" → "홈런" / "삼진"
function titleName(desc: string): string {
  return desc.replace(/\s*랭킹.*$/, "").replace(/\s*\(.*\)\s*$/, "").trim();
}

function matchPlayer(row: StatRow, playerId: string, playerName: string): boolean {
  const id = String(row.kboId ?? row.playerId ?? "");
  if (id && id === String(playerId)) return true;
  return !!playerName && row.name === playerName;
}

/**
 * 선수가 top-N(기본 5위) 이내인 모든 부문을 순위 오름차순으로 반환.
 * 각 부문은 rankByStat(리더보드와 동일)로 계산 → 라벨 순위 = 리더보드 순위.
 */
export function getPlayerTitles(
  rows: StatRow[],
  playerId: string,
  playerName: string,
  isPitcher: boolean,
  topN = 5
): PlayerTitle[] {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const type = isPitcher ? "pitcher" : "batter";
  const out: PlayerTitle[] = [];

  for (const [statKey, def] of Object.entries(STAT_DEFS)) {
    if (def.type !== type) continue;
    const ranked = rankByStat(rows, statKey);
    const me = ranked.find((p) => matchPlayer(p, playerId, playerName));
    if (me && me.rank <= topN) {
      out.push({ statKey, name: titleName(def.desc), rank: me.rank });
    }
  }

  out.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return TITLE_PRIORITY.indexOf(a.statKey) - TITLE_PRIORITY.indexOf(b.statKey);
  });
  return out;
}
