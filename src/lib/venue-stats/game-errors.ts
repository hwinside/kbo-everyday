/**
 * 직관 경기의 팀별 실책(E) 조회 — `발암경기 인내형` 태그 데이터 소스.
 *
 * 하린아빠 2026-08-02: "유독 실책을 많이 보는 발암경기 인내형 태그도 추가해줘".
 *
 * ⚠️ **`player_game_logs` 를 건드리지 않는다.** canonical payload hash(§12)가 20필드
 * 전체를 묶어 계산되므로 컬럼을 하나 끼우면 해시가 전부 바뀌고, 운영 ledger complete
 * 468경기가 통째로 `payload_hash_mismatch` 로 떨어져 B/C 집계가 fail-close 된다.
 * 실책은 팀 단위 지표라 선수별로 쪼갤 이유도 없다 — linescore 의 `E` 를 그대로 쓴다.
 *
 * ⚠️ **공용 linescore 파서를 쓰지 않는다** (삼순 P0 2026-08-02).
 * `parseNaverScoreBoardLinescore()` 는 `e ?? 0`, `parseGameLinescoreResponse()` 는
 * `bsSafeInt("")=0` 이라 **결손 E 를 이미 0 으로 승격**시킨다. 실측 재현:
 * 이닝·R/H 는 있고 e 만 빠진 입력에서 양쪽 모두 `E:0` 을 반환했다.
 * 그 값을 받으면 "모름"과 "실책 0개"를 영원히 구별할 수 없으므로, 이 파일은
 * **raw 응답에서 E 셀의 존재 자체**를 직접 확인한다.
 *
 * ⚠️ **데이터소스 failover 는 이 파일이 SSOT** (AGENTS P0 2026-07-30 재발방지).
 * KBO `GetScoreBoard` → 결손/비final 이면 Naver record. 둘 다 실패하면 그 경기는
 * **미확인**으로 남긴다(0 으로 채우지 않는다 — 0 은 "실책 없음"이라는 사실 주장이고,
 * 조회 실패는 사실이 아니라 무지다).
 */

import { resolveTeamId, type KboGame } from "@/lib/crawler/kbo-api";
import { fetchNaverGames } from "@/lib/crawler/naver-games";

/** 한 경기의 원정/홈 실책 수. */
export interface GameErrorCounts {
  away: number;
  home: number;
}

/** 소스가 돌려준 raw 관측값. `null` = 그 소스에서 확인 불가. */
export interface RawErrorObservation {
  source: "kbo" | "naver";
  /** KBO 는 경기 ID exact, Naver 는 record gameInfo 의 경기일자를 보존한다. */
  gameId: string | null;
  gameDate: string;
  /** Naver record identity witness. KBO 는 exact gameId 를 직접 주므로 null. */
  gameTime: string | null;
  /**
   * Naver `gameInfo.round` 원값(시즌 라운드).
   * ⚠️ DH 회차가 **아니다** — identity 결속에 쓰지 않는다. 관측 메타로만 보존한다.
   */
  gameRound: number | null;
  awayTeamId: number;
  homeTeamId: number;
  away: number;
  home: number;
  /** 교차검증용 최종 득점. canonical 과 대조해 stale/live 응답을 거른다. */
  awayRuns: number;
  homeRuns: number;
}

/**
 * 실책 수로 인정할 수 있는 값인지. **결손·빈문자열·비정수·음수는 전부 null.**
 * `Number("")===0` 함정을 여기서 닫는다(같은 함정을 오늘만 두 번 냈다).
 */
const MAX_PLAUSIBLE_ERRORS = 30;

export function parseErrorCell(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return null;
  if (typeof v === "string" && v.trim() === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  if (n < 0 || n > MAX_PLAUSIBLE_ERRORS) return null;
  return n;
}

const KBO_SCOREBOARD =
  "https://www.koreabaseball.com/ws/Schedule.asmx/GetScoreBoard";
const KBO_HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
  Referer: "https://www.koreabaseball.com/Schedule/ScoreBoard.aspx",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
};
const NAVER_RECORD = "https://api-gw.sports.naver.com/schedule/games";

