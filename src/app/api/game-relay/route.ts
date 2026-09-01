import { NextRequest, NextResponse, after } from "next/server";
import {
  markApiRecovered,
  trackApiDegradation,
  type DegradationAlertPolicy,
} from "@/lib/monitoring/api-fallback-tracker";
import { isAllStarGameId } from "@/lib/constants/teams";
import { GAME_ID_FORMAT_HINT, isCanonicalKboGameId } from "@/lib/game/game-id";
import { parseNaverPitch, type PitchDetail } from "@/lib/game/pitch-provider";
import { buildRelayJsonResponse } from "@/lib/game/relay-degraded-header";
import { toDeltaResponse } from "@/lib/game/relay-delta";
import {
  NO_STORE_HEADERS,
  RELAY_EDGE_TTL_SECONDS,
  edgeCacheHeadersForRemaining,
  liveCacheHeaders,
} from "@/lib/http/live-cache";

// 라우트 자체는 항상 동적으로 실행한다(빌드타임 정적화 금지). 응답별 엣지 캐시는
// force-dynamic 과 무관하게 Cache-Control 헤더로 결정된다 — 같은 패턴을 쓰는
// /api/game-relay-events 가 Production 에서 커스텀 no-store 를 그대로 내보내고
// 있는 것으로 실측 확인했다.
// Vercel 서버리스에서 캐시 방지 (라이브 데이터는 항상 최신이어야 함)
export const dynamic = "force-dynamic";

// ===== Types =====

export interface PlayEvent {
  batterName: string;
  /** 라인업 타순(1~9). 확인되지 않으면 오표기 방지를 위해 생략한다. */
  batOrder?: number;
  result: string;
  type:
    | "hit"
    | "homerun"
    | "walk"
    | "strikeout"
    | "out"
    | "hbp"
    | "sacrifice"
    | "error"
    | "other";
  extras?: string[];
  /** 이 타석의 투구 시퀀스 (구종·구속·결과). 구형 경기/누락 시 생략. */
  pitches?: PitchDetail[];
}

export interface InningRelay {
  inning: number;
  half: "top" | "bottom";
  teamName: string;
  plays: PlayEvent[];
  /** 아직 결과(13/23)가 오지 않은 최신 타석. 라이브 화면 전용이며 완료 시 plays로 이동한다. */
  currentAtBat?: {
    batterName: string;
    /** 라인업 타순(몇 번 타자). type:8 "N번타자" 마커 또는 batterRecord.batOrder. 대타/미상 시 생략. */
    batOrder?: number;
    pitches: PitchDetail[];
  };
  /**
   * 교체·수비위치 변경 이벤트(이닝 내 시간순). Naver textRelay 원문의
   * "{pos} {A} : {pos} {B} (으)로 교체" / "{pos} {A} : {pos}(으)로 수비위치 변경"을
   * 구조화한 것. 필드뷰 수비 배치의 독립 소스 진실(추정 아님). 이벤트 없으면 생략.
   */
  fielding?: FieldingEvent[];
}

/**
 * 교체(replace) 또는 수비위치 변경(reposition) 이벤트. 포지션은 Naver 원문 한글 그대로.
 * `playIndex`는 이 이벤트가 속한 이닝의 `plays` 배열 기준 삽입 위치 — “이 인덱스의
 * 타석(결과) *직전*에 일어났다”는 시간순 결속. 진행 중 타석(아직 plays 미확정)의
 * 교체는 `playIndex === plays.length`로 떨어져 피드 맨 끝에 붙는다(라이브 즉시 노출).
 * 구버전 캐시 응답에는 없을 수 있어 optional — 소비처는 미정의 시 인라인 렌더를 생략(fail-safe).
 */
export type FieldingEvent =
  | { kind: "replace"; outName: string; outPosKr: string; inName: string; inPosKr: string; playIndex?: number }
  | { kind: "reposition"; name: string; fromPosKr: string; toPosKr: string; playIndex?: number };

// 교체 공지 텍스트의 역할 토큰(폐쇄집합) — 이름에 공백이 있는 외국인 선수(예: "밴 헤켄")를
// 위해 \S+ 대신 토큰 집합으로 경계를 잡는다.
// ⚠️ 문자열 리터럴이므로 정규식 이스케이프는 \\d 처럼 이중 백슬래시로 써야 한다("\d"는 "d"로 소실).
const FIELDING_POS_TOKEN = "(?:투수|포수|[123]루수|유격수|좌익수|중견수|우익수|지명타자|대타|대주자|\\d+번타자|[123]루주자)";
const FIELDING_REPLACE_RE = new RegExp(
  `^(${FIELDING_POS_TOKEN})\\s+(.+?)\\s*:\\s*(${FIELDING_POS_TOKEN})\\s+(.+?)\\s*\\(으\\)로 교체$`,
);
const FIELDING_REPOSITION_RE = new RegExp(
  `^(${FIELDING_POS_TOKEN})\\s+(.+?)\\s*:\\s*(${FIELDING_POS_TOKEN})\\(으\\)로 수비위치 변경$`,
);

/**
 * textOption 한 줄을 FieldingEvent로 파싱. 교체/수비위치 변경 패턴이 아니면 null.
 * type 코드가 아니라 텍스트 패턴으로 판별한다(원문이 type:2 범용 텍스트로 옴 — 실측).
 */
export function parseFieldingEvent(text: string): FieldingEvent | null {
  const t = text.trim();
  if (!t) return null;
  const rep = FIELDING_REPLACE_RE.exec(t);
  if (rep) {
    return { kind: "replace", outPosKr: rep[1], outName: rep[2].trim(), inPosKr: rep[3], inName: rep[4].trim() };
  }
  const mov = FIELDING_REPOSITION_RE.exec(t);
  if (mov) {
    return { kind: "reposition", fromPosKr: mov[1], name: mov[2].trim(), toPosKr: mov[3] };
  }
  return null;
}

export interface MatchupStats {
  pitcher?: {
    name: string;
    pitchCount: number;
    strikeCount: number;
    ballCount: number;
    strikeouts: number;
    walks: number;
    hits: number;
    earnedRuns: number;
    inn: string | null;
    seasonEra: number;
  };
  batter?: {
    name: string;
    pa: number;
    ab: number;
    hits: number;
    hr: number;
    bb: number;
    so: number;
    rbi: number;
    run: number;
    todayAvg: number;
    seasonAvg: number;
    batResult: string;
  };
  /**
   * 현재 타석 투수 vs 타자 전 시즌 누적 통산 맞대결 (네이버 relay 원문).
   * 예: "3타수 1안타 1홈런 .333" / 기록 없으면 "첫 맞대결".
   */
  careerVsBatter?: string | null;
}

export interface RelayBatterStat {
  name: string;
  batOrder: number;
  posName: string;
  pa: number;
  ab: number;
  hit: number;
  hr: number;
  bb: number;
  so: number;
  rbi: number;
  run: number;
  seasonAvg: number;
  todayAvg: number;
}

export interface RelayPitcherStat {
  name: string;
  pitchCount: number;
  strikeCount: number;
  ballCount: number;
  strikeouts: number;
  walks: number;
  hits: number;
  earnedRuns: number;
  runs: number;
  inn: string | null;
  seasonEra: number;
  hr: number;
}

export interface RelayPlayerStats {
  awayBatters: RelayBatterStat[];
  homeBatters: RelayBatterStat[];
  awayPitchers: RelayPitcherStat[];
  homePitchers: RelayPitcherStat[];
}

export interface RelayLinescore {
  away: { innings: (number | null)[]; R: number; H: number; E: number };
  home: { innings: (number | null)[]; R: number; H: number; E: number };
}

