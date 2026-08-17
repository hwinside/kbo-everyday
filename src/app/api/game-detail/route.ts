import { NextRequest, NextResponse, after } from "next/server";
import {
  fetchKboGamesOnly,
  parseGameLinescoreResponse,
  type KboGame,
} from "@/lib/crawler/kbo-api";
import { jsonWithETag } from "@/lib/http/conditional";
import { memoizeByContentHash } from "@/lib/http/parse-memo";
import { GAME_ID_FORMAT_HINT, isCanonicalKboGameId } from "@/lib/game/game-id";
import type { BroadcastChannel } from "@/lib/broadcast-channels";
import { resolvePlayer } from "@/lib/utils/resolve-player";
import { fetchNaverRelayBatterCounts } from "@/lib/naver-relay-counts";
import { hasPureSubPositions, mergeNaverSubPositions } from "@/lib/utils/sub-position-merge";
import {
  naverGameId,
  parseNaverBoxScore,
  parseNaverScoreBoardLinescore,
} from "@/lib/crawler/naver-record";
import { fetchNaverGames } from "@/lib/crawler/naver-games";
import {
  fetchKboSessionCookie,
  withKboSessionCookie,
} from "@/lib/crawler/kbo-session";
import {
  fetchNaverLineup,
  fetchNaverPreviewStarters,
  type NaverLineupSide,
} from "@/lib/crawler/naver-lineup";

/** 숫자 kboId로 로스터 조회 — 외국인 숫자→영문 변환 포함 */
function findPlayerByNumericId(numericId: string): { name: string } | undefined {
  const resolved = resolvePlayer(String(numericId));
  return resolved ? { name: resolved.name } : undefined;
}

// ===== Types =====

export interface GameDetailResponse {
  gameId: string;
  status: "scheduled" | "live" | "final" | "cancelled";
  meta: {
    stadium: string;
    crowd: string | null;
    startTime: string | null;
    endTime: string | null;
    duration: string | null;
    broadcastChannels?: BroadcastChannel[];
  } | null;
  linescore: {
    away: { innings: (number | null)[]; R: number; H: number; E: number };
    home: { innings: (number | null)[]; R: number; H: number; E: number };
  } | null;
  lineup: {
    isToday: boolean;
    away: LineupEntry[];
    home: LineupEntry[];
    /** Naver preview 폴백 시에만 채움 — KBO boxScore/경기목록 starter 가 함께 죽었을 때 UI 선발 표기용. */
    awayStarter?: string;
    homeStarter?: string;
  } | null;
  boxScore: {
    awayBatters: BatterRecord[];
    homeBatters: BatterRecord[];
    awayPitchers: PitcherRecord[];
    homePitchers: PitcherRecord[];
  } | null;
  trace?: {
    sourceAtMs: number;
    fetchedAtMs: number;
    lineupSource: "none" | "kbo-unconfirmed" | "kbo-confirmed" | "naver-preview" | "naver-confirmed";
    boxScoreSource: "none" | "kbo" | "naver";
  };
}

export interface LineupEntry {
  order: number;
  position: string;
  positionKr: string;
  name: string;
  war: number;
  avg: string;
}

export interface BatterRecord {
  order: number;
  position: string;
  positionFull: string;
  name: string;
  atBats: number;
  hits: number;
  runs: number;
  rbi: number;
  hr: number;
  h2b: number;
  h3b: number;
  bb: number;
  so: number;
  sb: number;
  avg: string;
  isSubstitute: boolean;
  /** KBO 타석 결과 셀 수(안타/아웃/볼넷/HBP/희생/실책 포함). 라이브 첫 타석 cutoff용. */
  plateAppearances?: number;
}

export interface PitcherRecord {
  name: string;
  inningsPitched: string;
  decision: string;
  pitchCount: number;
  hits: number;
  runs: number;
  hr: number;
  strikeouts: number;
  walks: number;
  earnedRuns: number;
  battersFaced: number;
  atBats: number;
  era: string;
}

type DegradationReason = "timeout" | "http-error" | "schema-error" | "network-error";
interface DetailDegradationEvent {
  apiName: "kbo-game-detail" | "game-detail-dual-source-outage";
  reason: DegradationReason;
}
let degradationObserverForTest: ((event: DetailDegradationEvent) => void) | null = null;

/** actual GET 관제 분기 회귀에서만 사용. production 호출부는 등록하지 않는다. */
export function setGameDetailDegradationObserverForTest(
  observer: ((event: DetailDegradationEvent) => void) | null,
): void {
  degradationObserverForTest = observer;
}

// ===== Position mapping =====

const POS_MAP: Record<string, string> = {
  "투수": "P", "포수": "C", "1루수": "1B", "2루수": "2B",
  "3루수": "3B", "유격수": "SS", "좌익수": "LF", "중견수": "CF",
  "우익수": "RF", "지명타자": "DH",
  "타지": "DH", "타좌": "LF", "타우": "RF", "타중": "CF",
  "타1": "1B", "타2": "2B", "타3": "3B", "타유": "SS", "타포": "C",
  "주좌": "LF", "주우": "RF", "주중": "CF", "주1": "1B", "주2": "2B", "주3": "3B", "주유": "SS",
  "대타": "DH", "대주": "DH",
};

