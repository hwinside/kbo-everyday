import playersRoster from "@/lib/constants/players-roster.json";
import { canonicalKboId, LEGACY_RETIRED_IDS } from "@/lib/utils/resolve-player";

/**
 * 최애선수 payload 검증 순수 모듈 (2026-08-24, PR #1297 삼순 3차 NO-GO 반영).
 *
 * PUT /api/me/favorite-players 가 이 함수를 그대로 import(production seam)하고,
 * `npm run qa:favorites-save` 회귀도 같은 함수를 직접 태운다 — 라우트와 테스트가
 * 다른 구현을 보는 seam 불일치를 구조적으로 차단.
 *
 * ID-only 엄격 계약 (삼순: resolvePlayer의 이름/접미사 fallback 차단):
 * - playerId는 **ID 매핑으로만** 해석한다: ①로스터 kboId 정확 일치
 *   ②외국인 숫자 ID → canonical 영문 ID(canonicalKboId) ③레거시 은퇴/통합
 *   ID(LEGACY_RETIRED_IDS) 교정. 이름 문자열(`"손호영"`)은 어떤 경로로도
 *   해석되지 않고 fail-close.
 * - name/teamId/position/number는 제출값을 버리고 로스터 canonical로 교체.
 * - 선택 순서 유지, canonical ID 기준 중복 제거, 최대 5명(초과는 전체 거절).
 */

export const MAX_FAVORITES = 5;

export interface FavoritePayload {
  playerId: string;
  name: string;
  teamId: number;
  position: string;
  number: number;
}

interface RosterEntry {
  name: string;
  kboId: string;
  teamId: number;
  position: string;
  backNo: string;
}

const ROSTER_BY_ID: Map<string, RosterEntry> = new Map(
  (playersRoster as RosterEntry[]).map((p) => [p.kboId, p])
);

/** ID 전용 엄격 해석 — 이름 fallback 없음. 미해석은 null(fail-close). */
export function resolveFavoriteById(rawId: string): RosterEntry | null {
  const id = rawId.trim();
  if (!id) return null;
  // ① 로스터 kboId 정확 일치
  const exact = ROSTER_BY_ID.get(id);
  if (exact) return exact;
  // ② 외국인 숫자 ID → canonical 영문 ID
  const alpha = canonicalKboId(id);
  if (alpha !== id) {
    const byAlpha = ROSTER_BY_ID.get(alpha);
    if (byAlpha) return byAlpha;
  }
  // ③ 레거시 은퇴/통합 ID → 현행 ID
  const legacy = LEGACY_RETIRED_IDS[id];
  if (legacy) {
    const byLegacy = ROSTER_BY_ID.get(legacy);
    if (byLegacy) return byLegacy;
  }
  return null;
}

/**
 * 배열이 아니거나, 항목에 playerId(string)가 없거나, ID가 로스터로 해석되지
 * 않거나, (중복 제거 후) 5명 초과면 null — 호출측은 400.
 */
export function parseFavorites(raw: unknown): FavoritePayload[] | null {
  if (!Array.isArray(raw)) return null;
  const out: FavoritePayload[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) return null;
    const r = entry as Record<string, unknown>;
    if (typeof r.playerId !== "string" || !r.playerId.trim()) return null;
    const resolved = resolveFavoriteById(r.playerId);
    if (!resolved) return null; // 로스터에 없는/이름형 ID — fail-close
    if (seen.has(resolved.kboId)) continue; // 같은 선수 중복 → 1명으로(canonical 기준)
    seen.add(resolved.kboId);
    const backNo = Number(resolved.backNo);
    out.push({
      playerId: resolved.kboId,
      name: resolved.name,
      teamId: resolved.teamId,
      position: resolved.position,
      number: Number.isFinite(backNo) ? backNo : 0,
    });
  }
  if (out.length > MAX_FAVORITES) return null;
  return out;
}