export interface GameRelayResponse {
  gameId: string;
  currentInning: number;
  innings: InningRelay[];
  /** 마지막 성공한 네이버 relay fetch 시각. 캐시 응답도 원 fetch 시각을 유지한다. */
  updatedAt?: string;
  matchup?: MatchupStats;
  playerStats?: RelayPlayerStats;
  linescore?: RelayLinescore;
  /**
   * true 면 delta(증분) 응답 — innings가 현재/직전 이닝만 담긴 부분 집합이므로
   * 클라이언트는 기존 보유 이닝과 병합(merge)해야 한다. 없거나 false면 전체(full).
   */
  partial?: boolean;
}

// ===== Helpers =====

function toNaverGameId(kboGameId: string): string {
  const year = kboGameId.slice(0, 4);
  // 올스타는 네이버가 앞 4자리 연도 대신 9999 prefix로 서비스한다.
  // 예: KBO 20260711WEEA0 → Naver 99990711WEEA02026 (연도 suffix는 실제 연도 유지).
  const base = isAllStarGameId(kboGameId) ? `9999${kboGameId.slice(4)}` : kboGameId;
  return base + year;
}

function classifyResult(text: string): PlayEvent["type"] {
  // Order matters: 확정 결과 키워드 먼저 매칭하고, 모호한 hit 분류는 *마지막*에
  // 떨어뜨려야 한다. 네이버 상대 결과 텍스트는 "2루타성 타구가 잡혀 아웃" 처럼
  // hit 키워드와 "아웃"이 동시에 들어가는 case가 있어, hit을 먼저 매칭하면
  // false-positive at_bat_double 세레머니가 발화한다.
  if (text.includes("홈런")) return "homerun";
  if (text.includes("삼진")) return "strikeout";
  if (text.includes("볼넷")) return "walk";
  if (text.includes("몸에 맞는 볼")) return "hbp";
  // 아웃 키워드가 있으면 hit이 아님 ("N루타성 ... 잡혀 아웃" 차단)
  if (text.includes("아웃")) {
    if (text.includes("희생")) return "sacrifice";
    return "out";
  }
  if (text.includes("희생")) return "sacrifice";
  if (text.includes("실책")) return "error";
  // 아웃 없는 hit 결과: N루타, 내야안타, 평범한 안타 모두 hit으로.
  // classifyHit이 N루타 substring 없으면 single로 안전 fallback (BoxScore-diff
  // 경로와 동일 — 거기서도 h2b/h3b/hr delta 없으면 단타 처리).
  if (
    text.includes("1루타") ||
    text.includes("2루타") ||
    text.includes("3루타") ||
    text.includes("내야안타") ||
    text.includes("안타")
  )
    return "hit";
  return "other";
}

function normalizeBatOrder(value: unknown): number | null {
  const order = typeof value === "number" ? value : Number(value);
  return Number.isInteger(order) && order >= 1 && order <= 9 ? order : null;
}

/**
 * 현재 타자의 라인업 타순을 record API 박스스코어(현재 라인업)에서 이름으로 재해석한다.
 * record 박스스코어는 대타·대주자 등 교체를 반영한 "지금 라인업"이므로, relay 마커(대타는
 * "N번타자" 접두가 없음)보다 교체 선수 타순에 더 정확하다. 매칭 실패/범위 밖이면 null →
 * 호출부가 parser 값(batterRecord.batOrder)으로 fallback 한다(오표기 대신 안전).
 */
export function resolveBatOrderFromLineup(
  batterName: string | undefined,
  batters: RelayBatterStat[] | undefined,
): number | null {
  const name = batterName?.trim();
  if (!name || !batters) return null;
  const hit = batters.find((b) => b.name?.trim() === name);
  return hit ? normalizeBatOrder(hit.batOrder) : null;
}

interface NaverGamePlayerStats {
  kk: number;
  hit: number;
  bhome: number;
  ballCount: number;
  era: number;
  seasonEra: number;
  inn: string | null;
  run: number;
  strikeCount: number;
  bb: number;
  ab: number;
  batResult?: string;
  rbi: number;
  batOrder?: number;
  hr: number;
  so: number;
  pa: number;
}

interface NaverPlayerInfo {
  playerType: "pitcher" | "batter";
  currentGamePlayerStats?: NaverGamePlayerStats;
  totalSeasonStats?: {
    era: number;
    inn: string | null;
    kk: number;
    bb: number;
    hra: number;
    [key: string]: unknown;
  };
}

interface NaverBatterRecord {
  name: string;
  ab: number;
  hit: number;
  hr: number;
  bb: number;
  so: number;
  rbi: number;
  run: number;
  pa: number;
  todayHra: number;
  seasonHra: number;
  batOrder: number;
  posName: string;
}

export interface NaverTextOption {
  seqno: number;
  text: string;
  type: number;
  speed?: string;
  stuff?: string;
  pitchNum?: number;
  pitchResult?: string;
  currentGameState?: { ball?: string; strike?: string; out?: string };
  currentPlayersInfo?: {
    away?: NaverPlayerInfo;
    home?: NaverPlayerInfo;
  };
  batterRecord?: NaverBatterRecord;
}

export interface NaverTextRelay {
  title: string;
  titleStyle: string;
  textOptions?: NaverTextOption[];
}

interface NaverRelayResponse {
  code: number;
  success: boolean;
  result: {
    textRelayData: {
      gameId: string;
      inn: number;
      currentInning: string;
      textRelays: NaverTextRelay[];
      pitcherVsBatterCareerStats?: string;
      inningScore?: {
        home: Record<string, string>;
        away: Record<string, string>;
      };
      currentGameState?: {
        homeScore: string;
        awayScore: string;
        homeHit: string;
        awayHit: string;
        homeError: string;
        awayError: string;
        [key: string]: string;
      };
    };
  };
}

