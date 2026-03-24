import { NextRequest, NextResponse } from "next/server";

// Vercel 서버리스에서 캐시 방지 (라이브 데이터는 항상 최신이어야 함)
export const dynamic = "force-dynamic";

// ===== Types =====

export interface PlayEvent {
  batterName: string;
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
}

export interface InningRelay {
  inning: number;
  half: "top" | "bottom";
  teamName: string;
  plays: PlayEvent[];
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
  matchup?: MatchupStats;
  playerStats?: RelayPlayerStats;
  linescore?: RelayLinescore;
}

// ===== Helpers =====

function toNaverGameId(kboGameId: string): string {
  const year = kboGameId.slice(0, 4);
  return kboGameId + year;
}

function classifyResult(text: string): PlayEvent["type"] {
  if (text.includes("홈런")) return "homerun";
  if (text.includes("1루타") || text.includes("2루타") || text.includes("3루타"))
    return "hit";
  if (text.includes("볼넷")) return "walk";
  if (text.includes("삼진")) return "strikeout";
  if (text.includes("몸에 맞는 볼")) return "hbp";
  if (text.includes("희생")) return "sacrifice";
  if (text.includes("실책")) return "error";
  if (text.includes("아웃")) return "out";
  return "other";
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

interface NaverTextOption {
  seqno: number;
  text: string;
  type: number;
  speed?: string;
  stuff?: string;
  currentPlayersInfo?: {
    away?: NaverPlayerInfo;
    home?: NaverPlayerInfo;
  };
  batterRecord?: NaverBatterRecord;
}

interface NaverTextRelay {
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

function parseInningRelays(textRelays: NaverTextRelay[]): InningRelay[] {
  // textRelays comes in reverse order (newest first) — flip to chronological
  const chronological = [...textRelays].reverse();

  const innings: InningRelay[] = [];
  let current: InningRelay | null = null;

  for (const relay of chronological) {
    if (relay.titleStyle === "0") {
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

    // Extract batter name from title: "3번타자 홍창기"
    const batterMatch = relay.title.match(/\d+번타자\s+(.+)/);
    const batterName = batterMatch ? batterMatch[1] : relay.title;

    for (const opt of relay.textOptions) {
      if (opt.type === 13 || opt.type === 23) {
        // At-bat result: "홍창기 : 우익수 앞 1루타"
        // type 13 = 일반 타석 결과, type 23 = 희생플라이/아웃/볼넷 등
        const parts = opt.text.split(" : ");
        const resultText = parts.length > 1 ? parts.slice(1).join(" : ") : opt.text;

        const play: PlayEvent = {
          batterName,
          result: resultText,
          type: classifyResult(resultText),
        };
        current.plays.push(play);
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

export async function GET(req: NextRequest) {
  const gameId = req.nextUrl.searchParams.get("gameId");
  if (!gameId) {
    return NextResponse.json(
      { error: "gameId is required" },
      { status: 400 }
    );
  }

  // 클라이언트에서 현재 이닝을 힌트로 전달 (네이버 API의 inn이 부정확할 때 대비)
  const inningHint = parseInt(req.nextUrl.searchParams.get("inning") || "0") || 0;

  const naverGameId = toNaverGameId(gameId);

  try {
    // First, fetch inning 1 to get the current inning number
    const firstRes = await fetch(
      `${NAVER_API_BASE}/${naverGameId}/relay?inning=1`,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; KboEveryday/1.0)",
        },
        cache: "no-store",
      }
    );

    if (!firstRes.ok) {
      return NextResponse.json(
        {
          gameId,
          currentInning: 0,
          innings: [],
        } satisfies GameRelayResponse,
        { status: 200 }
      );
    }

    const firstData = (await firstRes.json()) as NaverRelayResponse;
    const naverInning = firstData.result?.textRelayData?.inn ?? 1;
    // 네이버 inn과 클라이언트 힌트 중 큰 값 사용 (네이버가 부정확할 때 대비)
    const currentInning = Math.max(naverInning, inningHint);

    // Cap at 15 innings (extended games)
    const maxInning = Math.min(currentInning, 15);

    // Fetch all innings in parallel (inning 1 already fetched)
    const inningPromises: Promise<NaverTextRelay[]>[] = [];

    // Use the already-fetched inning 1 data
    inningPromises.push(
      Promise.resolve(
        firstData.result?.textRelayData?.textRelays ?? []
      )
    );

    for (let i = 2; i <= maxInning; i++) {
      inningPromises.push(
        fetch(`${NAVER_API_BASE}/${naverGameId}/relay?inning=${i}`, {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; KboEveryday/1.0)",
          },
          cache: "no-store",
        })
          .then((r) => (r.ok ? r.json() : null))
          .then(
            (data: NaverRelayResponse | null) =>
              data?.result?.textRelayData?.textRelays ?? []
          )
          .catch(() => [] as NaverTextRelay[])
      );
    }

    // Fetch record API in parallel for accurate pitcher/batter stats with names
    const recordPromise = fetch(
      `${NAVER_API_BASE}/${naverGameId}/record`,
      {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; KboEveryday/1.0)" },
        cache: "no-store",
      }
    )
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);

    const [allTextRelaysResult, recordData] = await Promise.all([
      Promise.all(inningPromises),
      recordPromise,
    ]);

    const allTextRelays = allTextRelaysResult;

    // Combine all text relays and parse
    const combined = allTextRelays.flat();
    const innings = parseInningRelays(combined);

    // Extract current matchup stats from the latest batter entry
    // Use the last inning's raw data (newest first = first in array)
    const lastInningRelays = allTextRelays[allTextRelays.length - 1] ?? [];
    const matchup = extractMatchup(lastInningRelays);

    // Extract player stats: prefer record API (has pitcher names), fallback to relay parsing
    const playerStats = extractPlayerStatsFromRecord(recordData) ?? extractPlayerStats(combined);

    // Build linescore from naver relay data
    const trd = firstData.result?.textRelayData;
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
      matchup,
      playerStats,
      linescore,
    };

    return NextResponse.json(response);
  } catch {
    return NextResponse.json(
      {
        gameId,
        currentInning: 0,
        innings: [],
      } satisfies GameRelayResponse,
      { status: 200 }
    );
  }
}
