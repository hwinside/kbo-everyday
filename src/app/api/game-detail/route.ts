import { NextRequest, NextResponse } from "next/server";

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
  } | null;
  linescore: {
    away: { innings: (number | null)[]; R: number; H: number; E: number };
    home: { innings: (number | null)[]; R: number; H: number; E: number };
  } | null;
  lineup: {
    isToday: boolean;
    away: LineupEntry[];
    home: LineupEntry[];
  } | null;
  boxScore: {
    awayBatters: BatterRecord[];
    homeBatters: BatterRecord[];
    awayPitchers: PitcherRecord[];
    homePitchers: PitcherRecord[];
  } | null;
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
  bb: number;
  so: number;
  sb: number;
  avg: string;
  isSubstitute: boolean;
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

import playersRoster from "@/lib/constants/players-roster.json";

const KBO_BASE = "https://www.koreabaseball.com/ws/Schedule.asmx";
const HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded",
  "User-Agent": "Mozilla/5.0 (compatible; KboEveryday/1.0)",
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

function parseScoreBoard(data: unknown[]): {
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

  // data[1] = linescore JSON string (may not exist for pre-game)
  if (data.length < 2 || !data[1]) {
    return { meta, linescore: null, status };
  }

  let linescoreData: { rows: { row: { Text: string }[] }[] };
  try {
    const raw = Array.isArray(data[1]) && data[1].length > 0 ? data[1][0] : data[1];
    linescoreData = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return { meta, linescore: null, status };
  }

  if (!linescoreData?.rows || linescoreData.rows.length < 2) {
    return { meta, linescore: null, status };
  }

  function parseLinescoreRow(row: { Text: string }[]): { innings: (number | null)[]; R: number; H: number; E: number } {
    // Skip first 2 columns (승/패 + 팀로고), last 4 columns = R,H,E,BB
    const cells = row.map(c => safeStr(c.Text));
    const inningCells = cells.slice(2, cells.length - 4);
    const innings = inningCells.map(c => {
      const stripped = stripHtml(c);
      if (stripped === "" || stripped === "-") return null;
      return safeInt(stripped);
    });
    const tail = cells.slice(cells.length - 4);
    return {
      innings,
      R: safeInt(stripHtml(tail[0])),
      H: safeInt(stripHtml(tail[1])),
      E: safeInt(stripHtml(tail[2])),
    };
  }

  const awayRow = linescoreData.rows[0]?.row;
  const homeRow = linescoreData.rows[1]?.row;

  if (!awayRow || !homeRow) {
    return { meta, linescore: null, status };
  }

  return {
    meta,
    linescore: {
      away: parseLinescoreRow(awayRow),
      home: parseLinescoreRow(homeRow),
    },
    status,
  };
}

function parseLineup(data: unknown[]): GameDetailResponse["lineup"] {
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
        avg: (() => {
          const raw = safeStr(cells[3]);
          // 시범경기 첫날 등 0.00인 경우 "-" 표시
          return (!raw || raw === "0.00" || raw === "0" || raw === ".000") ? "-" : raw;
        })(),
      };
    }).filter(e => e.name !== "");
  }

  // KBO returns: data[1]=HOME team, data[3]=HOME lineup; data[2]=AWAY team, data[4]=AWAY lineup
  const home = parseLineupRows(data[3]);
  const away = parseLineupRows(data[4]);

  if (away.length === 0 && home.length === 0) return null;

  // 실제 라인업 데이터가 존재하면 LINEUP_CK 무관하게 반환
  // KBO ScoreBoard가 "scheduled"로 내려와도 라인업은 이미 확정된 경우 있음
  return { isToday, away, home };
}

function parseBoxScore(data: unknown): GameDetailResponse["boxScore"] {
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

      // Count HR/BB/SO from at-bat results
      let hr = 0, bb = 0, so = 0;
      for (const ab of atBatResults) {
        if (ab.includes("홈")) hr++;
        if (ab === "4구") bb++;
        // 사구(死球) = HBP, not BB — don't count as walk
        if (ab.includes("삼진")) so++;
      }

      const order = safeInt(stripHtml(cells[0]));
      const posRaw = stripHtml(cells[1] || "");
      const isSubstitute = order === prevOrder || posRaw.startsWith("타") || posRaw.startsWith("주") || posRaw.startsWith("대");
      prevOrder = order;

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
        bb,
        so,
        sb: sbLookup.get(stripHtml(cells[2] || "")) || 0,
        avg: stripHtml(tail[4]) || ".000",
        isSubstitute,
      };
    }).filter(b => b.name !== "").map(b => {
      // KBO sometimes returns player IDs instead of names
      if (/^\d+$/.test(b.name)) {
        const player = (playersRoster as { kboId: string; name: string }[]).find(
          r => String(r.kboId) === b.name
        );
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
        const player = (playersRoster as { kboId: string; name: string }[]).find(
          r => String(r.kboId) === p.name
        );
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

// ===== Route handler =====

export async function GET(req: NextRequest) {
  const gameId = req.nextUrl.searchParams.get("gameId");
  if (!gameId) {
    return NextResponse.json({ error: "gameId is required" }, { status: 400 });
  }

  const seasonId = req.nextUrl.searchParams.get("seasonId") || new Date().getFullYear().toString();

  // Determine srId from gameId date (preseason: srId=1, regular: srId=0)
  let srId = req.nextUrl.searchParams.get("srId") || "0";
  if (!req.nextUrl.searchParams.has("srId") && gameId.length >= 8) {
    const dateStr = gameId.slice(0, 8); // YYYYMMDD
    // 2026 preseason: 3/12 ~ 3/24
    if (dateStr >= "20260312" && dateStr <= "20260324") {
      srId = "1";
    }
  }
  const body = `leId=1&srId=${srId}&seasonId=${seasonId}&gameId=${gameId}`;

  try {
    const [scoreBoardRes, lineupRes, boxScoreRes] = await Promise.all([
      fetch(`${KBO_BASE}/GetScoreBoard`, {
        method: "POST", headers: HEADERS, body,
        next: { revalidate: 30 },
      }).then(r => r.ok ? r.json() : null).catch(() => null),

      fetch(`${KBO_BASE}/GetLineUpAnalysis`, {
        method: "POST", headers: HEADERS, body,
        next: { revalidate: 30 },
      }).then(r => r.ok ? r.json() : null).catch(() => null),

      fetch(`${KBO_BASE}/GetBoxScore`, {
        method: "POST", headers: HEADERS, body,
        next: { revalidate: 30 },
      }).then(r => r.ok ? r.json() : null).catch(() => null),
    ]);

    const { meta, linescore, status: scoreBoardStatus } = parseScoreBoard(scoreBoardRes ?? []);
    const lineup = parseLineup(lineupRes ?? []);
    const boxScore = parseBoxScore(boxScoreRes);

    // ScoreBoard가 scheduled인데 BoxScore에 실데이터가 있으면 → 종료된 경기
    const hasRealBoxScore = boxScore &&
      (boxScore.awayBatters.some(b => b.atBats > 0) || boxScore.homeBatters.some(b => b.atBats > 0));
    const status: GameDetailResponse["status"] =
      scoreBoardStatus === "scheduled" && hasRealBoxScore ? "final" : scoreBoardStatus;

    const response: GameDetailResponse = {
      gameId,
      status,
      meta,
      linescore,
      lineup,
      boxScore,
    };

    return NextResponse.json(response);
  } catch (e: unknown) {
    return NextResponse.json(
      { error: (e as Error).message, gameId, status: "scheduled", meta: null, linescore: null, lineup: null, boxScore: null },
      { status: 200 },
    );
  }
}