// BoxScore 약어 → 풀네임 매핑
const POS_FULL: Record<string, string> = {
  "투": "투수", "포": "포수", "一": "1루수", "二": "2루수",
  "三": "3루수", "유": "유격수", "좌": "좌익수", "중": "중견수",
  "우": "우익수", "지": "지명타자",
  // 복합/교체 약어
  "타지": "대타·지명", "타좌": "대타·좌익", "타우": "대타·우익", "타중": "대타·중견",
  "타1": "대타·1루", "타2": "대타·2루", "타3": "대타·3루", "타유": "대타·유격", "타포": "대타·포수",
  "주좌": "대주·좌익", "주우": "대주·우익", "주중": "대주·중견",
  "주1": "대주·1루", "주2": "대주·2루", "주3": "대주·3루", "주유": "대주·유격",
  "타": "대타", "주": "대주",
  // 복합 포지션 (二유, 一二 등)
  "二유": "2루·유격", "유二": "유격·2루", "一二": "1루·2루",
  "중우": "중견·우익", "우중": "우익·중견",
};

function positionFullName(abbr: string): string {
  if (POS_FULL[abbr]) return POS_FULL[abbr];
  // Try splitting compound positions (e.g., "二유" → each char)
  const parts = abbr.split("").map(c => {
    const full: Record<string, string> = {
      "投": "투수", "捕": "포수", "一": "1루", "二": "2루",
      "三": "3루", "유": "유격", "좌": "좌익", "중": "중견",
      "우": "우익", "지": "지명",
    };
    return full[c] || c;
  });
  return parts.join("·") || abbr;
}

const KBO_BASE = "https://www.koreabaseball.com/ws/Schedule.asmx";
/** 경기상세의 모든 upstream(KBO 3종·srId retry·양쪽 경기목록·Naver record)이 공유하는 절대 상한. */
export const USER_FACING_GAME_DETAIL_DEADLINE_MS = 3000;
// 2026-05-20: KBO가 Referer가 koreabaseball.com이 아닌 요청에 IE 분기 HTML 에러 페이지 반환 → JSON 파싱 실패.
const HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded",
  "User-Agent": "Mozilla/5.0 (compatible; KboEveryday/1.0)",
  "Referer": "https://www.koreabaseball.com/Schedule/ScoreBoard.aspx",
};

// ===== Helpers =====

function safeInt(v: unknown): number {
  if (v == null || v === "" || v === "&nbsp;") return 0;
  const n = parseInt(String(v), 10);
  return isNaN(n) ? 0 : n;
}

function safeStr(v: unknown): string {
  if (v == null) return "";
  const s = String(v).trim();
  return s === "&nbsp;" ? "" : s;
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, "").trim();
}

// ===== Parsers =====

function parseScoreBoardImpl(data: unknown[]): {
  meta: GameDetailResponse["meta"];
  linescore: GameDetailResponse["linescore"];
  status: GameDetailResponse["status"];
} {
  if (!Array.isArray(data) || data.length === 0) {
    return { meta: null, linescore: null, status: "scheduled" };
  }

  // data[0] = meta array
  const metaArr = data[0];
  const m = Array.isArray(metaArr) && metaArr.length > 0 ? metaArr[0] : null;

  let status: GameDetailResponse["status"] = "scheduled";
  if (m) {
    const cancelNm = safeStr(m.CANCEL_SC_NM);
    const endTm = safeStr(m.END_TM);
    if (cancelNm.includes("취소") || cancelNm.includes("우천")) {
      status = "cancelled";
    } else if (endTm) {
      // END_TM이 있으면 경기 종료
      status = "final";
    } else if (safeInt(m.T_SCORE_CN) > 0 || safeInt(m.B_SCORE_CN) > 0) {
      status = "live";
    }
  }

  const meta: GameDetailResponse["meta"] = m ? {
    stadium: safeStr(m.STADIUM_NM) || safeStr(m.S_NM),
    crowd: safeStr(m.CROWD_CN) || null,
    startTime: safeStr(m.GAME_START_TM) || null,
    endTime: safeStr(m.GAME_END_TM) || null,
    duration: safeStr(m.USE_TM) || null,
  } : null;

  const sharedLinescore = parseGameLinescoreResponse(data);
  return {
    meta,
    linescore: sharedLinescore
      ? { away: sharedLinescore.away, home: sharedLinescore.home }
      : null,
    status: sharedLinescore?.status ?? status,
  };
}

function parseLineupImpl(data: unknown[]): GameDetailResponse["lineup"] {
  if (!Array.isArray(data) || data.length < 5) return null;

  // data[0] = [{LINEUP_CK: true/false}]
  const ckArr = data[0];
  const isToday = Array.isArray(ckArr) && ckArr.length > 0 ? !!ckArr[0].LINEUP_CK : false;

  function parseLineupRows(raw: unknown): LineupEntry[] {
    let parsed: { rows: { row: { Text: string }[] }[] };
    try {
      const val = Array.isArray(raw) && raw.length > 0 ? raw[0] : raw;
      parsed = typeof val === "string" ? JSON.parse(val) : val;
    } catch {
      return [];
    }
    if (!parsed?.rows) return [];
    return parsed.rows.map(r => {
      const cells = r.row.map(c => safeStr(c.Text));
      const posKr = stripHtml(cells[1] || "");
      return {
        order: safeInt(cells[0]),
        position: POS_MAP[posKr] || posKr,
        positionKr: posKr,
        name: stripHtml(cells[2] || ""),
        war: parseFloat(cells[3] || "0") || 0,
        avg: "",  // lineup API에는 타율 없음 (cells[3]은 WAR). boxScore에서 merge
      };
    }).filter(e => e.name !== "");
  }

  // KBO returns: data[1]=HOME team, data[3]=HOME lineup; data[2]=AWAY team, data[4]=AWAY lineup
  const home = parseLineupRows(data[3]);
  const away = parseLineupRows(data[4]);

  if (away.length === 0 && home.length === 0) return null;

  // 데이터 레이어는 raw 그대로 리턴 (isToday 플래그 포함).
  // 미확정 경기에 대해 KBO가 직전 라인업을 fallback으로 돌려주는 패턴이 있지만,
  // gate는 소비 측(page / LineupTab / lineup-analysis POST)에서 isToday===true로 판정함.
  return { isToday, away, home };
}

