/**
 * 시즌 순위 변동 그래프 자가복구.
 *
 * daily_standings_snapshot은 매일 01:00 KST 크론(daily-analysis scheduled)이 그날 날짜로
 * 팀별 순위를 저장한다. Vercel 크론은 best-effort라 하루 실행을 조용히 스킵할 수 있고
 * (2026-06-19·2026-07-20 실사례), 그러면 그래프가 마지막 스냅샷 날짜에 멈춰 실제 순위
 * 하락을 못 보여준다.
 *
 * 이 헬퍼는 최신 스냅샷이 오늘(KST)보다 과거면 라이브 순위로 '오늘' 포인트 1개를 덧붙여
 * 크론 스킵에도 그래프가 현재 순위를 반영하게 한다.
 *
 * 규약/안전장치:
 *   - 저장된 스냅샷은 절대 변경하지 않는다(읽기 전용 append).
 *   - 오늘 날짜 스냅샷이 이미 있으면(정상 크론) 그대로 반환 → 무동작.
 *   - liveRank가 없거나 히스토리가 비면 anchor 불가 → 그대로 반환.
 *   - 스냅샷 date=오늘 관례는 "오늘 경기 전(=어제까지) 누적"이나, 크론 스킵일에는
 *     현재 순위를 보여주는 편이 유저에게 더 정확하다(스킵일에만 발동하는 트레이드오프).
 */
export function appendLiveRankIfStale(
  rankHistory: { date: string; rank: number }[],
  todayIso: string,
  liveRank: number | null | undefined,
): { date: string; rank: number }[] {
  if (liveRank == null || rankHistory.length === 0) return rankHistory;
  const last = rankHistory[rankHistory.length - 1];
  // 최신 스냅샷 날짜가 오늘 이상이면(정상 크론 or 미래 데이터) 손대지 않는다.
  if (last.date >= todayIso) return rankHistory;
  return [...rankHistory, { date: todayIso, rank: liveRank }];
}
