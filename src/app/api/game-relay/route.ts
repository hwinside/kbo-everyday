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

export interface GameRelayResponse {
  gameId: string;
  currentInning: number;
  innings: InningRelay[];
  matchup?: MatchupStats;
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
      if (opt.type === 13) {
        // At-bat result: "홍창기 : 우익수 앞 1루타"
        const parts = opt.text.split(" : ");
        const resultText = parts.length > 1 ? parts.slice(1).join(" : ") : opt.text;

        const play: PlayEvent = {
          batterName,
          result: resultText,
          type: classifyResult(resultText),
        };
        current.plays.push(play);
      } else if (opt.type === 14) {
        // Base running event — only show scoring and steals
        if (
          opt.text.includes("홈까지 진루") ||
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

    const allTextRelays = await Promise.all(inningPromises);

    // Combine all text relays and parse
    const combined = allTextRelays.flat();
    const innings = parseInningRelays(combined);

    // Extract current matchup stats from the latest batter entry
    // Use the last inning's raw data (newest first = first in array)
    const lastInningRelays = allTextRelays[allTextRelays.length - 1] ?? [];
    const matchup = extractMatchup(lastInningRelays);

    const response: GameRelayResponse = {
      gameId,
      currentInning: maxInning,
      innings,
      matchup,
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
