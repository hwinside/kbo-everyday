/** Official decision pitchers only; never infer a winner from the last live pitcher. */
export function widgetResultPitchers(game: {
  status: string;
  awayScore: number | null;
  homeScore: number | null;
  winPitcher?: string | null;
  losePitcher?: string | null;
  savePitcher?: string | null;
}): string {
  if (game.status !== "final" || game.awayScore == null || game.homeScore == null
      || game.awayScore === game.homeScore) return "";
  return ([["승", game.winPitcher], ["패", game.losePitcher], ["세", game.savePitcher]] as const)
    .flatMap(([label, raw]) => {
      const name = raw?.trim();
      return name && name !== "-" && name !== "미정" ? [`${label} ${name}`] : [];
    }).join(" / ");
}