function stripHtml(v: string): string {
  return v.replace(/<[^>]+>/g, "").trim();
}

/**
 * KBO `GetScoreBoard` raw → 실책 관측.
 *
 * 계약:
 *  - `END_TM` 이 있어야 한다(= 종료 경기). live/stale 응답의 중간값을 채택하지 않는다.
 *  - 취소 경기는 관측 대상이 아니다.
 *  - R/H/E/BB 4칸 중 **E 셀이 실제로 숫자여야** 한다. 빈칸이면 null(결손).
 */
export function parseKboErrorObservation(data: unknown): RawErrorObservation | null {
  if (!Array.isArray(data) || data.length < 2 || !data[1]) return null;
  const meta = Array.isArray(data[0]) && data[0].length > 0 ? data[0][0] : null;
  const metaRecord = meta as Record<string, unknown> | null;
  const cancelName = String(
    metaRecord?.CANCEL_SC_NM ?? "",
  );
  const cancelId = String(metaRecord?.CANCEL_SC_ID ?? "").trim();
  if (
    cancelName.includes("취소") ||
    cancelName.includes("우천") ||
    (cancelId !== "" && cancelId !== "0")
  ) return null;
  // 종료 경기만 — 진행 중 스코어보드의 중간 실책을 최종값으로 쓰지 않는다.
  if (!String(metaRecord?.END_TM ?? "").trim()) return null;

  const gameId = String(metaRecord?.G_ID ?? "").trim();
  const gameDate = String(metaRecord?.G_DT ?? "").replaceAll("-", "").trim();
  const awayTeamId = resolveTeamId(String(metaRecord?.AWAY_ID ?? "").trim(), "");
  const homeTeamId = resolveTeamId(String(metaRecord?.HOME_ID ?? "").trim(), "");
  if (!gameId || !/^\d{8}$/.test(gameDate) || awayTeamId <= 0 || homeTeamId <= 0) return null;

  let parsed: { rows?: { row: { Text: string }[] }[] };
  try {
    const raw = Array.isArray(data[1]) && data[1].length > 0 ? data[1][0] : data[1];
    parsed = typeof raw === "string" ? JSON.parse(raw) : (raw as typeof parsed);
  } catch {
    return null;
  }
  if (!parsed?.rows || parsed.rows.length < 2) return null;

  // 검증된 game-detail 계약: 뒤 4칸이 R/H/E/BB.
  const side = (row: { Text: string }[] | undefined) => {
    if (!row) return null;
    const cells = row.map((c) => stripHtml(String(c?.Text ?? "")));
    if (cells.length < 6) return null;
    const tail = cells.slice(cells.length - 4);
    const runs = parseErrorCell(tail[0]);
    const errors = parseErrorCell(tail[2]);
    if (runs === null || errors === null) return null;
    return { runs, errors };
  };

  const away = side(parsed.rows[0]?.row);
  const home = side(parsed.rows[1]?.row);
  if (!away || !home) return null;
  return {
    source: "kbo",
    gameId,
    gameDate,
    gameTime: null,
    gameRound: null,
    awayTeamId,
    homeTeamId,
    away: away.errors,
    home: home.errors,
    awayRuns: away.runs,
    homeRuns: home.runs,
  };
}

