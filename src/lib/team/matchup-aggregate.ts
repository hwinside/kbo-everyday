/**
 * 팀 상대전적 집계 순수 함수 (2026-07-21, #cs 제보 "롯데 47승49패" fix로 추출)
 *
 * ⚠️ 정규시즌만 집계(srId === 0): KBO GetKboGameList가 요청 srId 필터를 무시하고
 * 날짜의 전 경기(시범 SR1 포함)를 반환하므로, 응답의 경기별 srId로 후처리 필터 필수.
 * 시범경기가 섞이면 순위표 승패와 어긋남(실측: 롯데 47-49-4 표시 vs 실제 39-47-2).
 */
import type { KboGame } from "@/lib/crawler/kbo-api";

export interface OpponentRecord {
  wins: number;
  losses: number;
  draws: number;
}

export interface MatchupAggregate {
  byOpponent: Map<number, OpponentRecord>;
  total: OpponentRecord;
}

/** 정규시즌(srId 0) + final + 해당 팀 경기만 승/패/무 집계 */
export function aggregateMatchups(games: KboGame[], teamId: number): MatchupAggregate {
  const byOpponent = new Map<number, OpponentRecord>();
  const total: OpponentRecord = { wins: 0, losses: 0, draws: 0 };

  for (const g of games) {
    if (g.srId !== 0) continue; // 시범/포스트시즌 제외 — 정규시즌 상대전적만
    if (g.status !== "final") continue;
    if (g.awayTeamId !== teamId && g.homeTeamId !== teamId) continue;

    const isHome = g.homeTeamId === teamId;
    const oppId = isHome ? g.awayTeamId : g.homeTeamId;
    const myScore = isHome ? g.homeScore : g.awayScore;
    const oppScore = isHome ? g.awayScore : g.homeScore;
    if (myScore === null || oppScore === null) continue;

    const rec = byOpponent.get(oppId) ?? { wins: 0, losses: 0, draws: 0 };
    if (myScore > oppScore) {
      rec.wins++;
      total.wins++;
    } else if (myScore < oppScore) {
      rec.losses++;
      total.losses++;
    } else {
      rec.draws++;
      total.draws++;
    }
    byOpponent.set(oppId, rec);
  }

  return { byOpponent, total };
}
