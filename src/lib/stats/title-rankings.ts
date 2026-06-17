import { STAT_DEFS } from "./title-defs";

/**
 * 선수 타이틀(부문 랭킹) 계산 — 랭킹 페이지(rankings/[stat])와 동일한
 * 자격(규정타석/이닝·최소경기) + 정렬 + 공동순위 로직을 재현해 홈 카드 라벨이
 * 랭킹 페이지와 일치하도록 한다.
 *
 * 입력 rows = /api/stats?type=batter|pitcher 응답 배열(해당 선수 type만).
 */

export interface PlayerTitle {
  statKey: string;
  name: string; // 카드 표기용 부문명 ("홈런", "타율", "ERA"...)
  rank: number;
}

type StatRow = Record<string, unknown>;

// 비율 스탯은 규정 미달 제외 (랭킹 페이지와 동일 기준)
const RATE_STATS = new Set(["avg", "era", "obp", "ops", "whip"]);

// "홈런 랭킹" / "삼진 랭킹 (타자)" → "홈런" / "삼진"
function titleName(desc: string): string {
  return desc.replace(/\s*랭킹.*$/, "").replace(/\s*\(.*\)\s*$/, "").trim();
}

// 카드에 한 개만 노출할 때의 우선순위(같은 순위면 대표 타이틀 먼저)
const TITLE_PRIORITY: string[] = [
  "hr", "avg", "era", "rbi", "saves", "so_pitcher", "wins", "ops",
  "obp", "sb", "holds", "runs", "bb", "ip", "whip", "doubles", "hbp",
  "so_batter", "games_batter", "games_pitcher",
];

function parseIP(ip: unknown): number {
  if (typeof ip === "number") return ip;
  const s = String(ip ?? "").trim();
  const match = s.match(/^(\d+)(?:\s+(\d+)\/(\d+))?$/);
  if (!match) return 0;
  const whole = parseInt(match[1]) || 0;
  const frac = match[2] && match[3] ? parseInt(match[2]) / parseInt(match[3]) : 0;
  return whole + frac;
}

function matchPlayer(row: StatRow, playerId: string, playerName: string): boolean {
  const id = String(row.kboId ?? row.playerId ?? "");
  if (id && id === String(playerId)) return true;
  return !!playerName && row.name === playerName;
}

function statValue(row: StatRow, statKey: string, key: string): number {
  if (statKey === "doubles") {
    return (Number(row.doubles) || 0) + (Number(row.triples) || 0);
  }
  return Number(row[key]) || 0;
}

/**
 * 선수가 top-N(기본 5위) 이내인 모든 부문을 순위 오름차순으로 반환.
 * 없으면 빈 배열.
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

    // 자격 필터 (랭킹 페이지와 동일)
    const filtered = RATE_STATS.has(statKey)
      ? type === "batter"
        ? rows.filter((p) => (Number(p.pa) || 0) >= 30)
        : rows.filter((p) => parseIP(p.ip) >= 12)
      : type === "batter"
        ? rows.filter((p) => (Number(p.games) || 0) >= 10)
        : rows.filter((p) => (Number(p.games) || 0) >= 5);

    const sorted = [...filtered].sort((a, b) => {
      const av = statValue(a, statKey, def.key);
      const bv = statValue(b, statKey, def.key);
      return def.higherIsBetter ? bv - av : av - bv;
    });

    const idx = sorted.findIndex((p) => matchPlayer(p, playerId, playerName));
    if (idx < 0) continue;

    // 공동 순위 (같은 값이면 같은 rank) — idx 위로 동일 값 시작점이 rank
    const pv = statValue(sorted[idx], statKey, def.key);
    let firstSame = idx;
    while (firstSame > 0 && statValue(sorted[firstSame - 1], statKey, def.key) === pv) {
      firstSame--;
    }
    const rank = firstSame + 1;
    if (rank <= topN) {
      out.push({ statKey, name: titleName(def.desc), rank });
    }
  }

  out.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return TITLE_PRIORITY.indexOf(a.statKey) - TITLE_PRIORITY.indexOf(b.statKey);
  });
  return out;
}