/** Naver record raw → 실책 관측. `rheb.*.e` 가 실제로 숫자일 때만 채택. */
export function parseNaverErrorObservation(json: unknown): RawErrorObservation | null {
  const recordData = (json as Record<string, never> | null)?.result?.["recordData"] as
    | Record<string, unknown>
    | undefined;
  const sb = recordData?.scoreBoard as
    | { rheb?: { away?: Record<string, unknown>; home?: Record<string, unknown> } }
    | undefined;
  const gameInfo = recordData?.gameInfo as Record<string, unknown> | undefined;
  const gameDate = String(gameInfo?.gdate ?? "").trim();
  const gameTime = String(gameInfo?.gtime ?? "").trim();
  const rawRound = Number(gameInfo?.round);
  // `round` 는 시즌 라운드이지 DH 회차가 아니다 — identity 계약에 쓰지 않는다(삼순 P1).
  // 관측 메타로만 보존하고, 결손이어도 관측 자체를 버리지 않는다.
  const gameRound = Number.isInteger(rawRound) && rawRound > 0 ? rawRound : null;
  const awayTeamId = resolveTeamId(String(gameInfo?.aCode ?? "").trim(), "");
  const homeTeamId = resolveTeamId(String(gameInfo?.hCode ?? "").trim(), "");
  if (
    !/^\d{8}$/.test(gameDate) ||
    !/^\d{2}:\d{2}$/.test(gameTime) ||
    awayTeamId <= 0 ||
    homeTeamId <= 0 ||
    String(gameInfo?.statusCode ?? "") !== "4" ||
    String(gameInfo?.cancelFlag ?? "") !== "N"
  ) return null;
  const rheb = sb?.rheb;
  if (!rheb?.away || !rheb?.home) return null;
  const awayE = parseErrorCell(rheb.away.e);
  const homeE = parseErrorCell(rheb.home.e);
  const awayR = parseErrorCell(rheb.away.r);
  const homeR = parseErrorCell(rheb.home.r);
  // 한쪽만 유효하면 그 경기는 통째로 미확인 — 반쪽 사실로 태그를 만들지 않는다.
  if (awayE === null || homeE === null || awayR === null || homeR === null) return null;
  return {
    source: "naver",
    gameId: null,
    gameDate,
    gameTime,
    gameRound,
    awayTeamId,
    homeTeamId,
    away: awayE,
    home: homeE,
    awayRuns: awayR,
    homeRuns: homeR,
  };
}

export interface GameErrorFetchers {
  kbo?: (gameId: string, signal?: AbortSignal) => Promise<unknown>;
  naver?: (gameId: string, signal?: AbortSignal) => Promise<unknown>;
  /** Naver record 에 없는 exact gameId 를 같은 날짜 schedule 로 교차검증한다. */
  naverSchedule?: (gameId: string, signal?: AbortSignal) => Promise<KboGame[]>;
}

async function defaultKboFetch(gameId: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(KBO_SCOREBOARD, {
    method: "POST",
    headers: KBO_HEADERS,
    body: `leId=1&srId=0&seasonId=${gameId.slice(0, 4)}&gameId=${gameId}`,
    cache: "no-store",
    signal,
  });
  if (!res.ok) return null;
  return res.json();
}

async function defaultNaverFetch(gameId: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(`${NAVER_RECORD}/${gameId}${gameId.slice(0, 4)}/record`, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; KboEveryday/1.0)" },
    cache: "no-store",
    signal,
  });
  if (!res.ok) return null;
  return res.json();
}

async function defaultNaverScheduleFetch(
  gameId: string,
  signal?: AbortSignal,
): Promise<KboGame[]> {
  return fetchNaverGames(gameId.slice(0, 8), undefined, { signal });
}

/** 직관 경기 canonical — 원천의 경기 identity·팀·final score 를 exact 대조한다. */
export interface CanonicalGame {
  gameId: string;
  awayTeamId: number;
  homeTeamId: number;
  awayScore: number;
  homeScore: number;
}

/**
 * Naver record 자체에는 exact gameId 가 없으므로 schedule 의 exact 경기와 record 를
 * **시작시각 유일성**으로 결속한다.
 *
 * ⚠️ 이전 구현은 `gameInfo.round` 끝자리를 DH 회차 suffix(1/2)로 봤는데 **틀렸다**
 * (삼순 P1 2026-08-02). `round` 는 DH 회차가 아니라 시즌 라운드다 — 2024-06-23 실측에서
 * KT–LG 만 우연히 `11/12` 였고 한화–KIA 는 `7/8`, 두산–삼성은 `8/9` 였다. 그 가정을
 * 계약으로 두면 KBO 장애 시 대부분의 DH fallback 이 조용히 전부 탈락한다
 * (실측: `HHHT1·HHHT2·OBSS1·OBSS2` 전부 null).
 *
 * 그래서 회차 추론을 버리고, 같은 날짜·같은 대진 후보 중 **record 의 시작시각과 일치하는
 * 경기가 정확히 하나일 때만** 채택한다. 둘 이상이 같은 시각이면 record 만으로는 어느
 * 경기인지 구별할 근거가 없으므로 fail-close 한다(추측으로 태그를 만들지 않는다).
 */