// 회귀 테스트(scripts/qa/pitch-inning-parser-smoke.ts)가 production 경로를 직접
// 고정할 수 있도록 export 한다(어댑터/별도 map 시뮬레이션이 아닌 실제 함수).
export function parseInningRelays(textRelays: NaverTextRelay[]): InningRelay[] {
  // textRelays comes in reverse order (newest first) — flip to chronological
  const chronological = [...textRelays].reverse();

  const innings: InningRelay[] = [];
  let current: InningRelay | null = null;
  // type:1(투구)은 타석 결과(13/23)보다 먼저 도착하므로 buffer에 쌓았다가 결과 행에서
  // 확정 타석에 붙인다(삼순 pendingAtBat 요구). 같은 relay.textOptions 안이든 여러 relay에
  // 걸쳐 오든 동일하게 동작. 이닝 경계·결과 확정 시 비운다.
  let pendingPitches: PitchDetail[] = [];
  let pendingBatterName: string | null = null;
  let pendingBatOrder: number | null = null;

  for (const relay of chronological) {
    if (relay.titleStyle === "0") {
      pendingPitches = [];
      pendingBatterName = null;
      pendingBatOrder = null;
      // Inning header: "1회초 LG 공격"
      const match = relay.title.match(/(\d+)회(초|말)\s*(.+?)\s*공격/);
      if (match) {
        current = {
          inning: parseInt(match[1]),
          half: match[2] === "초" ? "top" : "bottom",
          teamName: match[3],
          plays: [],
        };
        innings.push(current);
      }
      continue;
    }

    // Batter at-bat (titleStyle "8" or others with textOptions)
    if (!current || !relay.textOptions) continue;

    // Batter 식별은 *opt.text* parts[0]에서 직접 추출. 과거엔 `relay.title`의
    // `/\d+번타자\s+(.+)/` 정규식만 신뢰했으나, 대타("대타 문정빈")/대주자
    // ("대주자 홍창기") 등 비표준 title 변종에서 매칭 실패 → relay 항목 통째
    // skip → cross-source dedupe 깨지면서 BoxScore-diff fallback이 stale
    // boxscore에서 hit subtype을 잘못 분류(예: 3루타 → 안타) 발화하는 회귀가
    // 났었다 (2026-05-27 문정빈 3루타 P0). type=13/23 자체가 "타석 결과" 마커
    // 라서 opt.text "X : 결과" 포맷이 SSOT — title을 거치지 않아도 batter를
    // 안전하게 식별할 수 있다. " : " 분리자 없으면 정상 result line이 아니므로
    // skip.

    for (const opt of relay.textOptions) {
      // 교체·수비위치 변경 공지(type:2 범용 텍스트)는 패턴으로 식별해 이닝 시간순으로 적재.
      // 타석 파싱 상태머신(pendingPitches 등)과 무관하므로 소비 후 다음 옵션으로 넘어간다.
      if (typeof opt.text === "string") {
        const fieldingEvent = parseFieldingEvent(opt.text);
        if (fieldingEvent) {
          // playIndex = 현재 plays 길이 — 이 교체 공지는 아직 terminal(13/23)이 안 온
          // 현재 타석에 속하므로, 그 타석이 확정되면 정확히 이 인덱스에 push 된다.
          // 클라이언트는 plays[playIndex] 직전에 교체 행을 끼워 시간순을 복원한다.
          (current.fielding ??= []).push({ ...fieldingEvent, playIndex: current.plays.length });
          continue;
        }
      }
      if (opt.type === 8) {
        // 새 타석 시작 마커("5번타자 한준수"/"대타 문정빈" 등). 직전 타석이 정상
        // terminal(13/23) 없이 끝났다면(외부 relay 스키마 변형) 남은 투구가 다음
        // 타석에 붙는 오염을 막기 위해 fail-closed reset 한다. terminal 소비 경로와
        // 함께 타석 경계에서 pendingPitches 잔류를 0으로 만드는 두 번째 방어선.
        pendingPitches = [];
        const startText = opt.text.trim();
        const startMatch = /^(?:\d+번타자|대타|대주자)\s+(.+)$/.exec(startText);
        pendingBatterName = opt.batterRecord?.name?.trim() || startMatch?.[1]?.trim() || null;
        // 타순: batterRecord.batOrder(1~9) 우선, 없으면 "N번타자" 접두 숫자.
        // 대타/교체는 batterRecord가 들고 있는 원 batting-order slot을 그대로 쓴다.
        // 양쪽 모두 없거나 범위가 잘못되면 오표기 대신 숨긴다(fail-safe).
        const recOrder = normalizeBatOrder(opt.batterRecord?.batOrder);
        const orderMatch = /^(\d+)번타자/.exec(startText);
        pendingBatOrder = recOrder ?? normalizeBatOrder(orderMatch?.[1]);
      } else if (opt.type === 13 || opt.type === 23) {
        // At-bat result: "홍창기 : 우익수 앞 1루타"
        // type 13 = 일반 타석 결과, type 23 = 희생플라이/아웃/볼넷 등
        // terminal 마커는 "타석 종료" 신호이므로 result 파싱 성공 여부와 무관하게
        // 여기서 소비한 투구 버퍼를 확정적으로 비운다(fail-closed). malformed(빈/무
        // 구분자) result 에서 reset 을 건너뛰면 앞 타석 투구가 다음 정상 타석에
        // 섞이는 오염이 난다(삼순 리뷰 blocker).
        const consumedPitches = pendingPitches;
        const consumedBatOrder = pendingBatOrder;
        pendingPitches = [];
        pendingBatterName = null;
        pendingBatOrder = null;

        const parts = opt.text.split(" : ");
        if (parts.length < 2) continue;
        const batterName = parts[0].trim();
        if (!batterName) continue;
        const resultText = parts.slice(1).join(" : ");

        const play: PlayEvent = {
          batterName,
          ...(consumedBatOrder ? { batOrder: consumedBatOrder } : {}),
          result: resultText,
          type: classifyResult(resultText),
        };
        // 이 타석에 쌓인 투구 시퀀스를 붙인다. 사구 마지막 공 누락/자동고의4구(0구)/
        // 대타 교체 빈 타석은 consumedPitches가 비어 자연히 pitches 생략(fail-safe).
        if (consumedPitches.length > 0) play.pitches = consumedPitches;
        current.plays.push(play);
      } else if (opt.type === 1) {
        // 투구 1개 — 네이버 어댑터로 격리 파싱. 최소 정보(text)조차 없으면 null → skip.
        const pitch = parseNaverPitch(opt);
        if (pitch) pendingPitches.push(pitch);
      } else if (opt.type === 14 || opt.type === 24) {
        // Base running event — show scoring, steals, and home-ins
        // type 14 = 일반 주루, type 24 = 홈인/진루 등
        if (
          opt.text.includes("홈까지 진루") ||
          opt.text.includes("홈인") ||
          opt.text.includes("득점") ||
          opt.text.includes("도루")
        ) {
          // Attach to the last play as extra
          const lastPlay = current.plays[current.plays.length - 1];
          if (lastPlay) {
            if (!lastPlay.extras) lastPlay.extras = [];
            lastPlay.extras.push(opt.text);
          }
        }
      }
    }
  }

  if (current && pendingBatterName) {
    current.currentAtBat = {
      batterName: pendingBatterName,
      ...(pendingBatOrder ? { batOrder: pendingBatOrder } : {}),
      pitches: pendingPitches,
    };
  }

  return innings;
}

