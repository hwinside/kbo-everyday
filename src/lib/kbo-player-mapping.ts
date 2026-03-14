/**
 * KBO API player name mapping helper
 *
 * T_P_NM = away(Top) team's current player
 * B_P_NM = home(Bottom) team's current player
 *
 * The ROLE (batter vs pitcher) depends on which half of the inning:
 *   - 초 (top, GAME_TB_SC="T"): away=batting  → T_P_NM=batter, B_P_NM=pitcher
 *   - 말 (bottom, GAME_TB_SC="B"): home=batting → B_P_NM=batter, T_P_NM=pitcher
 */

interface KboPlayerNames {
  /** T_P_NM from KBO API (away team player) */
  tPlayerName: string | null | undefined;
  /** B_P_NM from KBO API (home team player) */
  bPlayerName: string | null | undefined;
  /** GAME_TB_SC from KBO API ("T" = top, "B" = bottom) */
  gameTbSc: string;
}

interface ResolvedPlayers {
  currentBatter: string | null;
  currentPitcher: string | null;
}

export function resolveCurrentPlayers({
  tPlayerName,
  bPlayerName,
  gameTbSc,
}: KboPlayerNames): ResolvedPlayers {
  const isTop = gameTbSc === "T";
  return {
    currentBatter: (isTop ? tPlayerName : bPlayerName)?.trim() || null,
    currentPitcher: (isTop ? bPlayerName : tPlayerName)?.trim() || null,
  };
}