function matchesNaverScheduleWitness(
  observed: RawErrorObservation,
  exact: KboGame,
  schedule: readonly KboGame[],
): boolean {
  if (observed.gameTime === null) return false;
  if (observed.gameTime !== exact.time) return false;

  const sameStartTime = schedule.filter(
    (game) =>
      game.date === exact.date &&
      game.awayTeamId === exact.awayTeamId &&
      game.homeTeamId === exact.homeTeamId &&
      game.time === observed.gameTime,
  );
  // 시작시각이 exact 경기 하나로 좁혀질 때만 결속을 인정한다.
  return sameStartTime.length === 1 && sameStartTime[0]?.gameId === exact.gameId;
}

/**
 * 경기 1건의 팀별 실책. KBO → Naver failover. 확인 불가면 null.
 *
 * `canonical` 을 주면 소스 응답의 경기 identity·팀·최종 득점을 **exact 대조**해서,
 * 다른 경기·중간 상태 응답을 채택하지 않는다(삼순 P0). 대조에 실패하면 다음
 * 소스로 넘어간다.
 */
export async function fetchGameErrors(
  gameId: string,
  options: {
    fetchers?: GameErrorFetchers;
    canonical?: CanonicalGame | null;
    signal?: AbortSignal;
  } = {},
): Promise<GameErrorCounts | null> {
  const { fetchers = {}, canonical = null, signal } = options;

  const matchesCanonical = (o: RawErrorObservation) =>
    canonical == null ||
    (canonical.gameId === gameId &&
      (o.source === "kbo"
        ? o.gameId === canonical.gameId
        : o.gameDate === canonical.gameId.slice(0, 8)) &&
      o.awayTeamId === canonical.awayTeamId &&
      o.homeTeamId === canonical.homeTeamId &&
      o.awayRuns === canonical.awayScore &&
      o.homeRuns === canonical.homeScore);

  try {
    if (signal?.aborted) return null;
    const raw = fetchers.kbo
      ? await fetchers.kbo(gameId, signal)
      : await defaultKboFetch(gameId, signal);
    const observed = parseKboErrorObservation(raw);
    if (observed && matchesCanonical(observed)) {
      return { away: observed.away, home: observed.home };
    }
  } catch {
    // KBO 실패는 삼키고 Naver 로 — 단, Naver 도 실패하면 null(미확인).
  }

  try {
    if (signal?.aborted) return null;
    const raw = fetchers.naver
      ? await fetchers.naver(gameId, signal)
      : await defaultNaverFetch(gameId, signal);
    const observed = parseNaverErrorObservation(raw);
    if (observed && matchesCanonical(observed)) {
      // Naver record.gameInfo 에는 exact gameId 가 없다. 날짜·팀·스코어만 맞추면
      // 동일 조건의 DH 1/2차전을 서로 오인할 수 있으므로, canonical 조회에서는
      // 같은 날짜 schedule 의 exact gameId/final/team/score witness 를 추가로 요구한다.
      // 주입 naver fetcher 가 schedule seam 을 주지 않으면 테스트/호출도 fail-close한다.
      if (canonical !== null) {
        const schedule = fetchers.naverSchedule
          ? await fetchers.naverSchedule(gameId, signal)
          : fetchers.naver
            ? null
            : await defaultNaverScheduleFetch(gameId, signal);
        const exact = schedule?.find((game) => game.gameId === canonical.gameId);
        if (
          !exact ||
          exact.status !== "final" ||
          exact.awayTeamId !== canonical.awayTeamId ||
          exact.homeTeamId !== canonical.homeTeamId ||
          exact.awayScore !== canonical.awayScore ||
          exact.homeScore !== canonical.homeScore ||
          !matchesNaverScheduleWitness(observed, exact, schedule ?? [])
        ) return null;
      }
      return { away: observed.away, home: observed.home };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * complete-only 결과 캐시 (삼순 P1 2026-08-02).
 *
 * 종료 경기의 실책은 **불변 사실**이라 한 번 확정하면 다시 조회할 이유가 없다.
 * 그런데 `GET /api/me/venue-stats` 는 매 요청마다 전 직관 경기를 조회하고 있었다
 * (삼순 실측: 동일 경기 2회 호출 시 KBO fetch 2회).
 *
 * ⚠️ **성공 + canonical 일치만 캐시한다.** 미확인·timeout·identity/스코어 불일치는 캐시하지
 * 않는다 — 그걸 캐시하면 소스가 정상화돼도 영원히 "모름"으로 굳는다(no-store 후 재시도).
 * canonical 이 없는 조회(비final 등)도 캐시하지 않는다. 확정 근거가 없기 때문이다.
 */
const completeCache = new Map<string, GameErrorCounts>();

/**
 * 동일 경기 동시 요청 합류(single-flight).
 *
 * ⚠️ shared flight 는 **첫 호출자의 signal 에 종속되면 안 된다**(삼순 P1 2026-08-02).
 * 예전 구현은 첫 호출의 controller signal 로 fetch 를 걸어놔서, deadline 40ms 인 A 와
 * 500ms 인 B 가 같은 경기를 동시에 요청하면 A 의 abort 가 공유 task 를 죽이고
 * **B 까지 실패**했다(실측: A=null, B=null, source call=1, abort=1).
 *
 * 그래서 shared flight 는 **자체 controller** 로 돌리고, 대기자 수를 세어
 * **모든 대기자가 이탈했을 때만** 취소한다. 각 대기자는 자기 deadline 으로 race 하므로
 * 자기 예산 안에서 독립적으로 성공/실패한다.
 */
interface SharedFlight {
  promise: Promise<GameErrorCounts | null>;
  controller: AbortController;
  waiters: number;
}
const inFlight = new Map<string, SharedFlight>();

function cacheKey(gameId: string, canonical: CanonicalGame): string {
  return [
    gameId,
    canonical.gameId,
    canonical.awayTeamId,
    canonical.homeTeamId,
    canonical.awayScore,
    canonical.homeScore,
  ].join("|");
}

/** 테스트 전용 — 캐시/single-flight 상태 초기화. */
export function __resetGameErrorCaches(): void {
  completeCache.clear();
  inFlight.clear();
}

/**
 * 캐시·single-flight 를 적용한 조회. canonical 이 있는 경기만 캐시 대상이다.
 */
async function fetchGameErrorsCached(
  gameId: string,
  options: {
    fetchers?: GameErrorFetchers;
    canonical?: CanonicalGame | null;
    signal?: AbortSignal;
  },
): Promise<GameErrorCounts | null> {
  const canonical = options.canonical ?? null;
  // canonical 이 없으면 확정 근거가 없다 — 캐시도 합류도 하지 않는다.
  if (canonical === null) return fetchGameErrors(gameId, options);

  const key = cacheKey(gameId, canonical);
  const cached = completeCache.get(key);
  if (cached) return cached;

  let flight = inFlight.get(key);
  if (!flight) {
    const controller = new AbortController();
    const created: SharedFlight = {
      controller,
      waiters: 0,
      // shared flight 는 자체 signal 로만 취소된다 — 개별 호출자 signal 을 넘기지 않는다.
      promise: (async () => {
        const counts = await fetchGameErrors(gameId, {
          fetchers: options.fetchers,
          canonical,
          signal: controller.signal,
        });
        // 성공만 캐시. 미확인은 다음 요청에서 다시 시도할 수 있어야 한다.
        if (counts) completeCache.set(key, counts);
        return counts;
      })().finally(() => {
        // 같은 key 로 이미 새 flight 가 들어섰다면 그걸 지우지 않는다.
        if (inFlight.get(key) === created) inFlight.delete(key);
      }),
    };
    inFlight.set(key, created);
    flight = created;
  }

  const shared = flight;
  shared.waiters += 1;
  const release = () => {
    shared.waiters -= 1;
    // 마지막 대기자까지 떠났으면 그때 취소한다(고아 네트워크 작업 방지).
    if (shared.waiters <= 0 && inFlight.get(key) === shared) {
      inFlight.delete(key);
      shared.controller.abort();
    }
  };

  // 호출자 자신의 signal 로만 자기 대기를 끊는다. 다른 대기자에게 전파되지 않는다.
  const callerSignal = options.signal;
  if (!callerSignal) {
    try {
      return await shared.promise;
    } finally {
      release();
    }
  }
  try {
    return await new Promise<GameErrorCounts | null>((resolve, reject) => {
      if (callerSignal.aborted) { resolve(null); return; }
      const onAbort = () => resolve(null);
      callerSignal.addEventListener("abort", onAbort, { once: true });
      shared.promise.then(
        (v) => { callerSignal.removeEventListener("abort", onAbort); resolve(v); },
        (e) => { callerSignal.removeEventListener("abort", onAbort); reject(e); },
      );
    });
  } finally {
    release();
  }
}

/**
 * 직관 경기 여러 건의 팀별 실책을 동시성·deadline 안에서 조회.
 *
 * ⚠️ deadline 은 **실제 fetch 까지 abort** 한다(삼순 P1). 바깥 Promise 만 풀면
 * 네트워크 작업이 뒤에서 계속 살아 있어 "bounded" 가 이름뿐이 된다.
 *
 * **확인 못 한 경기는 Map 에 넣지 않는다** — 호출측이 "키 부재 = 미확인"으로 읽는다.
 */
export async function fetchGameErrorsWithinDeadline(
  games: readonly { gameId: string; canonical?: CanonicalGame | null }[],
  options: {
    deadlineMs?: number;
    maxConcurrency?: number;
    fetchers?: GameErrorFetchers;
  } = {},
): Promise<Map<string, GameErrorCounts>> {
  const out = new Map<string, GameErrorCounts>();
  const seen = new Set<string>();
  const queue = games.filter((g) => {
    if (seen.has(g.gameId)) return false;
    seen.add(g.gameId);
    return true;
  });
  if (queue.length === 0) return out;

  const controller = new AbortController();
  const deadlineMs = options.deadlineMs ?? 6_000;
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  const maxConcurrency = Math.max(1, options.maxConcurrency ?? 5);
  let cursor = 0;

  /** deadline 이 지나면 대기 자체를 끊는다 — signal 을 무시하는 fetcher 도 여기서 풀린다. */
  const abortRace = new Promise<null>((resolve) => {
    if (controller.signal.aborted) { resolve(null); return; }
    controller.signal.addEventListener("abort", () => resolve(null), { once: true });
  });

  async function worker() {
    while (cursor < queue.length && !controller.signal.aborted) {
      const item = queue[cursor++]!;
      try {
        const counts = await Promise.race([
          fetchGameErrorsCached(item.gameId, {
            fetchers: options.fetchers,
            canonical: item.canonical ?? null,
            signal: controller.signal,
          }),
          abortRace,
        ]);
        if (counts) out.set(item.gameId, counts);
      } catch {
        // 개별 실패는 미확인으로 남긴다(키 부재).
      }
    }
  }

  try {
    await Promise.all(
      Array.from({ length: Math.min(maxConcurrency, queue.length) }, () => worker()),
    );
  } finally {
    clearTimeout(timer);
    // 남은 in-flight 네트워크 작업까지 취소한다(bounded 계약).
    controller.abort();
  }
  return out;
}
