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
  | "canonical-not-settled";

export interface CanonicalGameState {
  status: "scheduled" | "live" | "final" | "cancelled";
  awayScore: number | null;
  homeScore: number | null;
}

export interface SummaryFingerprint {
  status: "final";
  awayScore: number;
  homeScore: number;
  awayInnings: (number | null)[];
  homeInnings: (number | null)[];
}

function normalizedInnings(values: (number | null)[]): (number | null)[] {
  const normalized = [...values];
  while (normalized.at(-1) === null) normalized.pop();
  return normalized;
}

export function createSummaryFingerprint(
  awayScore: number,
  homeScore: number,
  awayInnings: (number | null)[],
  homeInnings: (number | null)[],
): SummaryFingerprint {
  return {
    status: "final",
    awayScore,
    homeScore,
    awayInnings: normalizedInnings(awayInnings),
    homeInnings: normalizedInnings(homeInnings),
  };
}

/**
 * 서버 독립 canonical 게이트 (blocker①). 경기목록과 스코어보드가 같은 종료 결과로
 * 수렴한 경우에만 fingerprint를 만든다.
 * fail-close: canonical 미확보·미확정(final 아님)·두 원천 불일치면 생성/캐시를 거부.
 * 이닝 수(9회 등) 하드코딩 금지 — status 필드로만 종료를 판정(콜드/더블헤더/홈리드 9말생략/연장 대응).
 */
export function canonicalGate(
  canonical: CanonicalGameState | undefined,
  linescore: {
    status: "scheduled" | "live" | "final" | "cancelled";
    away: { R: number; innings: (number | null)[] };
    home: { R: number; innings: (number | null)[] };
  } | null | undefined,
): { reason: CanonicalGateReason; httpStatus: number; fingerprint?: SummaryFingerprint } {
  if (!canonical) return { reason: "canonical-unavailable", httpStatus: 503 };
  if (canonical.status !== "final") return { reason: "not-final", httpStatus: 409 };
  if (
    canonical.awayScore == null ||
    canonical.homeScore == null ||
    !linescore ||
    linescore.status !== "final" ||
    canonical.awayScore !== linescore.away.R ||
    canonical.homeScore !== linescore.home.R
  ) {
    return { reason: "canonical-not-settled", httpStatus: 409 };
  }
  return {
    reason: "ok",
    httpStatus: 200,
    fingerprint: createSummaryFingerprint(
      canonical.awayScore,
      canonical.homeScore,
      linescore.away.innings,
      linescore.home.innings,
    ),
  };
}

export function fingerprintsEqual(
  left: SummaryFingerprint | null | undefined,
  right: SummaryFingerprint | null | undefined,
): boolean {
  if (!left || !right) return false;
  return (
    left.status === right.status &&
    left.awayScore === right.awayScore &&
    left.homeScore === right.homeScore &&
    left.awayInnings.length === right.awayInnings.length &&
    left.homeInnings.length === right.homeInnings.length &&
    left.awayInnings.every((value, index) => value === right.awayInnings[index]) &&
    left.homeInnings.every((value, index) => value === right.homeInnings[index])
  );
}

/** fingerprint 부재(legacy) 또는 final status+score+innings 불일치면 stale. */
export function isFingerprintStale(
  cached: SummaryFingerprint | null | undefined,
  current: SummaryFingerprint | null | undefined,
): boolean {
  return !fingerprintsEqual(cached, current);
}

/**
 * FinalView에서는 검증 가능한 current fingerprint가 없거나 캐시가 legacy/stale면 숨긴다.
 * 서버 POST가 canonical을 재조회해 current cache 또는 새 요약만 돌려준다.
 */
export function shouldHideStaleCache(
  cached: SummaryFingerprint | null | undefined,
  current: SummaryFingerprint | null | undefined,
): boolean {
  return isFingerprintStale(cached, current);
}

/** 생성 시작 fingerprint와 save 직전 canonical이 같을 때만 저장(old-last overwrite 차단). */
export function shouldSaveGeneratedSummary(
  generationFingerprint: SummaryFingerprint,
  latestFingerprint: SummaryFingerprint | null | undefined,
): boolean {
  return fingerprintsEqual(generationFingerprint, latestFingerprint);
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
    if (llmWinner !== actualWinner) return true; // 부재/빈값/"무승부" 포함 exact 불일치
    if (DRAW_CLAIM_RE.test(head)) return true; // non-draw 인데 무승부/동점 마무리 서술
    return false;
  }
  // 실제 무승부
  return llmWinner !== "무승부";
}