function extractPlayerStats(allTextRelays: NaverTextRelay[]): RelayPlayerStats {
  // Collect latest stats for each player across all innings
  // batterRecord is cumulative (updated each at-bat), so last occurrence = latest
  const batterMap = new Map<string, { record: NaverBatterRecord; half: "top" | "bottom" }>();
  const pitcherMap = new Map<string, { stats: NaverGamePlayerStats; total: { era: number; inn: string | null }; half: "top" | "bottom" }>();

  let currentHalf: "top" | "bottom" = "top";

  // Process in chronological order (reverse since newest first)
  const chronological = [...allTextRelays].reverse();

  for (const relay of chronological) {
    // Track inning half from headers
    if (relay.titleStyle === "0") {
      const match = relay.title?.match(/\d+회(초|말)/);
      if (match) currentHalf = match[1] === "초" ? "top" : "bottom";
      continue;
    }

    if (relay.titleStyle !== "8") continue;
    const opts = relay.textOptions;
    if (!opts) continue;

    for (const opt of opts) {
      // Batter record (accumulates through the game)
      if (opt.batterRecord?.name) {
        batterMap.set(opt.batterRecord.name, {
          record: opt.batterRecord,
          half: currentHalf,  // batting team's half
        });
      }

      // Pitcher stats from currentPlayersInfo
      if (opt.currentPlayersInfo) {
        const awaySide = opt.currentPlayersInfo.away;
        const homeSide = opt.currentPlayersInfo.home;

        // The pitcher is on the defensive side
        const pitcherInfo = awaySide?.playerType === "pitcher" ? awaySide : homeSide?.playerType === "pitcher" ? homeSide : undefined;
        const pitcherIsHome = homeSide?.playerType === "pitcher";

        if (pitcherInfo?.currentGamePlayerStats) {
          // We need pitcher name — extract from relay title context
          // Unfortunately pitcher name isn't directly in currentPlayersInfo
          // But we can use the batter's at-bat context: when batter is away (top), pitcher is home
          const pitcherHalf: "top" | "bottom" = pitcherIsHome ? "bottom" : "top"; // pitcher's team half
          const pitcherId = `pitcher_${pitcherIsHome ? "home" : "away"}_${pitcherInfo.currentGamePlayerStats.inn || "0"}`;

          // We'll collect all pitcher data and deduplicate by ballCount (increasing)
          // For now store by a composite key
        }
      }
    }
  }

  // Separate batters by team (top = away batters, bottom = home batters)
  const awayBatters: RelayBatterStat[] = [];
  const homeBatters: RelayBatterStat[] = [];

  for (const [, { record, half }] of batterMap) {
    const stat: RelayBatterStat = {
      name: record.name,
      batOrder: record.batOrder,
      posName: record.posName,
      pa: record.pa,
      ab: record.ab,
      hit: record.hit,
      hr: record.hr,
      bb: record.bb,
      so: record.so,
      rbi: record.rbi,
      run: record.run,
      seasonAvg: record.seasonHra,
      todayAvg: record.todayHra,
    };
    if (half === "top") awayBatters.push(stat);
    else homeBatters.push(stat);
  }

  // Sort by batting order
  awayBatters.sort((a, b) => a.batOrder - b.batOrder);
  homeBatters.sort((a, b) => a.batOrder - b.batOrder);

  // For pitchers, we need to extract from the inning headers' currentPlayersInfo
  // Each inning header has pitcher ID, and we can track pitcher changes
  const awayPitchers: RelayPitcherStat[] = [];
  const homePitchers: RelayPitcherStat[] = [];

  // Re-scan for pitcher data from type=8 options (last occurrence per pitcher name)
  // The pitcher's currentGamePlayerStats accumulate
  const pitcherAccum = new Map<string, { stats: NaverGamePlayerStats; totalEra: number; isHome: boolean }>();

  for (const relay of chronological) {
    if (relay.titleStyle !== "8") continue;
    const opts = relay.textOptions;
    if (!opts) continue;

    for (const opt of opts) {
      if (!opt.currentPlayersInfo) continue;

      const awaySide = opt.currentPlayersInfo.away;
      const homeSide = opt.currentPlayersInfo.home;

      // Find pitcher side
      for (const [side, isHome] of [[awaySide, false], [homeSide, true]] as [NaverPlayerInfo | undefined, boolean][]) {
        if (side?.playerType !== "pitcher" || !side.currentGamePlayerStats) continue;
        const gs = side.currentGamePlayerStats;
        // Use pitcher's ballCount as identifier (increases monotonically for same pitcher)
        // We need a name... check if batterRecord tells us the opposing pitcher
        // Actually, the title of the relay is the batter, not the pitcher
        // We'll need to get pitcher name from somewhere else

        // For now, create a key from isHome + inn (rough approximation)
        const key = `${isHome ? "home" : "away"}_pitcher`;
        const existing = pitcherAccum.get(key);
        const totalPitchCount = gs.ballCount + gs.strikeCount;

        // If this pitcher has more pitches than the stored one, it's the current pitcher (same or new)
        // Since we can't distinguish pitcher changes without names, we'll just use the latest stats
        if (!existing || totalPitchCount >= (existing.stats.ballCount + existing.stats.strikeCount)) {
          pitcherAccum.set(key, {
            stats: gs,
            totalEra: side.totalSeasonStats?.era ?? gs.seasonEra,
            isHome,
          });
        }
      }
    }
  }

  for (const [, { stats, totalEra, isHome }] of pitcherAccum) {
    const pitcherStat: RelayPitcherStat = {
      name: "", // Will be filled by client matching with currentPitcher
      pitchCount: stats.ballCount + stats.strikeCount,
      strikeCount: stats.strikeCount,
      ballCount: stats.ballCount,
      strikeouts: stats.kk,
      walks: stats.bb,
      hits: stats.hit,
      earnedRuns: stats.run,
      runs: stats.run,
      inn: stats.inn,
      seasonEra: totalEra,
      hr: stats.hr,
    };
    if (isHome) homePitchers.push(pitcherStat);
    else awayPitchers.push(pitcherStat);
  }

  return { awayBatters, homeBatters, awayPitchers, homePitchers };
}

function extractMatchup(allTextRelays: NaverTextRelay[]): MatchupStats | undefined {
  // Find the latest type=8 option (newest batter entry) which has currentPlayersInfo
  // textRelays are in reverse order (newest first within each inning fetch)
  // We want the FIRST type=8 we encounter (which is the most recent)
  for (const relay of allTextRelays) {
    if (relay.titleStyle !== "8") continue;
    const opts = relay.textOptions;
    if (!opts) continue;

    for (const opt of opts) {
      if (opt.type !== 8 || !opt.currentPlayersInfo) continue;

      const matchup: MatchupStats = {};

      // Find pitcher side (the one with playerType === "pitcher")
      const awaySide = opt.currentPlayersInfo.away;
      const homeSide = opt.currentPlayersInfo.home;
      const pitcherSide = awaySide?.playerType === "pitcher" ? awaySide : homeSide?.playerType === "pitcher" ? homeSide : undefined;
      const batterSide = awaySide?.playerType === "batter" ? awaySide : homeSide?.playerType === "batter" ? homeSide : undefined;

      if (pitcherSide?.currentGamePlayerStats) {
        const s = pitcherSide.currentGamePlayerStats;
        // Extract pitcher name from game-live (not available here), will be matched on client
        matchup.pitcher = {
          name: "", // Will be filled by client from currentPitcher
          pitchCount: s.ballCount + s.strikeCount,
          strikeCount: s.strikeCount,
          ballCount: s.ballCount,
          strikeouts: s.kk,
          walks: s.bb,
          hits: s.hit,
          earnedRuns: s.run,
          inn: s.inn,
          seasonEra: pitcherSide.totalSeasonStats?.era ?? s.seasonEra,
        };
      }

      if (batterSide?.currentGamePlayerStats && opt.batterRecord) {
        const s = batterSide.currentGamePlayerStats;
        const br = opt.batterRecord;
        matchup.batter = {
          name: br.name,
          pa: br.pa,
          ab: br.ab,
          hits: br.hit,
          hr: br.hr,
          bb: br.bb,
          so: br.so,
          rbi: br.rbi,
          run: br.run,
          todayAvg: br.todayHra,
          seasonAvg: br.seasonHra,
          batResult: s.batResult || "",
        };
      }

      if (matchup.pitcher || matchup.batter) return matchup;
    }
  }
  return undefined;
}

// ===== Record API parser (accurate pitcher/batter stats with names) =====

interface NaverRecordPitcher {
  name: string;
  pcode: string;
  inn: string;
  hit: number;
  r: number;
  er: number;
  bb: number;
  kk: number;
  hr: number;
  bf: number;
  ab: number;
  pa: number;
  era: string;
  w: string;
  l: string;
  s: string;
  wls: string;
  bbhp: number;
  seasonWin: number;
  seasonLose: number;
  tb: string;
}

interface NaverRecordBatter {
  name: string;
  playerCode: string;
  batOrder: number;
  pos: string;
  ab: number;
  hit: number;
  hr: number;
  bb: number;
  kk: number;
  rbi: number;
  run: number;
  sb: number;
  hra: string;
}

interface NaverRecordResponse {
  code: number;
  success: boolean;
  result?: {
    recordData?: {
      pitchersBoxscore?: { away: NaverRecordPitcher[]; home: NaverRecordPitcher[] };
      battersBoxscore?: { away: NaverRecordBatter[]; home: NaverRecordBatter[] };
    };
  };
}

const POS_MAP: Record<string, string> = {
  "중": "중견수", "좌": "좌익수", "우": "우익수", "유": "유격수",
  "1": "1루수", "2": "2루수", "3": "3루수", "포": "포수", "지": "지명타자",
  "투": "투수",
};

function extractPlayerStatsFromRecord(data: NaverRecordResponse | null): RelayPlayerStats | null {
  const rd = data?.result?.recordData;
  if (!rd?.pitchersBoxscore || !rd?.battersBoxscore) return null;

  const pb = rd.pitchersBoxscore;
  const bb = rd.battersBoxscore;

  // Pitchers: record API has full names + individual stats
  function toPitcherStats(pitchers: NaverRecordPitcher[]): RelayPitcherStat[] {
    return pitchers.map((p) => {
      // Parse np from bf (total pitches not directly available, use bf as approximation)
      const pitchCount = p.bf || 0;
      return {
        name: p.name,
        pitchCount,
        strikeCount: 0,
        ballCount: 0,
        strikeouts: p.kk,
        walks: p.bb + (p.bbhp || 0),
        hits: p.hit,
        earnedRuns: p.er,
        runs: p.r,
        inn: p.inn || "-",
        seasonEra: parseFloat(p.era) || 0,
        hr: p.hr,
      };
    });
  }

  function toBatterStats(batters: NaverRecordBatter[]): RelayBatterStat[] {
    return batters.map((b) => ({
      name: b.name,
      batOrder: b.batOrder,
      posName: POS_MAP[b.pos] || b.pos,
      pa: b.ab + b.bb, // approximate PA
      ab: b.ab,
      hit: b.hit,
      hr: b.hr,
      bb: b.bb,
      so: b.kk,
      rbi: b.rbi,
      run: b.run,
      seasonAvg: parseFloat(b.hra) || 0,
      todayAvg: b.ab > 0 ? b.hit / b.ab : 0,
    }));
  }

  return {
    awayBatters: toBatterStats(bb.away),
    homeBatters: toBatterStats(bb.home),
    awayPitchers: toPitcherStats(pb.away),
    homePitchers: toPitcherStats(pb.home),
  };
}

