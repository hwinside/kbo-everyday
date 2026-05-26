/**
 * Parse KBO `HitterDetail/Situation.aspx` and `PitcherDetail/Situation.aspx`
 * HTML responses into the three split tables v1 actually consumes:
 *
 *   Table 0 (bases)  — 주자없음/1루/2루/3루/1,2루/1,3루/2,3루/만루
 *   Table 4 (byHand) — 타자 → 좌투수/우투수/언더투수
 *                      투수 → 좌타자/우타자
 *   Table 5 (byOuts) — 0아웃/1아웃/2아웃
 *
 * The HTML response actually contains six tables (bases / count / inning /
 * order / hand / outs) but v1 only mounts the three above (see spec §4-1).
 * Other tables are *intentionally* ignored — parsing them just to throw them
 * away would invite drift if KBO reorders.
 *
 * Schema differences hitter vs pitcher:
 *   - HitterDetail headers: 구분 | AVG | AB | H | 2B | 3B | HR | RBI | BB | HBP | SO | GDP
 *   - PitcherDetail headers: 구분 | H | 2B | 3B | HR | BB | HBP | SO | WP | BK | AVG
 *
 * For v1 we normalise to a SplitRow { label, AVG, AB, H, HR, BB, SO, RBI? }
 * which is enough for the line renderers. Pitcher rows fill AB := 0 (KBO
 * pitcher Situation table has *no AB column* — only the AVG yielded).
 */

import type { SituationTables, SplitRow } from "./types";

type Role = "batter" | "pitcher";

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").trim();
}

function safeInt(s: string | undefined): number {
  if (!s) return 0;
  const n = parseInt(s.replace(/,/g, ""), 10);
  return Number.isNaN(n) ? 0 : n;
}

function extractTables(html: string): string[][][] {
  // KBO sometimes appends ASP.NET error HTML after the JSON payload, but
  // Situation.aspx returns pure HTML — so we can scan tables directly.
  const tables: string[][][] = [];
  const tableMatches = html.match(/<table[^>]*>[\s\S]*?<\/table>/g) || [];
  for (const t of tableMatches) {
    const rows: string[][] = [];
    const rowMatches = t.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
    for (const r of rowMatches) {
      const cellMatches = r.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/g) || [];
      const cells = cellMatches.map(c => stripTags(c));
      if (cells.length > 0) rows.push(cells);
    }
    tables.push(rows);
  }
  return tables;
}

/**
 * Build a SplitRow from one table row. The label is in cells[0]; the rest map
 * positionally per the per-role header layout.
 *
 * Returns null for header rows ("구분 …") and for the "기록이 없습니다." stub
 * that KBO returns when the player has zero recorded plate appearances in
 * that split.
 */
function rowToSplitRow(role: Role, cells: string[]): SplitRow | null {
  const label = cells[0];
  if (!label || label === "구분") return null;
  if (cells.length === 2 && /기록이 없습니다/.test(cells[1])) return null;

  if (role === "batter") {
    // 구분 | AVG | AB | H | 2B | 3B | HR | RBI | BB | HBP | SO | GDP
    return {
      label,
      AVG: cells[1] ?? "-",
      AB: safeInt(cells[2]),
      H: safeInt(cells[3]),
      HR: safeInt(cells[6]),
      BB: safeInt(cells[8]),
      SO: safeInt(cells[10]),
      RBI: safeInt(cells[7]),
    };
  } else {
    // 구분 | H | 2B | 3B | HR | BB | HBP | SO | WP | BK | AVG
    // No AB column — we surface H as a fallback for sample-size guard.
    return {
      label,
      AVG: cells[10] ?? "-",
      // Sample size proxy for pitchers: H + BB + SO ≈ batters faced. This is
      // an *over*estimate, but errs on the side of allowing display when the
      // threshold is close. Refined in PR4 if needed.
      AB: safeInt(cells[1]) + safeInt(cells[5]) + safeInt(cells[7]),
      H: safeInt(cells[1]),
      HR: safeInt(cells[4]),
      BB: safeInt(cells[5]),
      SO: safeInt(cells[7]),
    };
  }
}

export function parseSituation(html: string, role: Role): SituationTables {
  const tables = extractTables(html);
  // Tables 0/4/5 by position in the page. If KBO reorders we need to update
  // this — but the spec is explicit about ignoring 1/2/3 so positional access
  // is acceptable here (and we cross-check via row labels in route-level
  // gates).
  const t0 = tables[0] ?? [];
  const t4 = tables[4] ?? [];
  const t5 = tables[5] ?? [];

  const toRows = (rows: string[][]): SplitRow[] => {
    const out: SplitRow[] = [];
    for (const r of rows) {
      const sr = rowToSplitRow(role, r);
      if (sr) out.push(sr);
    }
    return out;
  };

  return {
    bases: toRows(t0),
    byHand: toRows(t4),
    byOuts: toRows(t5),
  };
}

/**
 * Detect KBO's ASP.NET error HTML that sometimes ships in place of the real
 * page (e.g. when Referer header is missing post-2026-05-20). Used by the
 * route to fail-closed instead of parsing garbage as zeros.
 */
export function looksLikeAspNetError(html: string): boolean {
  if (!html) return true;
  return (
    /Object moved/.test(html) ||
    /aspxerrorpath/.test(html) ||
    /Server Error in/.test(html)
  );
}