function parseBoxScoreImpl(data: unknown): GameDetailResponse["boxScore"] {
  const obj = data as { tables?: unknown[]; code?: string };
  if (!obj?.tables || !Array.isArray(obj.tables) || obj.tables.length < 5) return null;

  // Parse stolen bases from key plays table (table[0])
  const sbMap = new Map<string, number>();
  const keyPlaysTable = obj.tables[0] as { rows?: { row: { Text: string }[] }[] };
  if (keyPlaysTable?.rows) {
    for (const r of keyPlaysTable.rows) {
      const cells = r.row.map(c => safeStr(c.Text));
      if (stripHtml(cells[0]) === "도루") {
        // Format: "송찬의2(2회) 이영빈(2회) 최원영(8회)"
        const text = stripHtml(cells[1] || "");
        const matches = text.matchAll(/([가-힣]+?)(\d*)\(/g);
        for (const m of matches) {
          const name = m[1];
          const count = m[2] ? parseInt(m[2]) : 1;
          sbMap.set(name, (sbMap.get(name) || 0) + count);
        }
      }
    }
  }

  function parseBatters(table: { rows?: { row: { Text: string }[] }[] }, sbLookup: Map<string, number>): BatterRecord[] {
    if (!table?.rows) return [];
    let prevOrder = -1;
    return table.rows.map(r => {
      const cells = r.row.map(c => safeStr(c.Text));
      // Last 5 columns = 타수, 안타, 득점, 타점, 타율
      const tail = cells.slice(cells.length - 5);
      // Middle columns (3 to length-5) = at-bat results
      const atBatResults = cells.slice(3, cells.length - 5).map(c => stripHtml(c)).filter(c => c && c !== "&nbsp;");

      // Count HR/2B/3B/BB/SO from at-bat results
      let hr = 0, h2b = 0, h3b = 0, bb = 0, so = 0;
      for (const ab of atBatResults) {
        if (ab.includes("홈")) hr++;
        else if (ab.includes("3루타") || ab.includes("삼루타")) h3b++;
        else if (ab.includes("2루타") || ab.includes("이루타")) h2b++;
        if (ab === "4구") bb++;
        // 사구(死球) = HBP, not BB — don't count as walk
        if (ab.includes("삼진")) so++;
      }

      const rawOrder = safeInt(stripHtml(cells[0]));
      const posRaw = stripHtml(cells[1] || "");
      // KBO BoxScore는 대타/대주자 row의 타순 셀을 비우거나(rawOrder=0) 같은 번호로
      // 반복하는 두 가지 형태를 모두 사용. 둘 다 substitute로 간주하고, 빈 셀이면
      // 직전 row의 타순을 그대로 이어붙여 베이스 룩업이 가능하도록 한다.
      const isSubstitute = rawOrder === 0 || rawOrder === prevOrder || posRaw.startsWith("타") || posRaw.startsWith("주") || posRaw.startsWith("대");
      const order = isSubstitute && rawOrder === 0 && prevOrder > 0 ? prevOrder : rawOrder;
      if (order > 0) prevOrder = order;

      // KBO header order: [타수, 안타, 타점, 득점, 타율]
      return {
        order,
        position: POS_MAP[posRaw] || posRaw,
        positionFull: positionFullName(posRaw),
        name: stripHtml(cells[2] || ""),
        atBats: safeInt(stripHtml(tail[0])),
        hits: safeInt(stripHtml(tail[1])),
        rbi: safeInt(stripHtml(tail[2])),
        runs: safeInt(stripHtml(tail[3])),
        hr,
        h2b,
        h3b,
        bb,
        so,
        sb: sbLookup.get(stripHtml(cells[2] || "")) || 0,
        avg: stripHtml(tail[4]) || ".000",
        isSubstitute,
        plateAppearances: atBatResults.length,
      };
    }).filter(b => b.name !== "").map(b => {
      // KBO sometimes returns player IDs instead of names
      if (/^\d+$/.test(b.name)) {
        const player = findPlayerByNumericId(b.name);
        b.name = player ? player.name : `선수(${b.name.slice(-3)})`;
      }
      return b;
    });
  }

  function parsePitchers(table: { rows?: { row: { Text: string }[] }[] }): PitcherRecord[] {
    if (!table?.rows) return [];
    // KBO BoxScore columns:
    // [0]선수명, [1]등판(선발/IP), [2]결과, [3]승, [4]패, [5]세,
    // [6]이닝, [7]타자, [8]투구수, [9]타수, [10]피안타, [11]홈런,
    // [12]4사구, [13]삼진, [14]실점, [15]자책, [16]평균자책
    return table.rows.map(r => {
      const cells = r.row.map(c => safeStr(c.Text));
      // [1]=등판 (선발/"5.9" 등판이닝), [6]=이닝 (투구이닝)
      // IP is ALWAYS in [6] regardless of starter/reliever
      const ip = stripHtml(cells[6] || "");
      return {
        name: stripHtml(cells[0] || ""),
        inningsPitched: ip,
        decision: stripHtml(cells[2] || ""),
        battersFaced: safeInt(stripHtml(cells[7])),
        pitchCount: safeInt(stripHtml(cells[8])),
        atBats: safeInt(stripHtml(cells[9])),
        hits: safeInt(stripHtml(cells[10])),
        hr: safeInt(stripHtml(cells[11])),
        walks: safeInt(stripHtml(cells[12])),
        strikeouts: safeInt(stripHtml(cells[13])),
        runs: safeInt(stripHtml(cells[14])),
        earnedRuns: safeInt(stripHtml(cells[15])),
        era: stripHtml(cells[16] || "") || "0.00",
      };
    }).filter(p => p.name !== "").map(p => {
      // KBO sometimes returns player IDs instead of names for foreign players
      if (/^\d+$/.test(p.name)) {
        const player = findPlayerByNumericId(p.name);
        p.name = player ? player.name : `선수(${p.name.slice(-3)})`;
      }
      return p;
    });
  }

  const tables = obj.tables as { rows?: { row: { Text: string }[] }[] }[];

  return {
    awayBatters: parseBatters(tables[1], sbMap),
    homeBatters: parseBatters(tables[2], sbMap),
    awayPitchers: parsePitchers(tables[3]),
    homePitchers: parsePitchers(tables[4]),
  };
}

// ===== Naver record API fallback =====

const NAVER_API = "https://api-gw.sports.naver.com/schedule/games";

const POS_SHORT_TO_FULL: Record<string, string> = {
  "투": "P", "포": "C", "1": "1B", "2": "2B", "3": "3B",
  "유": "SS", "좌": "LF", "중": "CF", "우": "RF", "지": "DH",
};

// raw content-hash bounded memoize (삼순 A안, Fluid CPU 절감).
// upstream raw 조회는 매 요청 그대로(최신성 유지)고, 동일 raw(KBO next:{revalidate} 캐시로
// 동시 시청자가 공유)의 순수 파싱만 1회로 접는다. raw가 바뀌면 키가 바뀜 즉시 재계산해
// staleness 0. 결과는 deepFreeze되므로 downstream mergeAvg 등은 새 객체를 만들어 읽기만 한다.
const parseScoreBoard = memoizeByContentHash(parseScoreBoardImpl);
const parseLineup = memoizeByContentHash(parseLineupImpl);
const parseBoxScore = memoizeByContentHash(parseBoxScoreImpl);

function countNaverRecordExtraBaseHits(batter: Record<string, unknown>): {
  h2b: number;
  h3b: number;
  hr: number;
} {
  let h2b = 0;
  let h3b = 0;
  let hr = 0;
  for (const [key, raw] of Object.entries(batter)) {
    if (!/^inn\d+$/.test(key) || typeof raw !== "string") continue;
    for (const result of raw.split("/").map((value) => value.trim()).filter(Boolean)) {
      // Naver record shorthand: 좌2/우중2, 우3, 좌홈. "2땅"/"3안"처럼
      // 수비 위치 숫자로 시작하는 결과와 혼동하지 않도록 끝 토큰만 판정한다.
      if (/홈(?:런)?$/.test(result)) hr++;
      else if (/(?:3|3루타)$/.test(result)) h3b++;
      else if (/(?:2|2루타)$/.test(result)) h2b++;
    }
  }
  return { h2b, h3b, hr };
}

export async function fetchNaverRecord(
  kboGameId: string,
  opts?: { signal?: AbortSignal; includeRelayCounts?: boolean },
): Promise<{
  boxScore: GameDetailResponse["boxScore"];
  linescore: GameDetailResponse["linescore"];
} | null> {
  try {
    const nId = naverGameId(kboGameId);
    // record API는 hit만 채우고 h2/h3는 항상 null, hr도 라이브 중 0으로 들어와서
    // 2루타/3루타가 단타로 뭉개진다. relay textRelayData에서 결과 텍스트를
    // 카운트해서 batter별 h2b/h3b/hr를 보강.
    const [res, relayCounts] = await Promise.all([
      fetch(`${NAVER_API}/${nId}/record`, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; KboEveryday/1.0)" },
        next: { revalidate: 30 },
        signal: opts?.signal,
      }),
      opts?.includeRelayCounts === false
        ? Promise.resolve(new Map())
        : fetchNaverRelayBatterCounts(nId, { signal: opts?.signal }).catch(() => new Map()),
    ]);
    if (!res.ok) return null;
    const json = await res.json();
    const rd = json?.result?.recordData;
    if (!rd) return null;

    function toBatters(arr: Record<string, unknown>[]): BatterRecord[] {
      return (arr || []).map((b) => {
        const name = String(b.name || "");
        const relay = relayCounts.get(name);
        const record = countNaverRecordExtraBaseHits(b);
        return {
          order: Number(b.batOrder) || 0,
          position: POS_SHORT_TO_FULL[String(b.pos)] || String(b.pos || ""),
          positionFull: positionFullName(String(b.pos || "")),
          name,
          atBats: Number(b.ab) || 0,
          hits: Number(b.hit) || 0,
          runs: Number(b.run) || 0,
          rbi: Number(b.rbi) || 0,
          // record가 정확하면 그대로, 비어있으면 relay 카운트로 보강.
          hr: Math.max(Number(b.hr) || 0, record.hr, relay?.hr ?? 0),
          h2b: Math.max(Number(b.h2) || 0, record.h2b, relay?.h2b ?? 0),
          h3b: Math.max(Number(b.h3) || 0, record.h3b, relay?.h3b ?? 0),
          bb: Number(b.bb) || 0,
          so: Number(b.kk) || 0,
          sb: Number(b.sb) || 0,
          avg: String(b.hra || ""),
          isSubstitute: Number(b.batOrder) === 0,
        };
      });
    }

    const canonicalBox = parseNaverBoxScore(rd);
    const boxScore: GameDetailResponse["boxScore"] = canonicalBox ? {
      awayBatters: toBatters(rd.battersBoxscore.away),
      homeBatters: toBatters(rd.battersBoxscore.home),
      awayPitchers: canonicalBox.awayPitchers.map((pitcher, index) => ({
        ...pitcher,
        battersFaced: Number(rd.pitchersBoxscore.away[index]?.pa) || 0,
        atBats: Number(rd.pitchersBoxscore.away[index]?.ab) || 0,
      })),
      homePitchers: canonicalBox.homePitchers.map((pitcher, index) => ({
        ...pitcher,
        battersFaced: Number(rd.pitchersBoxscore.home[index]?.pa) || 0,
        atBats: Number(rd.pitchersBoxscore.home[index]?.ab) || 0,
      })),
    } : null;

    // Linescore from scoreBoard (summary canonical source 와 공용 파서).
    const linescore: GameDetailResponse["linescore"] = parseNaverScoreBoardLinescore(rd.scoreBoard);

    return boxScore || linescore ? { boxScore, linescore } : null;
  } catch {
    return null;
  }
}

