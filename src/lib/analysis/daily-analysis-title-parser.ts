export interface TitleEntry {
  category: string;
  rank: number;
  player_name: string;
  team: string;
  value: number;
}

export function parseTable(html: string): string[][] {
  const rows: string[][] = [];
  const tbodyMatch = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
  if (!tbodyMatch) return rows;
  const trMatches = tbodyMatch[1].match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
  if (!trMatches) return rows;
  for (const tr of trMatches) {
    const cells: string[] = [];
    const tdMatches = tr.match(/<td[^>]*>([\s\S]*?)<\/td>/gi);
    if (tdMatches) {
      for (const td of tdMatches) {
        cells.push(td.replace(/<[^>]+>/g, "").trim());
      }
    }
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

// Assign competition (tie-aware) ranks: equal values share the same rank,
// next distinct value jumps to (index+1). e.g. 5,5,5,4 -> 1,1,1,4.
export function assignTieAwareRanks<T extends { value: number; rank: number }>(
  entries: T[],
  lowerIsBetter = false,
): T[] {
  const sorted = [...entries].sort((a, b) =>
    lowerIsBetter ? a.value - b.value : b.value - a.value,
  );
  let prevValue: number | null = null;
  let prevRank = 0;
  sorted.forEach((entry, index) => {
    if (prevValue !== null && entry.value === prevValue) {
      entry.rank = prevRank;
    } else {
      entry.rank = index + 1;
      prevRank = index + 1;
      prevValue = entry.value;
    }
  });
  return sorted;
}

export function parseTitleEntries(params: {
  html: string;
  category: string;
  valueColumn: number;
  lowerIsBetter?: boolean;
  limit?: number;
}): TitleEntry[] {
  const entries = parseTable(params.html).map((cells) => ({
    category: params.category,
    rank: 0,
    player_name: cells[1] || "",
    team: cells[2] || "",
    value: Number.parseFloat(cells[params.valueColumn] || "0") || 0,
  }));

  // KBO의 sort 쿼리를 신뢰해 먼저 자르면 WHIP처럼 서버 응답 정렬이 반대인 경우
  // 실제 선두군이 누락된다. 전체 후보를 지표 방향대로 정렬한 뒤 상위 N명을 고른다.
  return assignTieAwareRanks(entries, params.lowerIsBetter).slice(0, params.limit ?? 10);
}