// ===== Route handler =====

const NAVER_API_BASE =
  "https://api-gw.sports.naver.com/schedule/games";

/**
 * naver-relay 경보 정책 — durable claim RPC 기반. 기존 in-memory 경보는 서버리스
 * 인스턴스별 쿨다운이라 장애 중 인스턴스마다 재발송됐다(2026-08-11 19:00~19:30
 * 경보 3회 체감 원인). claim RPC는 count/cooldown을 DB에서 원자 판정 → 전역 30분 1회.
 */
const NAVER_RELAY_ALERT_POLICY: DegradationAlertPolicy = {
  windowMinutes: 5,
  threshold: 3,
  cooldownMinutes: 30,
  leaseSeconds: 60,
};

/**
 * 응답 후 실행(best-effort). Next 요청 컨텍스트에서는 after()로 응답 flush 뒤에
 * 돌고, 요청 컨텍스트 밖(qa 게이트가 GET을 직접 호출)에서는 after()가 throw하므로
 * fire-and-forget으로 대체한다. 둘 다 응답을 블로킹하지 않는다는 계약은 동일.
 */
function runAfterResponse(cb: () => Promise<void>): void {
  try {
    after(cb);
  } catch {
    void cb().catch(() => undefined);
  }
}

/** 업스트림 실패를 GET 레벨로 전달하는 typed error — single-flight 공유 안전. */
class RelayUpstreamError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: Record<string, unknown>,
  ) {
    super(String(body.error ?? "relay_upstream_error"));
    this.name = "RelayUpstreamError";
  }
}

/**
 * Single-flight: 같은 (naverGameId, inningHint)의 동시 fresh 요청은 업스트림
 * fetch 1회를 공유한다. 경기 동시 시작(콜드 burst) 때 같은 인스턴스에 몰린 N개
 * 폴링이 네이버로 N배 증폭되는 것을 차단한다(2026-08-11 19:00 cold burst 재발 방지).
 * delta(since)는 공유 결과에서 호출자별로 파생되므로 응답 의미는 불변.
 */
const inflightFresh = new Map<
  string,
  Promise<{ response: GameRelayResponse; anyInningDegraded: boolean }>
>();

/**
 * In-memory response cache (module-level, persists for the lambda warm period
 * ~5–15min). The relay-bridged celebration path on the client polls at 3s
 * cadence; without caching, N concurrent viewers of the same game would mean
 * N upstream Naver fetches every 3s. With a 2s TTL keyed by (naverGameId,
 * inningHint), warm-lambda viewers share a single upstream call per ~2s
 * window. Cold-start spawns a fresh instance with empty cache → up to one
 * Naver call per cold lambda, which is bounded by Vercel concurrency.
 *
 * TTL is kept just below the 3s poll so a client's own successive polls
 * always land a fresh upstream fetch (celebration freshness), while bursts
 * of concurrent viewers within the same 2s window still coalesce to one
 * upstream call (load bound). 4s→2s roughly doubles worst-case upstream
 * rate; accepted trade-off for cutting celebration fire lag.
 *
 * Only successful responses are cached; HTTP/network errors fall through so
 * the next poll retries fresh.
 */
const responseCache = new Map<string, { data: GameRelayResponse; expiresAt: number }>();
// TTL 단일 owner(삼순 NO-GO 2026-08-06): 엣지 TTL 상수에서 파생시켜
// route 내부 TTL 과 엣지 TTL 이 따로 놀 수 없게 만든다. 한쪽만 바꾸는 drift 불가.
const CACHE_TTL_MS = RELAY_EDGE_TTL_SECONDS * 1_000;

/**
 * Per-fetch timeout for inning 2..N relay fetches and the record fetch.
 * The inning-1 fetch keeps its own 10s bound (it also determines the current
 * inning). Kept at 8s: long enough that a merely-slow Naver response still
 * lands within one poll window, short enough that a genuinely hung upstream
 * releases the Promise.all instead of stalling the whole relay (and thus the
 * celebration) response indefinitely.
 */
const RELAY_INNING_TIMEOUT_MS = 8_000;

/**
 * Per-inning last-good raw relay snapshot, keyed by `${naverGameId}-${inning}`.
 *
 * WHY: relay event IDs (celebration dedupe key) embed a *game-wide* cumulative
 * index — `${gameId}-${type}-${inningKey}-${batter}-${cumIdx}` (see
 * relay-event-generator). If a per-inning fetch times out and we substitute `[]`
 * for that inning, every later same-(batter,type) event renumbers (e.g. a 5회
 * hit that was `-2` becomes `-1`), and when the inning recovers it flips back —
 * the client then sees a "new" id and re-fires / duplicates the celebration.
 *
 * FIX: on timeout/HTTP failure for an inning we reuse its last successful
 * snapshot instead of `[]`, so past innings never vanish and cumIdx stays
 * stable. A snapshot is only overwritten by a *successful* fetch (data only
 * grows more complete within a game). Module-level, so it persists across warm
 * invocations; bounded by (#live games × ≤15 innings) during the warm period.
 */
const inningSnapshotCache = new Map<string, NaverTextRelay[]>();

function evictInningSnapshotsIfLarge(): void {
  if (inningSnapshotCache.size <= 400) return;
  // Simple bound: drop oldest ~half (Map preserves insertion order).
  let drop = Math.floor(inningSnapshotCache.size / 2);
  for (const k of inningSnapshotCache.keys()) {
    if (drop-- <= 0) break;
    inningSnapshotCache.delete(k);
  }
}

/**
 * Resolve one inning's relays against the last-good snapshot cache (pure).
 *
 * Relay play sequences are append-only within a game: a completed at-bat never
 * disappears and events only accumulate. So a *shorter* array than the last-good
 * snapshot for the same inning is treated as a transient upstream truncation
 * (partial 200), NOT a real update — adopting it would drop tail plays and
 * renumber game-wide cumIdx (duplicate celebrations on recovery). We keep the
 * longer snapshot instead.
 *
 * - `fetched` non-null AND (no snapshot OR length ≥ snapshot) → adopt + cache
 *   (`degraded:false`). A legit not-yet-started inning ([]) with no prior
 *   snapshot adopts normally.
 * - `fetched` non-null but SHORTER than snapshot → keep snapshot
 *   (`degraded:true`, monotonic guard; do not shrink cache).
 * - `fetched === null` (failed/timeout):
 *     • snapshot present → reuse it (`degraded:true`, stale-but-consistent).
 *     • snapshot ABSENT → `unrecoverable:true`. No prior data to keep cumIdx
 *       stable, so `[]` would reintroduce the blocker (ID -2→-1→-2, current
 *       inning UI vanish) on a cold instance / post-eviction first failure.
 *       Caller MUST return non-2xx (client keeps existing data / retries).
 */