/**
 * Naver preview 라인업 fallback — KBO GetLineUpAnalysis 전면 열화(204/빈응답) 시 표시용.
 * 공용 어댑터(naver-lineup.ts)의 완전 라인업 스냅샷(양팀 선발1+타자9 검증 통과)만 사용하고,
 * 선발투수 이름은 awayStarter/homeStarter 로 보존해 UI(boxScore/경기목록 starter 부재 시)에
 * 전달한다(삼순 PR#988 P0-1). 완전 라인업 존재 자체가 확정 신호라 isToday=true 로 반환해도
 * stale 라인업 오표시 위험이 없다(경기별 gameId 조회이므로 어제 라인업 fallback 패턴 없음).
 */
export async function fetchNaverDetailLineup(
  kboGameId: string,
  opts?: { signal?: AbortSignal },
): Promise<GameDetailResponse["lineup"]> {
  const snap = await fetchNaverLineup(kboGameId, { signal: opts?.signal });
  if (!snap) return null;
  const toEntries = (side: NaverLineupSide): LineupEntry[] =>
    side.batters.map((b) => ({
      order: b.order,
      position: b.position,
      positionKr: b.positionKr,
      name: b.name,
      war: 0, // preview 에는 WAR 없음
      avg: "", // boxScore merge 경로에서 채움 (KBO lineup 과 동일 계약)
    }));
  return {
    isToday: true,
    away: toEntries(snap.away),
    home: toEntries(snap.home),
    awayStarter: snap.away.starter,
    homeStarter: snap.home.starter,
  };
}

