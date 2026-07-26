// AI 경기 요약 캐시/생성 게이트 순수 판정 헬퍼 (삼순 #888 blocker①②③).
//
// 2026-07-26 사고: LG-한화가 라이브 8회 4-4 스냅샷으로 recap 생성·캐시됐고, 최종 14-4로
// 갱신됐는데도 캐시가 not-outdated(prompt_version 동일)라 ~48분간 "4-4 무승부" 오답 노출.
// 근본: ①final 전이 직후 stale 박스스코어로 생성 ②스코어 변동 시 캐시 무효화 트리거 부재
// ③무인증 POST 가 client body 스코어를 그대로 신뢰(cache poisoning) ④winner 가드가
// non-draw 에 llmWinner="무승부" 오답을 통과.

export type CanonicalGateReason =
  | "ok"
  | "invalid-gameid"
  | "canonical-unavailable"
  | "not-final"
  | "score-mismatch";

export interface CanonicalGameState {
  status: "scheduled" | "live" | "final" | "cancelled";
  awayScore: number | null;
  homeScore: number | null;
}

/**
 * 서버 독립 canonical 게이트 (blocker①). KBO canonical 경기상태로 client body 를 검증한다.
 * fail-close: canonical 미확보·미확정(final 아님)·body 스코어 불일치면 생성/캐시를 거부.
 * 이닝 수(9회 등) 하드코딩 금지 — status 필드로만 종료를 판정(콜드/더블헤더/홈리드 9말생략/연장 대응).
 */
export function canonicalGate(
  canonical: CanonicalGameState | undefined,
  bodyAwayScore: number,
  bodyHomeScore: number,
): { reason: CanonicalGateReason; httpStatus: number } {
  if (!canonical) return { reason: "canonical-unavailable", httpStatus: 503 };
  if (canonical.status !== "final") return { reason: "not-final", httpStatus: 409 };
  if (
    canonical.awayScore == null ||
    canonical.homeScore == null ||
    canonical.awayScore !== bodyAwayScore ||
    canonical.homeScore !== bodyHomeScore
  ) {
    return { reason: "score-mismatch", httpStatus: 422 };
  }
  return { reason: "ok", httpStatus: 200 };
}

/**
 * 캐시 fingerprint 가 현재 final 스코어와 다르거나 부재(legacy)면 stale (blocker②).
 * stale 이면 서버는 캐시 반환 대신 재생성, 클라이언트는 노출 대신 숨김+재생성해야 한다.
 */
export function isFingerprintStale(
  cachedAwayScore: number | null | undefined,
  cachedHomeScore: number | null | undefined,
  finalAwayScore: number,
  finalHomeScore: number,
): boolean {
  if (cachedAwayScore == null || cachedHomeScore == null) return true; // legacy fingerprint 없음
  return cachedAwayScore !== finalAwayScore || cachedHomeScore !== finalHomeScore;
}

/**
 * 클라이언트: final 스코어를 알 때(finalScoreKnown) fingerprint 불일치/부재면 캐시를 숨긴다 (blocker②).
 * 비-final 맥락(스코어 미확정)에서는 기존 캐시를 노출한다(진행 중 화면 등).
 */
export function shouldHideStaleCache(
  finalScoreKnown: boolean,
  cachedAwayScore: number | null | undefined,
  cachedHomeScore: number | null | undefined,
  finalAwayScore: number | null | undefined,
  finalHomeScore: number | null | undefined,
): boolean {
  if (!finalScoreKnown || finalAwayScore == null || finalHomeScore == null) return false;
  return isFingerprintStale(cachedAwayScore, cachedHomeScore, finalAwayScore, finalHomeScore);
}

const DRAW_CLAIM_RE = /무승부|비겼|비긴|동점으로\s*(?:마무리|끝|경기를 마)/;

/**
 * winner 필드/헤드라인이 실제 결과와 어긋나면 true (blocker③).
 * - non-draw: winner 필드는 actualWinner 와 exact 일치여야 한다(llmWinner="무승부" 오답 포함 reject).
 *             헤드라인이 무승부/동점으로 끝났다고 서술해도 reject(loserClaimedWin 이 못 잡는 loophole).
 * - draw: winner 필드가 특정 팀 승리로 들어오면 reject(역방향).
 * headline 의 패팀=승자 서술(loserClaimedWin)은 호출부에서 별도 검사(이 함수는 winner 필드+무승부 문구 담당).
 */
export function winnerFieldMismatch(
  finalAwayScore: number,
  finalHomeScore: number,
  awayTeam: string,
  homeTeam: string,
  llmWinner: string | undefined | null,
  headline: string | undefined | null,
): boolean {
  const head = headline ?? "";
  if (finalAwayScore !== finalHomeScore) {
    const actualWinner = finalAwayScore > finalHomeScore ? awayTeam : homeTeam;
    if (llmWinner && llmWinner !== actualWinner) return true; // "무승부" 포함 exact 불일치
    if (DRAW_CLAIM_RE.test(head)) return true; // non-draw 인데 무승부/동점 마무리 서술
    return false;
  }
  // 실제 무승부
  if (llmWinner && llmWinner !== "무승부") return true;
  return false;
}
