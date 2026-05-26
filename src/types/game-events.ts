/** 문자중계 Phase 1 — Event types derived from KBO API diff */

// Phase 1: skip pitch-level events, focus on at-bat results + game flow
export type GameEventType =
  // 타석 결과
  | "at_bat_hit"        // 안타 (1루타)
  | "at_bat_double"     // 2루타
  | "at_bat_triple"     // 3루타
  | "at_bat_homerun"    // 홈런
  | "at_bat_out"        // 아웃 (추론)
  | "at_bat_walk"       // 볼넷
  | "at_bat_strikeout"  // 삼진
  // 득점
  | "run_scored"        // 득점
  // 경기 흐름
  | "inning_start"      // 이닝 시작
  | "inning_end"        // 이닝 종료
  | "pitching_change"   // 투수 교체
  | "game_start"        // 경기 시작
  | "game_end"          // 경기 종료
  // 기타
  | "info";             // 정보성 텍스트

export interface EventDetail {
  pitcher?: string;
  batter?: string;
  rbi?: number;
  runsScored?: string[];
  playerIn?: string;
  playerOut?: string;
  team?: string;
  inning?: number;
  isTop?: boolean;
  message?: string;
}

export interface GameSnapshot {
  awayScore: number;
  homeScore: number;
  balls: number;
  strikes: number;
  outs: number;
  runners: {
    first: string | null;
    second: string | null;
    third: string | null;
  };
  pitcher: string;
  batter: string;
}

/** Trigger source for celebration latency telemetry / cross-source dedupe debugging.
 *  `kbo_diff` = legacy path (liveGame + BoxScore client diff in event-generator.ts)
 *  `relay`    = Naver 문자중계 path (relay-event-generator.ts), typically 10–20s faster
 *  Same logical play mints the same id from either source; `source` only records
 *  which path observed it first. */
export type GameEventSource = "kbo_diff" | "relay";

export interface GameEvent {
  /** 고유 ID (gameId-inning-sequence) */
  id: string;
  gameId: string;
  timestamp: string;
  inning: number;
  isTop: boolean;
  type: GameEventType;
  detail: EventDetail;
  /** 문자중계 텍스트 (한글 + emoji) */
  text: string;
  snapshot: GameSnapshot;
  /** Telemetry-only: which generator emitted this. Omitted = legacy/unknown. */
  source?: GameEventSource;
}

export interface GameEventStream {
  gameId: string;
  events: GameEvent[];
  lastUpdated: string;
  currentState: GameSnapshot;
}