// ===== Route handler =====

function untilDeadline<T>(promise: Promise<T>, signal: AbortSignal, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: T) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => finish(fallback);
    promise.then(finish, () => finish(fallback));
    if (signal.aborted) {
      // 이미 settle된 병렬 fallback은 deadline 직후라도 먼저 회수한다.
      queueMicrotask(onAbort);
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function reportDetailDegradation(
  gameId: string,
  bothSourcesUnavailable: boolean,
  reason: DegradationReason,
): void {
  const apiName = bothSourcesUnavailable ? "game-detail-dual-source-outage" : "kbo-game-detail";
  const policy = bothSourcesUnavailable
    ? { windowMinutes: 5, threshold: 1, cooldownMinutes: 10, leaseSeconds: 120 }
    : { windowMinutes: 5, threshold: 3, cooldownMinutes: 30, leaseSeconds: 120 };
  degradationObserverForTest?.({ apiName, reason });
  try {
    // 관제 저장·알림은 응답 이후 실행해 사용자 deadline을 소비하지 않는다.
    after(async () => {
      const { trackApiDegradation } = await import("@/lib/monitoring/api-fallback-tracker");
      await trackApiDegradation(
        apiName,
        reason,
        { errorMessage: `${gameId}: bounded game-detail fallback` },
        policy,
      );
    });
  } catch {
    // 직접 함수 호출 스모크처럼 Next request context가 없는 환경에서는 관제를 생략한다.
  }
}

export async function GET(req: NextRequest) {
  const sourceAtMs = Date.now();
  const gameId = req.nextUrl.searchParams.get("gameId");
  if (!gameId) {
    return NextResponse.json({ error: "gameId is required" }, { status: 400 });
  }
  // canonical 형식이 아니면 업스트림 도달 전 400 fail-close(2026-08-11 오판 사고
  // 재발 방지 — src/lib/game/game-id.ts 주석 참조).
  if (!isCanonicalKboGameId(gameId)) {
    return NextResponse.json(
      { error: "invalid gameId format", hint: GAME_ID_FORMAT_HINT },
      { status: 400 },
    );
  }

  const seasonId = req.nextUrl.searchParams.get("seasonId") || new Date().getFullYear().toString();
  const deadlineSignal = AbortSignal.timeout(USER_FACING_GAME_DETAIL_DEADLINE_MS);
  const dateStr = gameId.slice(0, 8);
  const kboSessionPromise = fetchKboSessionCookie(deadlineSignal);

  // 양쪽 fallback을 요청 시작과 동시에 준비한다. KBO timeout 뒤 새 budget을 시작하지 않고,
  // 모든 작업이 위 단일 절대 deadline을 공유한다.
  // eager fallback은 record 1회만 준비한다. relay 전이닝 fanout은 매 폴링마다 증폭되므로
  // KBO 정상경로에서는 실행하지 않는다. record의 inn1..inn25 셀에서 XBH를 무추가요청
  // 복원하므로 fallback celebration semantic id도 relay 경로와 일치한다.
  const naverRecordPromise = fetchNaverRecord(gameId, {
    signal: deadlineSignal,
    includeRelayCounts: false,
  });
  // 라인업도 record 와 같이 eager 준비(revalidate 60 캐시로 fanout 억제). KBO blackhole 로
  // deadline 이 전부 소진돼도 병렬로 이미 settle 된 결과를 회수할 수 있게 한다.
  const naverLineupPromise = fetchNaverDetailLineup(gameId, { signal: deadlineSignal });
  const naverStartersPromise = fetchNaverPreviewStarters(gameId, { signal: deadlineSignal });
  const reasonFor = (error: unknown): DegradationReason => {
    const e = error as { name?: string; message?: string };
    if (e?.name === "TimeoutError" || /timeout|deadline/i.test(e?.message ?? "")) return "timeout";
    if (/HTTP/i.test(e?.message ?? "")) return "http-error";
    if (/JSON|schema/i.test(e?.message ?? "")) return "schema-error";
    return "network-error";
  };
  type ObservedGames = { value: KboGame[] | null; reason: DegradationReason | null };
  const kboListPromise: Promise<ObservedGames> =
    fetchKboGamesOnly(dateStr, "0,1,3,4,5,7,9", { signal: deadlineSignal })
      .then((value) => ({ value, reason: null }))
      .catch((error) => ({ value: null, reason: reasonFor(error) }));
  const naverListPromise: Promise<ObservedGames> =
    fetchNaverGames(dateStr, undefined, { signal: deadlineSignal })
      .then((value) => ({ value, reason: null }))
      .catch((error) => ({ value: null, reason: reasonFor(error) }));

  // KBO Schedule API (GetScoreBoard/GetBoxScore/GetLineUpAnalysis) only accepts
  // a single integer srId — NOT comma-separated like GetKboGameList.
  // Try srId=0 (regular) first; if ScoreBoard returns empty, retry with srId=1 (preseason).
  const overrideSrId = req.nextUrl.searchParams.get("srId");

  async function fetchWithSrId(srId: string) {
    const body = `leId=1&srId=${srId}&seasonId=${seasonId}&gameId=${gameId}`;
    const sessionCookie = await kboSessionPromise;
    const fetchKboJson = async (path: string, revalidate: number) => {
      try {
        const response = await fetch(`${KBO_BASE}/${path}`, {
          method: "POST",
          headers: withKboSessionCookie(HEADERS, sessionCookie),
          body,
          next: { revalidate },
          signal: deadlineSignal,
        });
        if (!response.ok) {
          return { data: null, reason: "http-error" as const };
        }
        return { data: await response.json(), reason: null };
      } catch (error) {
        return { data: null, reason: reasonFor(error) };
      }
    };
    const results = await Promise.all([
      fetchKboJson("GetScoreBoard", 10),
      fetchKboJson("GetLineUpAnalysis", 60),
      fetchKboJson("GetBoxScore", 30),
    ]);
    return {
      data: results.map((result) => result.data),
      reasons: results.flatMap((result) => result.reason ? [result.reason] : []),
    };
  }

  try {
    let lineupSource: NonNullable<GameDetailResponse["trace"]>["lineupSource"] = "none";
    let boxScoreSource: NonNullable<GameDetailResponse["trace"]>["boxScoreSource"] = "none";
    const timeoutBatch = {
      data: [null, null, null],
      reasons: ["timeout" as DegradationReason],
    };
    let kboBatch = overrideSrId
      ? await untilDeadline(fetchWithSrId(overrideSrId), deadlineSignal, timeoutBatch)
      : await untilDeadline(fetchWithSrId("0"), deadlineSignal, timeoutBatch);
    let [scoreBoardRes, lineupRes, boxScoreRes] = kboBatch.data;

    // If no override and srId=0 returned empty ScoreBoard, retry with srId=1 (preseason)
    if (!overrideSrId && !deadlineSignal.aborted) {
      const sb = parseScoreBoard(scoreBoardRes ?? []);
      if (!sb.meta) {
        const retryBatch = await untilDeadline(
          fetchWithSrId("1"),
          deadlineSignal,
          timeoutBatch,
        );
        kboBatch = {
          data: retryBatch.data,
          reasons: [...kboBatch.reasons, ...retryBatch.reasons],
        };
        [scoreBoardRes, lineupRes, boxScoreRes] = kboBatch.data;
      }
    }

    const parsedScoreBoard = parseScoreBoard(scoreBoardRes ?? []);
    let meta = parsedScoreBoard.meta;
    const { linescore: kboLinescore, status: scoreBoardStatus } = parsedScoreBoard;
    let lineup = parseLineup(lineupRes ?? []);
    if (lineup) lineupSource = lineup.isToday ? "kbo-confirmed" : "kbo-unconfirmed";
    // KBO GetLineUpAnalysis 열화(204/빈응답/타임아웃)면 Naver preview 라인업으로 표시 폴백.
    // KBO 가 응답한 미확정(isToday=false) 라인업은 그대로 존중한다(폴백 트리거 아님).
    if (!lineup) {
      lineup = await untilDeadline(naverLineupPromise, deadlineSignal, null);
      if (lineup) lineupSource = "naver-confirmed";
    }
    // KBO가 LINEUP_CK=false로 직전 경기 타순을 돌려주는 동안에도 Naver preview에는
    // 오늘 예고선발 1+1이 먼저 발표된다. 직전 타순은 폐기하고 오늘 선발만 별도 보존해,
    // UI가 선발카드는 노출하되 타순은 확정 전까지 fail-close하도록 한다.
    if (!lineup?.isToday) {
      const starters = await untilDeadline(naverStartersPromise, deadlineSignal, null);
      if (starters?.away || starters?.home) {
        lineup = {
          isToday: false,
          away: [],
          home: [],
          awayStarter: starters.away,
          homeStarter: starters.home,
        };
        lineupSource = "naver-preview";
      }
    }
    let boxScore = parseBoxScore(boxScoreRes);
    if (boxScore) boxScoreSource = "kbo";
    let linescore = kboLinescore;

    // 이닝별 셀이 하나라도 채워졌는지. 경기 종료 전환 순간 KBO 스코어보드가
    // R/H/E 합계만 먼저 주고 이닝 셀은 비워 내려주는 타이밍 창이 있어,
    // linescore 객체는 있어도 이닝별 값이 전부 null일 수 있다.
    const hasInningBreakdown = (ls: GameDetailResponse["linescore"]) =>
      !!ls && (ls.away.innings.some(v => v !== null) || ls.home.innings.some(v => v !== null));

    // ScoreBoard가 scheduled인데 BoxScore에 실데이터가 있으면 → 종료된 경기
    const hasRealBoxScore = boxScore &&
      (boxScore.awayBatters.some(b => b.atBats > 0) || boxScore.homeBatters.some(b => b.atBats > 0));
    const hasPitchCountPartial = Boolean(boxScore && [
      ...boxScore.awayPitchers,
      ...boxScore.homePitchers,
    ].some((pitcher) => (
      pitcher.inningsPitched.trim() !== ""
      && !/^0(?:\s+0\/3)?$/.test(pitcher.inningsPitched.trim())
      && pitcher.pitchCount <= 0
    )));
    const hasCompleteBoxScore = Boolean(hasRealBoxScore && !hasPitchCountPartial);
    const kboExpectsDetailData =
      scoreBoardStatus === "live" || scoreBoardStatus === "final" || !!hasRealBoxScore;
    const kboDetailDegraded =
      !meta ||
      (kboExpectsDetailData && (!hasInningBreakdown(kboLinescore) || !hasCompleteBoxScore));

    // KBO BoxScore가 비어있거나, KBO linescore에 이닝별 값이 없으면 네이버 record API fallback
    let naver: Awaited<ReturnType<typeof fetchNaverRecord>> = null;
    if (!hasCompleteBoxScore || !hasInningBreakdown(linescore)) {
      naver = await untilDeadline(naverRecordPromise, deadlineSignal, null);
      // KBO box가 비거나 실제 투구이닝의 투구수가 0인 partial이면, 완전성 검증을
      // 통과한 Naver record로만 교체한다. Naver도 partial/timeout이면 box 전체를
      // 숨겨 거짓 0을 정상값으로 노출하지 않는다.
      if (!hasCompleteBoxScore && naver?.boxScore) {
        const naverHasData = naver.boxScore.awayBatters.some(b => b.atBats > 0)
          || naver.boxScore.homeBatters.some(b => b.atBats > 0);
        if (naverHasData) {
          boxScore = naver.boxScore;
          boxScoreSource = "naver";
        }
      } else if (!hasCompleteBoxScore) {
        boxScore = null;
        boxScoreSource = "none";
      }
      // KBO linescore가 없거나 이닝별 값이 비어있으면 네이버 이닝 스코어로 폴백
      const naverLs = naver?.linescore ?? null;
      if (!hasInningBreakdown(linescore) && hasInningBreakdown(naverLs)) {
        linescore = naverLs;
      }
    }

    // KBO BoxScore가 대타/대주 교체 선수의 수비 위치를 '대/주'로 방치하는 경우
    // (실측: 20260812LGWO0 김웅빈 '대'·박채울 '주' → 필드뷰 1B/CF 빈 자리),
    // Naver record의 선수별 복합 위치(타一/주중)로 병합한다 — 소스 진실 우선.
    // naverRecordPromise는 이미 시작된 프로미스라 추가 요청 없이 같은 deadline
    // 안에서만 기다린다. Naver가 없거나 partial이면 그대로 둔다(fail-safe).
    if (boxScore && boxScoreSource === "kbo" && hasPureSubPositions(boxScore)) {
      naver = naver ?? await untilDeadline(naverRecordPromise, deadlineSignal, null);
      if (naver?.boxScore) mergeNaverSubPositions(boxScore, naver.boxScore);
    }

    const hasRealBoxScoreFinal = boxScore &&
      (boxScore.awayBatters.some(b => b.atBats > 0) || boxScore.homeBatters.some(b => b.atBats > 0));

    let liveListStatus: GameDetailResponse["status"] | null = null;
    let listGame: KboGame | undefined;
    // detail 3종이 정상일 때는 KBO 목록(TV_IF 포함)을 우선하고, 부분결측이면 Naver
    // status를 우선한다. KBO 목록이 구조상 정상이어도 상태만 stale인 부분열화를 막는다.
    const emptyObservedGames: ObservedGames = { value: null, reason: "timeout" };
    const primaryListPromise = kboDetailDegraded ? naverListPromise : kboListPromise;
    const fallbackListPromise = kboDetailDegraded ? kboListPromise : naverListPromise;
    const primaryGames = await untilDeadline(primaryListPromise, deadlineSignal, emptyObservedGames);
    if (primaryGames.value) {
      listGame = primaryGames.value.find(g => g.gameId === gameId);
    }
    let fallbackGames: ObservedGames | null = null;
    if (!listGame) {
      fallbackGames = await untilDeadline(fallbackListPromise, deadlineSignal, emptyObservedGames);
      listGame = fallbackGames.value?.find(g => g.gameId === gameId);
    }
    // canonical status source와 KBO 고유 enrich(TV_IF)는 분리한다. detail 부분열화로
    // Naver status를 택해도 동일 deadline 안에 KBO list가 정상 settle되면 방송 채널은 보존.
    const kboListResult = kboDetailDegraded
      ? await untilDeadline(kboListPromise, deadlineSignal, emptyObservedGames)
      : primaryGames;
    const kboListGame = kboListResult.value?.find(g => g.gameId === gameId);
    if (listGame) {
      liveListStatus = listGame?.status ?? null;
    }
    // KBO TV_IF를 우선하되, KBO list까지 열화한 경우 Naver schedule broadChannel로 복구한다.
    // canonical status와 방송 채널 source는 독립이라 detail/record 폴백과 무관하게 병합한다.
    const broadcastChannels =
      kboListGame?.broadcastChannels?.length
        ? kboListGame.broadcastChannels
        : listGame?.broadcastChannels;
    if (!meta && listGame) {
      meta = {
        stadium: listGame.stadium,
        crowd: null,
        startTime: listGame.time || null,
        endTime: null,
        duration: null,
        ...(broadcastChannels?.length ? { broadcastChannels } : {}),
      };
    } else if (meta && broadcastChannels?.length) {
      meta.broadcastChannels = broadcastChannels;
    }

    const status: GameDetailResponse["status"] =
      liveListStatus === "cancelled" ? "cancelled" :
      liveListStatus === "live" ? "live" :
      scoreBoardStatus === "scheduled" && hasRealBoxScoreFinal ? "final" :
      liveListStatus ?? scoreBoardStatus;

    const response: GameDetailResponse = {
      gameId,
      status,
      meta,
      linescore,
      lineup: (() => {
        // Merge boxScore avg into lineup batters
        if (!lineup || !boxScore) return lineup;
        const mergeAvg = (lineupSide: typeof lineup.away, batters: BatterRecord[]) => {
          const avgMap = new Map<string, string>();
          for (const b of batters) {
            if (b.avg && b.avg !== ".000") avgMap.set(b.name, b.avg);
          }
          return lineupSide.map(p => ({
            ...p,
            avg: avgMap.get(p.name) || p.avg,
          }));
        };
        return {
          ...lineup,
          away: mergeAvg(lineup.away, boxScore.awayBatters),
          home: mergeAvg(lineup.home, boxScore.homeBatters),
        };
      })(),
      boxScore,
      trace: {
        sourceAtMs,
        fetchedAtMs: Date.now(),
        lineupSource,
        boxScoreSource,
      },
    };

    const actualKboFailure = kboBatch.reasons[0] ?? kboListResult.reason ?? null;
    const expectsDetailData = status === "live" || status === "final";
    const missingExpectedKboData =
      expectsDetailData && (
        !meta
        || !hasInningBreakdown(kboLinescore)
        || !hasRealBoxScore
        || hasPitchCountPartial
      );
    const naverHasExpectedData =
      hasInningBreakdown(naver?.linescore ?? null) || !!hasRealBoxScoreFinal || !!listGame;
    const bothSourcesUnavailable =
      !meta && !naverHasExpectedData && !!actualKboFailure;
    // scheduled/cancelled 경기는 KBO 상세(스코어보드·박스스코어)가 자연 결측이라 upstream
    // 응답 분류(schema-error 등)가 나와도 열화가 아니다 — 단일소스 경보에서 제외한다
    // (2026-07-30 #967 배포 직후 예정 경기 schema-error 오탐 폭주 재발 방지).
    // 양쪽 소스가 모두 죽은 outage 는 status 판정 자체가 기본값(scheduled)으로 무너진
    // 상태이므로 기존대로 상태 무관 보고를 유지한다.
    const reportableDegradation =
      bothSourcesUnavailable ||
      missingExpectedKboData ||
      (expectsDetailData && actualKboFailure !== null);
    if (reportableDegradation) {
      reportDetailDegradation(
        gameId,
        bothSourcesUnavailable,
        actualKboFailure ?? "schema-error",
      );
    }

    // ETag/304 조건부 응답: 폴링 시 detail이 안 바뀌었으면 304(빈 바디)로
    // Fast Origin Transfer 절감. 폴링 주기 불변 → 실시간성 손실 0. 브라우저가
    // no-cache 저장분을 revalidate하고 304 시 캐시 바디를 JS에 투명 반환(클라 무변경).
    return await jsonWithETag(req, response);
  } catch (e: unknown) {
    return NextResponse.json(
      { error: (e as Error).message, gameId, status: "scheduled", meta: null, linescore: null, lineup: null, boxScore: null },
      { status: 200 },
    );
  }
}
