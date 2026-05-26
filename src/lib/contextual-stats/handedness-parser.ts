/**
 * Parse handedness ("우투우타" / "좌투좌타" / etc.) from KBO HitterDetail or
 * PitcherDetail Basic.aspx HTML.
 *
 * The profile sidebar contains a row like:
 *   <li><strong>포지션: </strong><span ...>외야수(우투우타)</span></li>
 *
 * For pitchers it is "좌투" / "우투" / "언더(언더핸드)" — only throws side
 * matters for the vs-hand split row matching.
 *
 * Why this lives in its own file: players-roster.json does NOT carry
 * handedness, so we *must* extract it from KBO's profile each time we need it.
 * Cached at the route level alongside the Basic.aspx response (1h).
 */

import type { BatSide, ThrowSide } from "./types";

export interface ParsedHandedness {
  bat: BatSide | null;
  throws: ThrowSide | null;
}

const POSITION_LINE_RE =
  /포지션:\s*<\/strong>\s*<span[^>]*>([^<]+)<\/span>/;

export function parseHandedness(html: string): ParsedHandedness {
  const m = html.match(POSITION_LINE_RE);
  if (!m) return { bat: null, throws: null };
  const text = m[1];

  // "외야수(우투우타)" or "투수(좌투)" or "내야수(우투좌타)"
  const parenMatch = text.match(/\(([^)]+)\)/);
  if (!parenMatch) return { bat: null, throws: null };
  const inside = parenMatch[1];

  // throws: first 2 chars before "투" — "우투", "좌투", "언더"
  let throws: ThrowSide | null = null;
  if (/좌투/.test(inside)) throws = "left";
  else if (/우투/.test(inside)) throws = "right";
  // "언더" / "언더핸드" / "사이드" are all *right-side variants* in KBO
  // notation. Map to "right" for vs-hand purposes (Situation Table 4 has
  // 좌타자/우타자/언더투수 rows from a batter's perspective; from a pitcher's
  // *own* page, only 좌타자/우타자 rows exist — see situation-parser.ts).
  else if (/언더|사이드/.test(inside)) throws = "right";

  let bat: BatSide | null = null;
  if (/좌타/.test(inside)) bat = "left";
  else if (/우타/.test(inside)) bat = "right";
  else if (/양타/.test(inside)) bat = "switch";

  return { bat, throws };
}