export function resolveInningWithSnapshot(
  cache: Map<string, NaverTextRelay[]>,
  key: string,
  fetched: NaverTextRelay[] | null,
): { relays: NaverTextRelay[]; degraded: boolean; unrecoverable: boolean } {
  const snap = cache.get(key);
  if (fetched !== null) {
    // Monotonic/completeness guard: never let a shorter fetch shrink a known
    // longer snapshot (transient truncation). Equal/longer adopts.
    if (snap !== undefined && fetched.length < snap.length) {
      return { relays: snap, degraded: true, unrecoverable: false };
    }
    cache.set(key, fetched);
    return { relays: fetched, degraded: false, unrecoverable: false };
  }
  if (snap !== undefined) {
    return { relays: snap, degraded: true, unrecoverable: false };
  }
  return { relays: [], degraded: true, unrecoverable: true };
}

/**
 * Executed relay-resolution policy shared by GET and the regression smoke.
 * Resolves every inning's fetch result against the per-inning last-good
 * snapshot cache, index 0 = inning 1. A failed inning (null) reuses its prior
 * successful relays so past innings never vanish and relay event IDs (game-wide
 * cumIdx) stay stable; a cold/no-snapshot failure surfaces via anyUnrecoverable
 * so the caller returns non-2xx instead of publishing a shrunk 200.
 */
export function resolveAllInnings(
  cache: Map<string, NaverTextRelay[]>,
  naverGameId: string,
  fetchedByInning: (NaverTextRelay[] | null)[],
): { relays: NaverTextRelay[][]; anyDegraded: boolean; anyUnrecoverable: boolean } {
  let anyDegraded = false;
  let anyUnrecoverable = false;
  const relays = fetchedByInning.map((raw, idx) => {
    const r = resolveInningWithSnapshot(cache, `${naverGameId}-${idx + 1}`, raw);
    if (r.degraded) anyDegraded = true;
    if (r.unrecoverable) anyUnrecoverable = true;
    return r.relays;
  });
  return { relays, anyDegraded, anyUnrecoverable };
}

export function combineRelayInningsNewestFirst(inningRelays: NaverTextRelay[][]): NaverTextRelay[] {
  // Each Naver inning payload is newest-first. parseInningRelays reverses the
  // full array once, so concatenate inning bundles newest inning first; the
  // parser then sees 1회 → current inning in chronological order.
  return [...inningRelays].reverse().flat();
}

/**
 * cache HIT 시 데이터와 **남은 수명**을 함께 돌려준다.
 *
 * 남은 수명이 필요한 이유(삼순 NO-GO 2026-08-06): 이미 age 가 쌓인 snapshot 을
 * 다시 full 엣지 TTL 로 올리면 route TTL + edge TTL 이 직렬 누적돼 유저가 보는
 * age 상한이 2배가 된다. 남은 수명만큼만 엣지에 주면 상한이 route TTL 하나로 묶인다.
 */
function getCachedResponse(key: string): { data: GameRelayResponse; remainingMs: number } | null {
  const entry = responseCache.get(key);
  if (!entry) return null;
  const remainingMs = entry.expiresAt - Date.now();
  if (remainingMs <= 0) {
    responseCache.delete(key);
    return null;
  }
  return { data: entry.data, remainingMs };
}

/**
 * 테스트 전용: 캐시 엔트리의 남은 수명(ms). 없으면 null.
 *
 * 왜 필요한가(삼순 NO-GO 2026-08-06 ③): 게이트가 첫 GET **전**의 벽시계로 남은
 * 수명을 추정하면, 실제 만료 시계는 첫 GET **끝**의 setCachedResponse 에서
 * 시작하므로 느린 첫 GET 에서 기대값이 실제와 어긋난다(timing false-green).
 * 추정 대신 실제 엔트리를 읽어 결정론적으로 판정한다.
 */
export function __getCacheRemainingMsForTest(
  gameId: string,
  inningHint = 0,
): number | null {
  // route 가 쓰는 것과 **같은 방식**으로 키를 만든다. 게이트가 키 규칙을 자기
  // 나름대로 재구현하면 route 가 키를 바꿔도 게이트는 모른 채 GREEN 이 된다.
  const entry = responseCache.get(`${toNaverGameId(gameId)}-${inningHint}`);
  if (!entry) return null;
  return entry.expiresAt - Date.now();
}

