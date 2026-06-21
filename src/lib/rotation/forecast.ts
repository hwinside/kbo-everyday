/**
 * 로테이션 추정 기반 예측 선발투수 엔진.
 *
 * 핵심: 정상 로테이션에서 다음 선발 = cycleLen(기본 5) 경기 전 같은 슬롯의 투수.
 * (`S[a+k] === S[a+k-cycleLen]`) — backtest(2026 5·6월, 374표본) 결과 1~5경기 앞 ~67% 적중,
 * horizon이 멀어져도 떨어지지 않음(각 경기가 독립 슬롯이라 compounding 없음).
 *
 * 공식 예고(KBO 당일/임박 제공)는 절대 덮어쓰지 않는다 — 미공시 경기만 예측으로 채운다.
 */
import type { KboGame } from "@/lib/crawler/kbo-api";

const DEFAULT_CYCLE = 5;
const MIN_HISTORY = 5;
const ALL_TEAM_IDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

function chronoKey(g: KboGame): string {
  return `${g.date}-${g.time}-${g.gameId}`;
}

function teamStarter(g: KboGame, teamId: number): string {
  return ((g.awayTeamId === teamId ? g.awayStarterName : g.homeStarterName) || "").trim();
}

/** 시간순 선발명(old→new)에서 우세 로테이션 사이클 길이(4/5/6) 감지, 실패 시 기본 5. */
export function detectCycleLen(names: string[]): number {
  for (const len of [5, 4, 6]) {
    if (names.length < len * 2) continue;
    const last = names.slice(-len);
    if (new Set(last).size !== len) continue; // 한 주기에 정확히 len명
    const prev = names.slice(-(len * 2), -len);
    let matches = 0;
    for (let i = 0; i < len; i++) if (prev[i] === last[i]) matches++;
    if (matches >= len - 1) return len; // 직전 두 주기 강매칭
  }
  return DEFAULT_CYCLE;
}

export interface TeamForecast {
  /** gameId → 예측 선발명 (미공시 예정 경기만) */
  byGameId: Map<string, string>;
  cycleLen: number;
}

/** 한 팀의 미공시 예정 경기에 예측 선발을 부여한다. */
export function forecastTeam(games: KboGame[], teamId: number): TeamForecast {
  const teamGames = games
    .filter((g) => (g.awayTeamId === teamId || g.homeTeamId === teamId) && g.status !== "cancelled")
    .sort((a, b) => chronoKey(a).localeCompare(chronoKey(b)));

  // 종료 경기의 선발 시퀀스 = 과거 history
  const history: string[] = [];
  for (const g of teamGames) {
    if (g.status === "final") {
      const s = teamStarter(g, teamId);
      if (s) history.push(s);
    }
  }

  const byGameId = new Map<string, string>();
  const cycleLen = detectCycleLen(history);
  if (history.length < MIN_HISTORY) return { byGameId, cycleLen };

  // virtual 시퀀스를 앞으로 투영. 공식 예고가 있으면 시퀀스에 반영해 슬롯 정렬을 보정.
  const virtual = history.slice();
  for (const g of teamGames) {
    if (g.status === "final") continue; // 이미 history에 반영됨
    const official = teamStarter(g, teamId);
    if (official) {
      virtual.push(official);
      continue;
    }
    if (virtual.length < cycleLen) continue;
    const predicted = virtual[virtual.length - cycleLen];
    byGameId.set(g.gameId, predicted);
    virtual.push(predicted);
  }
  return { byGameId, cycleLen };
}

export interface GamePrediction {
  awayStarter?: string;
  homeStarter?: string;
}

/** 전 구단 → gameId별 예측 선발(양 팀, 미공시 경기만). */
export function forecastAll(games: KboGame[]): Map<string, GamePrediction> {
  const out = new Map<string, GamePrediction>();
  const gameById = new Map(games.map((g) => [g.gameId, g]));
  for (const teamId of ALL_TEAM_IDS) {
    const { byGameId } = forecastTeam(games, teamId);
    for (const [gameId, starter] of byGameId) {
      const g = gameById.get(gameId);
      if (!g) continue;
      const entry = out.get(gameId) ?? {};
      if (g.awayTeamId === teamId) entry.awayStarter = starter;
      else if (g.homeTeamId === teamId) entry.homeStarter = starter;
      out.set(gameId, entry);
    }
  }
  return out;
}
