// iOS 홈 위젯 무음 갱신 — 순수 판정 (1.0.9 build 17). supabase 비의존 → 스모크에서 직접 검증.
import type { KboRawGame } from "@/types/api";

export function safeInt(v: unknown): number {
  const n = parseInt(String(v ?? "0"), 10);
  return Number.isFinite(n) ? n : 0;
}

export function parseTeamCodes(gameId: string): { away: string; home: string } | null {
  const m = gameId.match(/^\d{8}([A-Z]{2})([A-Z]{2})\d$/);
  return m ? { away: m[1], home: m[2] } : null;
}

/**
 * 위젯 스코어축 상태 문자열 — 이게 바뀌면 무음 push 발송(무변화 스킵).
 * 스코어/이닝/초말/아웃/주자 유무를 반영(주자 순번은 무관, 유무만). 매 틱 아닌 변화 시에만
 * iOS 백그라운드 push를 쏘기 위한 dedupe 키.
 */
export function iosWidgetScoreState(g: KboRawGame): string {
  const inning = safeInt(g.GAME_INN_NO);
  return [
    safeInt(g.T_SCORE_CN),
    safeInt(g.B_SCORE_CN),
    inning,
    g.GAME_TB_SC === "T" ? "T" : "B",
    Math.min(Math.max(safeInt(g.OUT_CN), 0), 2),
    safeInt(g.B1_BAT_ORDER_NO) > 0 ? 1 : 0,
    safeInt(g.B2_BAT_ORDER_NO) > 0 ? 1 : 0,
    safeInt(g.B3_BAT_ORDER_NO) > 0 ? 1 : 0,
  ].join("|");
}
