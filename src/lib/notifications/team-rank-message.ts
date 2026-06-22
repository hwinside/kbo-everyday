/**
 * 팀 순위 변동 알림 문구 빌더 (순수 함수 — DB/외부 의존 없음, 테스트 용이).
 * 순위는 숫자가 작을수록 상위 — newRank < prevRank = 상승. 변동 없으면 null.
 */
export function buildRankChangeMessage(
  teamName: string,
  prevRank: number,
  newRank: number,
): { title: string; body: string } | null {
  if (prevRank === newRank) return null;
  const delta = Math.abs(prevRank - newRank);
  const up = newRank < prevRank;
  const dir = up ? "상승" : "하락";
  return {
    title: `${up ? "🚀" : "〽️"} ${teamName} 순위 ${dir}`,
    body: `${teamName}의 팀 순위가 ${delta}단계 ${dir}하여 ${newRank}위가 되었습니다`,
  };
}
