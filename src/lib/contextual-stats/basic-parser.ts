/**
 * Extract the v1-relevant fields from KBO HitterDetail/PitcherDetail
 * Basic.aspx HTML responses.
 *
 * For *batters* we want season RISP, PH-BA, HR, RBI (for milestone math).
 * For *pitchers* we want season HR-allowed, SO (for milestone math).
 *
 * Handedness ("우투우타") is parsed by handedness-parser.ts off the same HTML
 * — the route layer typically calls both with one shared `html` string.
 *
 * Spec: §3 source C (KBO Basic.aspx).
 */

import type { BasicSeasonStats } from "./types";

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").trim();
}

function safeInt(s: string | undefined): number {
  if (!s) return 0;
  const n = parseInt(s.replace(/,/g, ""), 10);
  return Number.isNaN(n) ? 0 : n;
}

function extractTableRow(html: string, tableIndex: number, rowIndex = 1): string[] {
  const tableMatches = html.match(/<table[^>]*>[\s\S]*?<\/table>/g) || [];
  const t = tableMatches[tableIndex];
  if (!t) return [];
  const rowMatches = t.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
  const r = rowMatches[rowIndex];
  if (!r) return [];
  const cellMatches = r.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/g) || [];
  return cellMatches.map(c => stripTags(c));
}

/**
 * Hitter Basic Table 0: 팀, AVG, G, PA, AB, R, H, 2B, 3B, HR, TB, RBI, SB, CS, SAC, SF
 * Hitter Basic Table 1: BB, IBB, HBP, SO, GDP, SLG, OBP, E, SB%, MH, OPS, RISP, PH-BA
 */
export function parseHitterBasic(
  html: string,
  kboId: string,
  name: string,
): BasicSeasonStats | null {
  const t0 = extractTableRow(html, 0, 1);
  const t1 = extractTableRow(html, 1, 1);
  if (t0.length === 0 || /기록이 없습니다/.test(t0[0] ?? "")) return null;
  return {
    kboId,
    name,
    hr: safeInt(t0[9]),
    rbi: safeInt(t0[11]),
    phBA: t1[12] || undefined,
  };
}

/**
 * Pitcher Basic Table 0: 팀, ERA, G, CG, SHO, W, L, SV, HLD, WPCT, TBF, NP, IP, H, 2B, 3B, HR
 * Pitcher Basic Table 1: SAC, SF, BB, IBB, SO, WP, BK, R, ER, BSV, WHIP, AVG, QS
 */
export function parsePitcherBasic(
  html: string,
  kboId: string,
  name: string,
): BasicSeasonStats | null {
  const t0 = extractTableRow(html, 0, 1);
  const t1 = extractTableRow(html, 1, 1);
  if (t0.length === 0 || /기록이 없습니다/.test(t0[0] ?? "")) return null;
  return {
    kboId,
    name,
    hr: safeInt(t0[16]),
    so: safeInt(t1[4]),
  };
}