function setCachedResponse(key: string, data: GameRelayResponse): void {
  if (responseCache.size > 100) {
    const now = Date.now();
    for (const [k, v] of responseCache) {
      if (v.expiresAt < now) responseCache.delete(k);
    }
  }
  responseCache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

export async function GET(req: NextRequest) {
  const gameId = req.nextUrl.searchParams.get("gameId");
  if (!gameId) {
    return NextResponse.json(
      { error: "gameId is required" },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }
  // canonical 형식이 아니면 업스트림 도달 전 400 fail-close. 네이버식 긴 ID가
  // 들어오면 toNaverGameId가 연도를 이중으로 붙여 자기유발 404가 난다
  // (2026-08-11 오판 사고 재발 방지 — src/lib/game/game-id.ts 주석 참조).
  if (!isCanonicalKboGameId(gameId)) {
    return NextResponse.json(
      { error: "invalid gameId format", hint: GAME_ID_FORMAT_HINT },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  // 클라이언트에서 현재 이닝을 힌트로 전달 (네이버 API의 inn이 부정확할 때 대비)
  const inningHint = parseInt(req.nextUrl.searchParams.get("inning") || "0") || 0;

  // Incremental(delta) 폴링: 클라이언트가 이미 보유한 마지막 이닝 번호를 넘기면
  // 그 이닝 이후(현재/직전 이닝)만 돌려준다. 끝난 이닝의 play-by-play는 불변이라
  // 매 폴링마다 전체 이닝을 재전송할 필요가 없다 → origin transfer 절감.
  // 값이 없거나 0 이하이면 종전대로 전체 이닝을 반환한다(첫 로드/self-heal).
  const sinceInning = parseInt(req.nextUrl.searchParams.get("since") || "0") || 0;

  const naverGameId = toNaverGameId(gameId);

  // Cache hit short-circuits Naver upstream entirely.
  const cacheKey = `${naverGameId}-${inningHint}`;
  const cached = getCachedResponse(cacheKey);
  if (cached) {
    // warm cache HIT 에서도 since delta 를 적용한다(삼순 blocker ①). 캐시는 항상 full 을
    // 저장하므로 fresh 경로와 동일한 toDeltaResponse 로 partial 응답을 파생시켜
    // cache-hit 이 지난 이닝을 재전송하는 origin transfer 낙비를 막는다.
    //
    // 엣지 캐시 가능: setCachedResponse 는 !anyInningDegraded 일 때만 저장하므로
    // cache HIT 응답은 정의상 완전 정상 응답이다.
    //
    // 단 TTL 은 full 이 아니라 **남은 수명**만 준다(삼순 NO-GO 2026-08-06):
    // route 캐시에서 이미 소비한 age 를 엣지가 또 2초 얹으면 총 age 가 직렬로
    // 누적된다. 남은 수명이 1초 미만이면 no-store 로 fail-close.
    return NextResponse.json(toDeltaResponse(cached.data, sinceInning), {
      headers: edgeCacheHeadersForRemaining(cached.remainingMs, RELAY_EDGE_TTL_SECONDS),
    });
  }

  // fresh 경로 — 본문은 buildFresh 클로저로 묶어 single-flight로 공유한다.
  // 실패는 RelayUpstreamError로만 나가며(경보는 내부에서 1회 기록) GET 말미에서
  // 상태코드/바디로 변환된다.
  // arrow 함수여야 함: 호이스팅되는 function 선언은 앞선 gameId null-narrowing을
  // 잎어버려 타입이 깨진다(const narrowing은 생성 시점 이후 클로저에만 보존).
  const buildFresh = async (): Promise<{
    response: GameRelayResponse;
    anyInningDegraded: boolean;
  }> => {
  try {
    // First, fetch inning 1 to get the current inning number
    const firstRes = await fetch(
      `${NAVER_API_BASE}/${naverGameId}/relay?inning=1`,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; KboEveryday/1.0)",
        },
        cache: "no-store",
        signal: AbortSignal.timeout(10000),
      }
    );

    if (!firstRes.ok) {
      await trackApiDegradation("naver-relay", "http-error", {
        statusCode: firstRes.status,
        errorMessage: `HTTP ${firstRes.status} ${firstRes.statusText} (gameId=${gameId}, inning=1)`,
        scope: gameId,
      }, NAVER_RELAY_ALERT_POLICY);
      // inning-1 fetch failed = we have no current-inning info and no relays.
      // Return non-2xx so the client's useGameRelay (setData only on res.ok)
      // keeps its existing relay data and celebration trigger source instead of
      // being wiped to an empty 200 (which blanks the UI and stalls celebrations).
      throw new RelayUpstreamError(503, {
        error: "relay_upstream_http_error",
        upstreamStatus: firstRes.status,
      });
    }

    const firstData = (await firstRes.json()) as NaverRelayResponse;
    const naverInning = firstData.result?.textRelayData?.inn ?? 1;
    // 네이버 inn과 클라이언트 힌트 중 큰 값 사용 (네이버가 부정확할 때 대비)
    const currentInning = Math.max(naverInning, inningHint);

    // Cap at 15 innings (extended games)
    const maxInning = Math.min(currentInning, 15);

    // Fetch all innings in parallel (inning 1 already fetched).
    // A promise resolves to null ONLY on fetch failure (HTTP not-ok / network /
    // timeout); a successful fetch with no plays resolves to [] (legit empty).
    // This lets resolveInningWithSnapshot tell "failed → keep last-good" apart
    // from "succeeded but empty → adopt".
    const inningPromises: Promise<NaverTextRelay[] | null>[] = [];
    // 경보 계측 분리용: 이닝별 실패 종류 기록 (timeout / HTTP<status> / schema-empty / network).
    // 기존에는 전부 "timeout (cold/evicted)"으로 뭉개 기록돼 진단이 불가했다(2026-08-11).
    const inningFailures: string[] = [];

    // Use the already-fetched inning 1 data. A malformed 200 (result present but
    // textRelays missing / not an array) is a schema failure, NOT a legit empty
    // inning — resolve to null so the snapshot/unrecoverable path applies instead
    // of silently shrinking inning 1 to [] (which flips game-wide cumIdx).
    const firstRelaysRaw = firstData.result?.textRelayData?.textRelays;
    if (!Array.isArray(firstRelaysRaw)) inningFailures.push("inn1:schema-empty");
    inningPromises.push(
      Promise.resolve(
        Array.isArray(firstRelaysRaw) ? firstRelaysRaw : null,
      )
    );

    for (let i = 2; i <= maxInning; i++) {
      inningPromises.push(
        fetch(`${NAVER_API_BASE}/${naverGameId}/relay?inning=${i}`, {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; KboEveryday/1.0)",
          },
          cache: "no-store",
          // Bound each per-inning fetch so a single slow/hung Naver upstream
          // can't stall the whole Promise.all — that stall was the tail cause
          // of celebrations arriving 1–2min late (relay response never lands,
          // so the BoxScore-diff fallback fires much later). On timeout the
          // per-inning .catch yields [] and the next 5s poll recovers.
          signal: AbortSignal.timeout(RELAY_INNING_TIMEOUT_MS),
        })
          .then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json() as Promise<NaverRelayResponse>;
          })
          .then((data: NaverRelayResponse) => {
            // Malformed 200 (textRelays missing / not an array) is a schema
            // failure, not a legit empty inning → null so the snapshot path
            // applies. `?? []` would have shrunk this inning and flipped cumIdx.
            const relays = data?.result?.textRelayData?.textRelays;
            if (!Array.isArray(relays)) {
              inningFailures.push(`inn${i}:schema-empty`);
              return null;
            }
            return relays;
          })
          // Failure (timeout / HTTP not-ok / network / schema) → null so the
          // resolver falls back to this inning's last-good snapshot instead of
          // dropping its plays (which would renumber game-wide cumIdx and
          // duplicate celebrations on recovery). 실패 종류는 계측용으로 기록.
          .catch((e: unknown) => {
            const err = e as Error;
            const kind =
              err?.name === "TimeoutError"
                ? "timeout"
                : err?.message?.startsWith("HTTP")
                  ? err.message.replace(/\s+/g, "")
                  : "network";
            inningFailures.push(`inn${i}:${kind}`);
            return null;
          })
      );
    }

    // Fetch record API in parallel for accurate pitcher/batter stats with names
    const recordPromise = fetch(
      `${NAVER_API_BASE}/${naverGameId}/record`,
      {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; KboEveryday/1.0)" },
        cache: "no-store",
        // Same bound as per-inning fetches: record API is only used for
        // pitcher/batter names+stats, not celebration firing, so a hung
        // record fetch must never block the relay (celebration) response.
        signal: AbortSignal.timeout(RELAY_INNING_TIMEOUT_MS),
      }
    )
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);

    const [allTextRelaysResult, recordData] = await Promise.all([
      Promise.all(inningPromises),
      recordPromise,
    ]);

    // Resolve each inning against its last-good snapshot (pure, executed policy).
    const { relays: allTextRelays, anyDegraded: anyInningDegraded, anyUnrecoverable: anyInningUnrecoverable } =
      resolveAllInnings(inningSnapshotCache, naverGameId, allTextRelaysResult);
    evictInningSnapshotsIfLarge();

    // Cold instance / post-eviction first failure: an inning failed AND we have
    // no last-good snapshot for it. Substituting [] here would renumber game-wide
    // cumIdx and drop the current inning's plays (the original blocker). Return
    // non-2xx instead so the client keeps its existing relay data (celebration
    // IDs stay stable) and retries on the next 3s poll. Nothing is cached.
    if (anyInningUnrecoverable) {
      // 실패 종류를 분리 계측해 경보가 "무슨 실패인지"를 담는다. 기존에는 전부
      // timeout으로 기록돼 HTTP 404·스키마 공백까지 "timeout (cold/evicted)"로
      // 보였다(2026-08-11 진단 지연 원인).
      const reason: "timeout" | "http-error" | "schema-error" | "network-error" =
        inningFailures.some((f) => f.includes(":timeout"))
          ? "timeout"
          : inningFailures.some((f) => f.includes(":HTTP"))
            ? "http-error"
            : inningFailures.some((f) => f.includes(":schema-empty"))
              ? "schema-error"
              : "network-error";
      await trackApiDegradation("naver-relay", reason, {
        errorMessage: `no last-good snapshot (cold/evicted) gameId=${gameId} failures=[${inningFailures.join(",") || "unknown"}]`,
        scope: gameId,
      }, NAVER_RELAY_ALERT_POLICY);
      throw new RelayUpstreamError(503, {
        error: "relay_upstream_unrecoverable",
      });
    }

    // Combine all text relays with global newest-first ordering. Keeping
    // inning bundles in ascending order would make parseInningRelays reverse
    // the whole game into current→1회 order, flipping relay cumIdx for repeat
    // batter events and breaking cross-source dedupe.
    const combined = combineRelayInningsNewestFirst(allTextRelays);
    const innings = parseInningRelays(combined);

    // Extract current matchup stats from the latest batter entry
    // Use the last inning's raw data (newest first = first in array)
    const lastInningRelays = allTextRelays[allTextRelays.length - 1] ?? [];
    const matchup = extractMatchup(lastInningRelays);

    // Extract player stats: prefer record API (has pitcher names), fallback to relay parsing
    const playerStats = extractPlayerStatsFromRecord(recordData) ?? extractPlayerStats(combined);

    // 현재 타자 타순은 record API 라인업(교체 반영된 현재 라인업)을 SSOT로 재해석한다 —
    // 대타("대타 X"는 "N번타자" 접두가 없음)·대주자 교체에도 올바른 타순이 나오도록.
    // 매칭 실패 시 parser 값(batterRecord.batOrder)을 그대로 유지(fail-safe, 오표기 방지).
    for (const inn of innings) {
      if (!inn.currentAtBat) continue;
      const sideBatters = inn.half === "top" ? playerStats.awayBatters : playerStats.homeBatters;
      const lineupOrder = resolveBatOrderFromLineup(inn.currentAtBat.batterName, sideBatters);
      if (lineupOrder != null) inn.currentAtBat.batOrder = lineupOrder;
    }

    // Build linescore from naver relay data
    const trd = firstData.result?.textRelayData;

    // 현재 타석 투수↔타자 통산 맞대결 (relay 최상위 스냅샷 — inning 파라미터와 무관하게
    // 항상 최신 타석 기준). matchup이 없어도 통산값이 있으면 노출되도록 병합.
    const careerVsBatter = trd?.pitcherVsBatterCareerStats?.trim() || null;
    const matchupWithCareer: MatchupStats | undefined = careerVsBatter
      ? { ...(matchup ?? {}), careerVsBatter }
      : matchup;

    let linescore: RelayLinescore | undefined;
    if (trd?.inningScore && trd?.currentGameState) {
      const is = trd.inningScore;
      const gs = trd.currentGameState;
      const maxInn = Math.max(
        ...Object.keys(is.away || {}).map(Number).filter(n => !isNaN(n)),
        ...Object.keys(is.home || {}).map(Number).filter(n => !isNaN(n)),
        0
      );
      const awayInnings: (number | null)[] = [];
      const homeInnings: (number | null)[] = [];
      for (let i = 1; i <= maxInn; i++) {
        const ak = String(i);
        awayInnings.push(is.away?.[ak] != null ? parseInt(is.away[ak]) || 0 : null);
        homeInnings.push(is.home?.[ak] != null ? parseInt(is.home[ak]) || 0 : null);
      }
      linescore = {
        away: {
          innings: awayInnings,
          R: parseInt(gs.awayScore) || 0,
          H: parseInt(gs.awayHit) || 0,
          E: parseInt(gs.awayError) || 0,
        },
        home: {
          innings: homeInnings,
          R: parseInt(gs.homeScore) || 0,
          H: parseInt(gs.homeHit) || 0,
          E: parseInt(gs.homeError) || 0,
        },
      };
    }

    const response: GameRelayResponse = {
      gameId,
      currentInning: maxInning,
      innings,
      updatedAt: new Date().toISOString(),
      matchup: matchupWithCareer,
      playerStats,
      linescore,
    };

    // Only cache a fully-fresh response. If any inning fell back to a stale
    // snapshot (degraded), skip caching so the very next poll retries the
    // failed upstream immediately instead of serving stale data for the full
    // TTL — the current client still gets a consistent (stable-id) response.
    // 캐시는 항상 전체(full) 응답을 저장한다 — delta 응답은 요청마다 since가 달라
    // 캐시 오염 위험이 있고, delta는 full에서 순수함수로 파생된다.
    if (!anyInningDegraded) {
      setCachedResponse(cacheKey, response);
    }

    // Incremental delta: 클라이언트가 since를 보내면 그 이닝 이전(이미 보유한
    // 불변 이닝)은 생략하고 현재/직전 이닝만 내려보낸다. matchup/playerStats/
    // linescore/currentInning은 그대로(라이브) 유지 → 실시간 손실 0.
    // safety: 직전 이닝도 포함(since - 1)해 방금 끝난 이닝의 지연 play 반영.
    // cache-hit 경로와 동일한 toDeltaResponse 로 delta 의미를 일치시킨다(since<=0 면 full).
    //
    // 엣지 캐시는 route 내부 캐시와 **정확히 같은 조건**으로 건다. degraded 응답을
    // 엣지에 올리면 TTL 동안 열화 응답이 고정되어 다음 폴링의 자가복구를 막는다
    // (부분 실패 시 last-good 을 내보내되 캐시에는 올리지 않는 계약).
    return { response, anyInningDegraded };
  } catch (e) {
    // buildFresh 내부에서 이미 경보·분류를 끝낸 typed error는 그대로 전파.
    if (e instanceof RelayUpstreamError) throw e;
    const error = e as Error;
    let reason: "timeout" | "http-error" | "schema-error" | "network-error" = "network-error";
    if (error.name === "TimeoutError" || error.message?.includes("timeout")) {
      reason = "timeout";
    } else if (error.message?.includes("HTTP")) {
      reason = "http-error";
    } else if (error.message?.includes("JSON")) {
      reason = "schema-error";
    }

    await trackApiDegradation("naver-relay", reason, {
      errorMessage: `${error.message} (gameId=${gameId})`,
      scope: gameId,
    }, NAVER_RELAY_ALERT_POLICY);

    // Any uncaught failure (inning-1 timeout/network, JSON parse, etc.) surfaces
    // as non-2xx — NOT an empty 200. An empty 200 would wipe the client's existing
    // relay data (setData only fires on res.ok) and blank the celebration
    // trigger source; non-2xx keeps the last good data and retries next poll.
    throw new RelayUpstreamError(503, { error: `relay_upstream_${reason}` });
  }
  }

  // Single-flight: 이미 진행 중인 동일 (naverGameId, inningHint) fresh 작업이 있으면
  // 그 promise를 공유하고, 없으면 리더로서 생성한다. 완료/실패 시 맵에서 제거해
  // 다음 폴링은 새 업스트림 시도를 하게 한다(실패 고정 방지).
  let shared = inflightFresh.get(cacheKey);
  if (!shared) {
    shared = buildFresh();
    inflightFresh.set(cacheKey, shared);
    void shared
      .catch(() => undefined)
      .finally(() => {
        inflightFresh.delete(cacheKey);
      });
  }

  try {
    const { response, anyInningDegraded } = await shared;
    // 이 인스턴스가 직전에 경보를 보냈다면(전역 claim 승자) 복구 알림을 1회 보낸다.
    // 경보 이력이 없는 인스턴스는 in-memory 체크 1회로 즉시 반환(비용 0).
    // ⚠️ degraded(last-good 대체) 200은 복구가 아니다 — 일부 이닝이 여전히
    // 실패 중이므로 완전 정상(!anyInningDegraded)일 때만 복구로 처리한다
    // (삼순 Blocker 1: 장애 중 ✅ 오보 방지).
    if (!anyInningDegraded) {
      // scope=gameId: 경보를 유발한 바로 그 경기가 정상으로 돌아왔을 때만 복구로
      // 인정한다(삼순 2차 ③). 응답 후 실행 — Telegram 최대 8초 timeout이
      // 복구 직후 첫 사용자 응답을 막지 않게 한다(삼순 3차 ②).
      runAfterResponse(() => markApiRecovered("naver-relay", gameId));
    }
    // 엣지 캡시는 route 내부 캐시와 **정확히 같은 조건**으로 건다. degraded 응답을
    // 엣지에 올리면 TTL 동안 열화 응답이 고정되어 다음 폴링의 자가복구를 막는다.
    // degraded 명시 헤더(삼순 #1331 NO-GO ①)는 buildRelayJsonResponse(producer seam 순수
    // 함수)가 부착한다 — 게이트가 이 함수를 직접 실행해 양방향 검증(헤더 삭제·오타
    // mutation 이 실행으로 RED). 이 경로에서 NextResponse.json 직접 호출 금지.
    return buildRelayJsonResponse(
      toDeltaResponse(response, sinceInning),
      liveCacheHeaders(!anyInningDegraded, RELAY_EDGE_TTL_SECONDS),
      anyInningDegraded,
    );
  } catch (e) {
    if (e instanceof RelayUpstreamError) {
      return NextResponse.json(e.body, {
        status: e.status,
        headers: NO_STORE_HEADERS,
      });
    }
    // buildFresh가 모든 예외를 RelayUpstreamError로 정규화하므로 여기는 방어적 최후단.
    return NextResponse.json(
      { error: "relay_internal_error" },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}
