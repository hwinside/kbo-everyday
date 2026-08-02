/**
 * 경기별 선수 스탯 적재 (선수 스탯 보강 V1 — 빌드 1).
 * spec: specs/stats/player-stats-v1.md
 *
 * 네이버 record 박스스코어 → `player_game_logs` 행 매핑. 순수 매핑(buildGameLogRows)과
 * 네트워크 페치(fetchGameBoxscore)를 분리해 테스트 가능하게 둔다.
 */
import { resolvePlayer } from "@/lib/utils/resolve-player";
import type { KboGame } from "@/lib/crawler/kbo-api";

/** teamId(1-10) → KBO 2글자 코드 (gameId·공식 코드 기준). */
export const TEAM_ID_TO_CODE: Record<number, string> = {
  1: "LG", 2: "OB", 3: "KT", 4: "SK", 5: "NC",
  6: "HT", 7: "LT", 8: "SS", 9: "HH", 10: "WO",
};

export interface PlayerGameLogRow {
  kbo_id: string;
  player_type: "batter" | "pitcher";
  game_id: string;
  game_date: string; // YYYY-MM-DD
  team_id: number;
  team_code: string;
  opponent_team_id: number;
  is_home: boolean;
  result: "W" | "L" | "D";
  // 타자
  ab: number; h: number; hr: number; rbi: number; bb: number; so: number;
  // 투수 (ip_outs = 총 아웃 정수)
  ip_outs: number; er: number; h_allowed: number; k: number; bb_allowed: number;
}

interface RawBatter {
  name?: unknown; ab?: unknown; hit?: unknown; hr?: unknown;
  rbi?: unknown; bb?: unknown; kk?: unknown;
}
interface RawPitcher {
  name?: unknown; inn?: unknown; hit?: unknown;
  er?: unknown; kk?: unknown; bb?: unknown;
}

export interface GameBoxscore {
  awayBatters: RawBatter[]; homeBatters: RawBatter[];
  awayPitchers: RawPitcher[]; homePitchers: RawPitcher[];
}

/** KBO "5.1"(5⅓) 이닝 표기 → 총 아웃(정수). "5"=15, "5.1"=16, "5.2"=17. */
export function ipToOuts(inn: string): number {
  const s = String(inn ?? "").trim();
  if (!s) return 0;
  const [wholeStr, fracStr] = s.split(".");
  const whole = parseInt(wholeStr, 10) || 0;
  const frac = fracStr ? parseInt(fracStr, 10) || 0 : 0; // 0 | 1 | 2
  return whole * 3 + Math.min(Math.max(frac, 0), 2);
}

function n(v: unknown): number {
  return Number(v) || 0;
}

function resultFor(myScore: number, oppScore: number): "W" | "L" | "D" {
  if (myScore > oppScore) return "W";
  if (myScore < oppScore) return "L";
  return "D";
}

/** YYYYMMDD → YYYY-MM-DD */
function toIsoDate(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

const NAVER_RECORD_API = "https://api-gw.sports.naver.com/schedule/games";

/** 네이버 record 박스스코어 페치. 경기 미진행/취소·응답 이상 시 null. */
export async function fetchGameBoxscore(kboGameId: string): Promise<GameBoxscore | null> {
  try {
    const naverId = `${kboGameId}${kboGameId.slice(0, 4)}`;
    const res = await fetch(`${NAVER_RECORD_API}/${naverId}/record`, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; KboEveryday/1.0)" },
    });
    if (!res.ok) return null;
    const json = await res.json();
    const rd = json?.result?.recordData;
    if (!rd?.battersBoxscore || !rd?.pitchersBoxscore) return null;
    return {
      awayBatters: rd.battersBoxscore.away ?? [],
      homeBatters: rd.battersBoxscore.home ?? [],
      awayPitchers: rd.pitchersBoxscore.away ?? [],
      homePitchers: rd.pitchersBoxscore.home ?? [],
    };
  } catch {
    return null;
  }
}

/**
 * 박스스코어에 출전했지만 로스터 매칭(resolvePlayer)에 실패한 선수.
 * 신규/시즌중 합류 선수(특히 외국인)가 미등록일 때 fail-closed로 스킵되는데,
 * 그 누락을 cron이 모아서 알림하도록 수집한다. (roster-gap-alert)
 */
