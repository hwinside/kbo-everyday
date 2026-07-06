// 문자중계 최근 플레이 한 줄 추출 — /api/game-relay 응답에서 마지막 non-empty 이닝의 마지막 play.
// iOS 잠금 LA와 안드 홈위젯이 *동일 문구*를 쓰도록 공유한다(단일 소스). 이닝(N회초/말)은 카드
// 상단 LIVE 표기와 중복이라 제외 → "타자 + 결과"만. 예: "오스틴 우중간 적시 2루타".
// innings/plays는 시간순 오름차순 → 마지막 non-empty 이닝의 마지막 play = 최신. 실패 시 null.
type RelayLite = {
  innings?: { inning: number; half: string; plays?: { batterName: string; result: string }[] }[];
};

export function latestRelayLine(relay: unknown): string | null {
  const innings = (relay as RelayLite)?.innings;
  if (!Array.isArray(innings)) return null;
  let lastPlay: { batterName: string; result: string } | null = null;
  for (const inn of innings) {
    if (inn?.plays && inn.plays.length > 0) lastPlay = inn.plays[inn.plays.length - 1];
  }
  if (!lastPlay || !lastPlay.batterName || !lastPlay.result) return null;
  const line = `${lastPlay.batterName} ${lastPlay.result}`;
  return line.length > 40 ? line.slice(0, 39) + "…" : line;
}
