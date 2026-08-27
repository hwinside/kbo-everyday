// Naver schedule/games 기반 경기목록 fallback — fetchGames(KBO GetKboGameList)가
// 실패(throw/timeout/스키마 열화)할 때 동일한 KboGame[] 형태로 일정+라이브 스코어를
// 대체 공급한다.
//
// 리스트-레벨 필드(스코어/상태/이닝)만 보장한다. 라이브 카운트(strikes/balls/outs/
// runners/currentBatter 등)는 Naver schedule 응답에 없어 0/빈값으로 graceful degrade
// 하며, in-game 상태는 상세(game-detail)·중계(game-relay)의 Naver 경로가 커버한다.

import { resolveTeamId, type KboGame } from "@/lib/crawler/kbo-api";
import { decodeBroadcast } from "@/lib/broadcast-channels";

const NAVER_SCHEDULE_API = "https://api-gw.sports.naver.com/schedule/games";

/** fetchGames 기본 srId(전 시리즈: 시범/정규/포스트/올스타). */
const DEFAULT_ALL_SR_ID = "0,1,3,4,5,7,9";
/** 정규시즌 전용 srId(예: game-logs cron). */
const REGULAR_SEASON_SR_ID = "0";
/**
 * Naver 로 안전하게 서빙 가능한 srId 화이트리스트. Naver schedule/games 는 series(gameType)
 * 필드를 제공하지 않으므로(실측 2026-07-29: 시범경기 3/15 도 정규와 동일 categoryId=kbo, 구분
 * 필드 없음) 아래 이외의 '특정 시리즈 전용' 요청은 오염 방지 위해 fail-close 한다.
 * - DEFAULT_ALL_SR_ID: 전 시리즈 요청 → Naver 전체(categoryId=kbo) 그대로, over-inclusion 없음.
 * - REGULAR_SEASON_SR_ID("0"): 정규시즌 전용(game-logs). KBO 장애 시 정규시즌 게임로그가 Naver
 *   미폴백으로 '무경기'처럼 사라지던 gap(삼순 P1)을 막기 위해 서빙 허용 — 정규시즌 윈도우의 kbo
 *   카테고리 응답은 전부 정규경기라 안전. (트레이드오프: 시범/포스트 윈도우와 KBO 장애가 겹치면
 *   Naver 가 series 를 못 갈라 over-inclusion 가능 → 시범/포스트/올스타 '전용' srId 는 계속 fail-close.)
 */
const NAVER_SERVICEABLE_SR_IDS = new Set<string>([DEFAULT_ALL_SR_ID, REGULAR_SEASON_SR_ID]);

/**
 * KBO 정규시즌 날짜 window (연도별, YYYYMMDD inclusive). srId=0(정규시즌 전용) Naver 폴백의
 * 허용 범위 — Naver schedule/games 는 series(gameType) 구분이 없어(파일 상단 실측 주석 참조)
 * 날짜 window 로 시범경기(3월 중) 오염을 차단하고, 정규 일정으로 확인되지 않은 날짜는
 * fail-close 한다(삼순 P0: window 없이는
 * 3/15 시범경기 5경기가 srId=0 정규 요청에 서빙돼 player_game_logs 누적 기록을 오염).
 *
 * 2026 근거(KBO 공식 정규시즌 일정 발표 2025-12-19, 스포츠경향 202512191538003 보도):
 * - 개막 2026-03-28(토), 팀당 144경기·총 720경기.
 * - 9/6 까지 팀당 135경기 우선 편성, 잔여 45경기(우천 취소분 포함)는 추후 편성 → 공식 '정규
 *   종료일' 은 유동. 9/30 이후는 무경기로 단정하지 않고 fail-close 한다. 잔여 일정이 확정되면
 *   검증된 정규 경기 날짜를 별도 허용해야 한다.
 * 미등록 연도는 fail-close(정규 일정 미확정 상태에서 추측 서빙 금지). 시즌이 바뀌면 갱신
 * (src/app/api/roster-moves/route.ts 의 SEASON_START 상수와 동일한 연 1회 운영).
 */
export interface RegularSeasonWindow {
  start: string;
  /** 현재 공식 일정으로 확인된 마지막 날짜. finalized=true일 때만 실제 시즌 종료일이다. */
  end: string;
  /** KBO가 우천 순연분까지 포함한 실제 종료일을 확정했는가. */
  finalized: boolean;
}

export const REGULAR_SEASON_WINDOWS: Readonly<Record<string, RegularSeasonWindow>> = {
  // 9/30은 우선 편성분의 경계일 뿐 실제 종료일이 아니다. 잔여 45경기 확정 전에는
  // 이 날짜 뒤를 잘라 complete로 열지 않는다.
  "2026": { start: "20260328", end: "20260930", finalized: false },
};