export interface UnresolvedBoxScorePlayer {
  name: string;
  teamId: number;
  teamCode: string;
  playerType: "batter" | "pitcher";
}

/**
 * 한 경기 박스스코어 → `player_game_logs` 행 배열. 순수 함수(네트워크 X).
 * - kbo_id는 {name, teamId}로 resolvePlayer (동명이인 팀 분리). 매칭 실패 행은 제외(fail-closed).
 * - 같은 (kbo_id, player_type)은 1행만 (박스스코어 중복 방어).
 * - unresolvedSink 전달 시: 매칭 실패한 선수를 거기에 모은다(미등록 탐지용, 옵션).
 */
export function buildGameLogRows(
  game: KboGame,
  box: GameBoxscore,
  unresolvedSink?: UnresolvedBoxScorePlayer[],
): PlayerGameLogRow[] {
  if (game.awayScore == null || game.homeScore == null) return [];
  const gameDate = toIsoDate(game.date);
  const rows: PlayerGameLogRow[] = [];
  const seen = new Set<string>();

  const sides = [
    {
      batters: box.homeBatters, pitchers: box.homePitchers,
      teamId: game.homeTeamId, oppId: game.awayTeamId, isHome: true,
      myScore: game.homeScore, oppScore: game.awayScore,
    },
    {
      batters: box.awayBatters, pitchers: box.awayPitchers,
      teamId: game.awayTeamId, oppId: game.homeTeamId, isHome: false,
      myScore: game.awayScore, oppScore: game.homeScore,
    },
  ];

  for (const side of sides) {
    if (!side.teamId) continue;
    const teamCode = TEAM_ID_TO_CODE[side.teamId] ?? "";
    const result = resultFor(side.myScore, side.oppScore);
    const base = {
      game_id: game.gameId, game_date: gameDate,
      team_id: side.teamId, team_code: teamCode, opponent_team_id: side.oppId,
      is_home: side.isHome, result,
    };

    for (const b of side.batters) {
      const name = String(b.name ?? "").trim();
      if (!name) continue;
      const resolved = resolvePlayer({ name, teamId: side.teamId }, undefined, { context: "game-logs:batter" });
      if (!resolved) {
        unresolvedSink?.push({ name, teamId: side.teamId, teamCode, playerType: "batter" });
        continue;
      }
      const key = `${resolved.kboId}|batter`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        ...base, kbo_id: resolved.kboId, player_type: "batter",
        ab: n(b.ab), h: n(b.hit), hr: n(b.hr), rbi: n(b.rbi), bb: n(b.bb), so: n(b.kk),
        ip_outs: 0, er: 0, h_allowed: 0, k: 0, bb_allowed: 0,
      });
    }

    for (const p of side.pitchers) {
      const name = String(p.name ?? "").trim();
      if (!name) continue;
      const resolved = resolvePlayer({ name, teamId: side.teamId }, undefined, { context: "game-logs:pitcher" });
      if (!resolved) {
        unresolvedSink?.push({ name, teamId: side.teamId, teamCode, playerType: "pitcher" });
        continue;
      }
      const key = `${resolved.kboId}|pitcher`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        ...base, kbo_id: resolved.kboId, player_type: "pitcher",
        ab: 0, h: 0, hr: 0, rbi: 0, bb: 0, so: 0,
        ip_outs: ipToOuts(String(p.inn ?? "0")), er: n(p.er), h_allowed: n(p.hit), k: n(p.kk), bb_allowed: n(p.bb),
      });
    }
  }

  return rows;
}

/** 한 경기 적재용 행 생성: 페치 + 매핑. 박스 없음(취소 등) 시 null. */
export async function ingestGameRows(
  game: KboGame,
  unresolvedSink?: UnresolvedBoxScorePlayer[],
): Promise<PlayerGameLogRow[] | null> {
  const box = await fetchGameBoxscore(game.gameId);
  if (!box) return null;
  return buildGameLogRows(game, box, unresolvedSink);
}
