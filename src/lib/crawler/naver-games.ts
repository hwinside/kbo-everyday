// Naver schedule/games 기반 경기목록 fallback — fetchGames(KBO GetKboGameList)가
// 실패(throw/timeout)할 때 동일한 KboGame[] 형태로 일정+라이브 스코어를 대체 공급한다.
//
// 리스트-레벨 필드(스코어/상태/이닝)만 보장한다. 라이브 카운트(strikes/balls/outs/
// runners/currentBatter 등)는 Naver schedule 응답에 없어 0/빈값으로 graceful degrade
// 하며, in-game 상태는 상세(game-detail)·중계(game-relay)의 Naver 경로가 커버한다.

import { resolveTeamId, type KboGame } from "@/lib/crawler/kbo-api";

const NAVER_SCHEDULE_API = "https://api-gw.sports.naver.com/schedule/games";

interface NaverScheduleGame {
  gameDateTime?: string;
  stadium?: string;
  homeTeamCode?: string;
  awayTeamCode?: string;
  homeTeamName?: string;
  awayTeamName?: string;
  homeTeamScore?: number;
  awayTeamScore?: number;
  statusCode?: string;
  statusInfo?: string;
  cancel?: boolean;
  suspended?: boolean;
}

/** 입력 KBO 날짜(YYYYMMDD) → Naver 날짜(YYYY-MM-DD). */
function toNaverDate(date: string): string {
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
}

function mapStatus(g: NaverScheduleGame): KboGame["status"] {
  const sc = g.statusCode ?? "";
  if (g.cancel || g.suspended || sc === "CANCEL" || sc === "POSTPONE") return "cancelled";
  if (sc === "RESULT") return "final";
  if (sc === "STARTED") return "live";
  return "scheduled";
}

/**
 * Naver schedule game → KboGame 순수 매퍼(테스트용 export).
 * gameId 는 KBO 규칙(date + awayCode + homeCode + "0")으로 재구성한다. Naver gameId는
 * 연도 접미가 붙고, reversedHomeAway 표기가 있어 파싱하지 않고 응답의 home/away 코드를
 * 직접 사용한다(실측: KBO G_ID 와 Naver gameId 모두 away+home 순서).
 */
export function mapNaverGameToKbo(g: NaverScheduleGame, date: string): KboGame {
  const awayCode = g.awayTeamCode ?? "";
  const homeCode = g.homeTeamCode ?? "";
  const status = mapStatus(g);
  // statusInfo "N회초"/"N회말" 에서 이닝/초말을 뽑는다(live·final 공통). 없으면 0/초.
  const inningMatch = (g.statusInfo ?? "").match(/(\d+)회(초|말)/);
  const inning = inningMatch ? parseInt(inningMatch[1], 10) : 0;
  const isTop = inningMatch ? inningMatch[2] === "초" : true;
  return {
    gameId: `${date}${awayCode}${homeCode}0`,
    date,
    time: g.gameDateTime ? g.gameDateTime.slice(11, 16) : "",
    stadium: g.stadium ?? "",
    awayTeamId: resolveTeamId(awayCode, g.awayTeamName ?? ""),
    homeTeamId: resolveTeamId(homeCode, g.homeTeamName ?? ""),
    awayName: g.awayTeamName ?? "",
    homeName: g.homeTeamName ?? "",
    awayScore: status !== "scheduled" ? (g.awayTeamScore ?? 0) : null,
    homeScore: status !== "scheduled" ? (g.homeTeamScore ?? 0) : null,
    inning,
    isTop,
    status,
    awayStarterName: "",
    homeStarterName: "",
    winPitcher: "",
    losePitcher: "",
    savePitcher: "",
    strikes: 0,
    balls: 0,
    outs: 0,
    runnersOn: { first: false, second: false, third: false },
    currentPitcher: "",
    currentBatter: "",
    awayRank: 0,
    homeRank: 0,
    broadcastChannels: undefined,
  };
}

/**
 * 특정 날짜 경기목록을 Naver schedule/games 로 조회(KBO fallback).
 * fail-closed: success!==true || code!==200 || games 필드 부재면 throw.
 * 경기 없는 날(games: [])은 정상으로 간주해 빈 배열을 반환한다.
 */
export async function fetchNaverGames(date: string): Promise<KboGame[]> {
  const naverDate = toNaverDate(date);
  const url =
    `${NAVER_SCHEDULE_API}?fields=basic,superCategoryId,categoryName,stadium,statusInfo` +
    `&upperCategoryId=kbaseball&categoryId=kbo&fromDate=${naverDate}&toDate=${naverDate}&size=20`;
  const res = await fetch(url, {
    headers: {
      "Referer": "https://sports.news.naver.com/",
      "User-Agent": "Mozilla/5.0 (compatible; KboEveryday/1.0)",
    },
    signal: AbortSignal.timeout(5000),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Naver schedule HTTP ${res.status}`);
  }
  const data = await res.json();
  if (data?.code !== 200 || data?.success !== true || !Array.isArray(data?.result?.games)) {
    throw new Error("Naver schedule 응답 sanity 실패(success/code/games)");
  }
  return (data.result.games as NaverScheduleGame[]).map((g) => mapNaverGameToKbo(g, date));
}