/** date(YYYYMMDD)가 검증된 정규시즌 window 안인가. 미등록 연도는 false(fail-close). */
export function isWithinRegularSeasonWindow(date: string): boolean {
  const w = REGULAR_SEASON_WINDOWS[date.slice(0, 4)];
  return !!w && date >= w.start && date <= w.end;
}

/**
 * srId=0(정규시즌 전용) 요청인데 검증된 정규시즌 window 밖인가. Naver는 series를 구분하지
 * 못하므로 이 조합은 폴백 금지 대상이며 KBO soft-empty도 authoritative로 확정할 수 없다.
 */
export function isRegularSeasonSrIdOutsideWindow(srId: string, date: string): boolean {
  return srId === REGULAR_SEASON_SR_ID && !isWithinRegularSeasonWindow(date);
}

interface NaverScheduleGame {
  gameId?: string;
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
  broadChannel?: string | null;
}

/** 입력 KBO 날짜(YYYYMMDD) → Naver 날짜(YYYY-MM-DD). */
function toNaverDate(date: string): string {
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
}

/**
 * Naver gameId 에서 회차(더블헤더) suffix 를 추출한다.
 * Naver gameId 형식: YYYYMMDD + 팀코드 + N(회차) + YYYY(연도접미).
 *   단일경기 `20260729HTSS02026` → "0", DH `20240623KTLG12024`/`…22024` → "1"/"2".
 * 연도접미 앞 1자리가 회차. 올스타는 연도접미가 9999(`20260706..09999`)여도
 * 회차 자리는 그대로 보존된다. 회차는 실무상 0~3만 유효(DH는 1/2, 드물게 3)이므로
 * 그 범위를 벗어나면(연도접미 결측로 자릿수 오인식 등) 명시적으로 "0"으로 클램한다.
 * gameId 파싱은 회차 추출에만 쓰고, 팀/날짜는 응답 필드를 직접 사용한다(reversedHomeAway 회피).
 */
export function extractGameSeq(naverGameId: string | undefined): string {
  if (!naverGameId) return "0";
  const withYear = naverGameId.match(/(\d)\d{4}$/);
  const raw = withYear ? withYear[1] : (naverGameId.match(/(\d)$/)?.[1] ?? "0");
  // 유효 회차 0~3 밖은 파싱 오인식(예: 올스타 9999 결측) → 단일경기 "0".
  return /^[0-3]$/.test(raw) ? raw : "0";
}

/**
 * Naver STARTED 조기 오표기 방어(테스트용 export) — 예정시각(KST) 전 + 0:0 이면 아직 경기전.
 * 실측 2026-08-11 18:24: Naver 가 LGWO 를 STARTED "1회초"로 내려줬으나 KBO 공식은 경기전,
 * Naver 상세 record 도 전부 0(타석/투구/중계 없음). 실제 KBO 경기는 예정시각 전에 시작하지
 * 않으므로, 예정시각 도달 전의 STARTED 는 원본 플래그 선반영으로 보고 scheduled 를 유지한다.
 * 득점이 이미 있으면(0:0 아님) 진행 중 증거가 있으므로 가드를 적용하지 않는다.
 * gameDateTime 은 KST 로컬 문자열("2026-08-11T19:00:00")이라 +09:00 을 명시해 파싱한다
 * (Vercel UTC 런타임에서 로컬 해석 시 9시간 오차). 파싱 불가(형식 변화)면 가드를 끄고
 * 기존 동작(live)으로 둔다 — 가드는 방어층이지 판정 SSOT 가 아니다.
 */
export function isPrematureStarted(g: NaverScheduleGame, now: Date): boolean {
  if ((g.statusCode ?? "") !== "STARTED") return false;
  if (!g.gameDateTime) return false;
  const scheduledMs = Date.parse(`${g.gameDateTime}+09:00`);
  if (!Number.isFinite(scheduledMs)) return false;
  if (now.getTime() >= scheduledMs) return false;
  // 선조건: 양팀 스코어가 finite 일 때만 가드 판정(삼순 NO-GO blocker 반영).
  // 결측/null 을 `?? 0` 으로 삼켜 premature 처리하면 STARTED 의 스코어 결측이
  // scheduled 로 위장돼 isRawNaverGameSane 의 finite-score fail-close 를 우회한다.
  // 결측은 가드 off → live 경로 유지 → 기존 fail-close 가 그대로 잡는다.
  if (!Number.isFinite(g.awayTeamScore) || !Number.isFinite(g.homeTeamScore)) return false;
  return g.awayTeamScore === 0 && g.homeTeamScore === 0;
}

function mapStatus(g: NaverScheduleGame, now: Date = new Date()): KboGame["status"] {
  const sc = g.statusCode ?? "";
  if (g.cancel || g.suspended || sc === "CANCEL" || sc === "POSTPONE") return "cancelled";
  // 종료: RESULT(결과 확정) + ENDED(경기 종료 직후, 2026-07-29 21:09 실응답 두산-SSG 실측).
  if (sc === "RESULT" || sc === "ENDED") return "final";
  if (sc === "STARTED") return isPrematureStarted(g, now) ? "scheduled" : "live";
  return "scheduled";
}

/**
 * Naver schedule game → KboGame 순수 매퍼(테스트용 export).
 * gameId 는 KBO 규칙(date + awayCode + homeCode + 회차)으로 재구성한다. 회차는 Naver
 * gameId 에서 보존(더블헤더 충돌 방지). 팀/날짜는 응답 필드 직접 사용.
 * (실측: KBO G_ID·Naver gameId 모두 away+home 순서, 예 `20260729WOLG0`.)
 */
export function mapNaverGameToKbo(g: NaverScheduleGame, date: string, now: Date = new Date()): KboGame {
  const awayCode = g.awayTeamCode ?? "";
  const homeCode = g.homeTeamCode ?? "";
  const seq = extractGameSeq(g.gameId);
  const status = mapStatus(g, now);
  // statusInfo "N회초"/"N회말" 에서 이닝/초말을 뽑는다(live·final 공통). 없으면 0/초.
  // scheduled 는 이닝을 노출하지 않는다(조기 STARTED 가드로 강등된 "1회초" 셀 활성화 방지).
  const inningMatch = status !== "scheduled" ? (g.statusInfo ?? "").match(/(\d+)회(초|말)/) : null;
  const inning = inningMatch ? parseInt(inningMatch[1], 10) : 0;
  const isTop = inningMatch ? inningMatch[2] === "초" : true;
  const broadcastChannels = decodeBroadcast(g.broadChannel);
  return {
    gameId: `${date}${awayCode}${homeCode}${seq}`,
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
    // Naver schedule 피드에는 BSO/주자/현재투타가 없다. 아래 0/false 는 관측값이 아니라
    // 타입을 채우기 위한 degrade 기본값이므로 liveDetailFromKbo=false 로 명시한다.
    // (이 플래그가 없으면 소비자가 "볼카운트 0-0-0, 주자 없음"을 사실로 단정한다 — 삼순 NO-GO)
    strikes: 0,
    balls: 0,
    outs: 0,
    runnersOn: { first: false, second: false, third: false },
    currentPitcher: "",
    currentBatter: "",
    liveDetailFromKbo: false,
    // Naver schedule 피드는 취소 여부(cancel/suspended/statusCode)만 주고 **사유 문자열은 없다**.
    // 빈 문자열로 채우면 "사유 없는 취소"로 오독되므로 null(= 미확인) 을 유지한다.
    cancelReason: null,
    awayRank: 0,
    homeRank: 0,
    broadcastChannels: broadcastChannels.length > 0 ? broadcastChannels : undefined,
  };
}

/** Naver schedule 상태 코드 화이트리스트 — 이 밖의 미지값은 fail-close(합성 값으로 숨기지 않음). */
const KNOWN_NAVER_STATUS = new Set(["READY", "BEFORE", "STARTED", "ENDED", "RESULT", "CANCEL", "POSTPONE", "SUSPENDED"]);

/**
 * raw NaverScheduleGame 원본 sanity — mapping 後 mapped 값만 검사하면 원본 결측이
 * 합성 gameId/0:0/scheduled 로 숨어버린다. 따라서 매핑 전 원본 필드를 먼저 검증한다:
 * - 원본 gameId/gameDateTime/양팀코드 필수·팀 해석(teamId>0)
 * - status 는 known 상태만 허용(unknown/미지값 fail-close)
 * - live/final 은 finite score 필수, live 는 이닝 정보(statusInfo "N회") 필수
 */
function isRawNaverGameSane(g: NaverScheduleGame): boolean {
  if (!g.gameId || !g.gameDateTime || !g.homeTeamCode || !g.awayTeamCode) return false;
  if (resolveTeamId(g.awayTeamCode, g.awayTeamName ?? "") <= 0) return false;
  if (resolveTeamId(g.homeTeamCode, g.homeTeamName ?? "") <= 0) return false;
  const sc = g.statusCode ?? "";
  const knownStatus = KNOWN_NAVER_STATUS.has(sc) || g.cancel === true || g.suspended === true;
  if (!knownStatus) return false; // unknown status → 합성 scheduled 로 숨기지 않고 fail-close
  const status = mapStatus(g);
  if (status === "live" || status === "final") {
    // 진행/종료는 finite score 가 반드시 있어야 함(가짜 0:0 방지)
    if (!Number.isFinite(g.awayTeamScore) || !Number.isFinite(g.homeTeamScore)) return false;
    if (status === "live" && !/(\d+)회(초|말)/.test(g.statusInfo ?? "")) return false;
  }
  return true;
}

/**
 * mapped 결과 방어적 재검증(이중). 원본은 isRawNaverGameSane 가 이미 걸렸지만,
 * 매핑 결과의 gameId/teamId/name 도 비어있지 않은지 확인.
 */
function isSaneGame(g: KboGame): boolean {
  return (
    !!g.gameId &&
    g.awayTeamId > 0 &&
    g.homeTeamId > 0 &&
    g.awayName.length > 0 &&
    g.homeName.length > 0
  );
}

/**
 * 특정 날짜 경기목록을 Naver schedule/games 로 조회(KBO fallback).
 * - srId 가 Naver 서빙 화이트리스트(전-시리즈 셋 또는 정규"0")가 아니면 fail-close(series 필터 미지원).
 * - fail-closed: success!==true || code!==200 || games 배열 부재 || per-game sanity 실패면 throw.
 * - 경기 없는 날(games: [])은 정상으로 간주해 빈 배열을 반환한다(무경기일 500 방지).
 */
export async function fetchNaverGames(
  date: string,
  srId: string = DEFAULT_ALL_SR_ID,
  opts?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<KboGame[]> {
  if (!NAVER_SERVICEABLE_SR_IDS.has(srId)) {
    // 시범/포스트/올스타 '전용' srId — Naver 로는 series 보존 불가 → 오염 방지 위해 fail-close.
    throw new Error(`Naver fallback: srId(${srId}) series 필터 계약 보존 불가 — fail-close`);
  }
  if (isRegularSeasonSrIdOutsideWindow(srId, date)) {
    // srId=0(정규 전용)인데 정규시즌 window 밖(시범/포스트/미확정 연도) — Naver 는 series 를
    // 못 갈라 window 밖 경기(시범 5경기 등)를 정규로 오인 서빙하게 된다(삼순 P0) → fail-close.
    throw new Error(`Naver fallback: srId=0 인데 ${date} 는 정규시즌 window 밖 — 시범/포스트 오염 방지 fail-close`);
  }
  const naverDate = toNaverDate(date);
  const url =
    `${NAVER_SCHEDULE_API}?fields=basic,superCategoryId,categoryName,stadium,statusInfo,broadChannel` +
    `&upperCategoryId=kbaseball&categoryId=kbo&fromDate=${naverDate}&toDate=${naverDate}&size=20`;
  const res = await fetch(url, {
    headers: {
      "Referer": "https://sports.news.naver.com/",
      "User-Agent": "Mozilla/5.0 (compatible; KboEveryday/1.0)",
    },
    signal: opts?.signal ?? AbortSignal.timeout(opts?.timeoutMs ?? 5000),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Naver schedule HTTP ${res.status}`);
  }
  const data = await res.json();
  if (data?.code !== 200 || data?.success !== true || !Array.isArray(data?.result?.games)) {
    throw new Error("Naver schedule 응답 sanity 실패(success/code/games)");
  }
  const rawGames = data.result.games as NaverScheduleGame[];
  // 경기 있는 응답인데 원본 필드가 하나라도 결측/미지상태/점수결측이면 부분/가짜 응답 — fail-close.
  if (rawGames.some((g) => !isRawNaverGameSane(g))) {
    throw new Error("Naver schedule per-game sanity 실패(원본 필수 필드/상태/스코어 결측)");
  }
  const games = rawGames.map((g) => mapNaverGameToKbo(g, date));
  // 매핑 gameId 유일성(회차 보존 실패로 DH 가 합쳐지면 상세/캐시/알림 키 충돌) — fail-close.
  if (new Set(games.map((g) => g.gameId)).size !== games.length) {
    throw new Error("Naver schedule gameId 중복(회차 보존 실패)");
  }
  // mapped 방어적 재검증(이중).
  if (games.some((g) => !isSaneGame(g))) {
    throw new Error("Naver schedule per-game sanity 실패(mapped 팀 id/필수 필드)");
  }
  return games;
}
