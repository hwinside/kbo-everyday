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

/** 한 경기의 원정/홈 실책 수. */
export interface GameErrorCounts {
  away: number;
  home: number;
}

/** 소스가 돌려준 raw 관측값. `null` = 그 소스에서 확인 불가. */
export interface RawErrorObservation {
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
  const cancelName = String(
    (meta as Record<string, unknown> | null)?.CANCEL_SC_NM ?? "",
  );
  if (cancelName.includes("취소") || cancelName.includes("우천")) return null;
  // 종료 경기만 — 진행 중 스코어보드의 중간 실책을 최종값으로 쓰지 않는다.
  if (!String((meta as Record<string, unknown> | null)?.END_TM ?? "").trim()) return null;

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
  return { away: away.errors, home: home.errors, awayRuns: away.runs, homeRuns: home.runs };
}

/** Naver record raw → 실책 관측. `rheb.*.e` 가 실제로 숫자일 때만 채택. */
export function parseNaverErrorObservation(json: unknown): RawErrorObservation | null {
  const sb = (json as Record<string, never> | null)?.result?.["recordData"]?.["scoreBoard"] as
    | { rheb?: { away?: Record<string, unknown>; home?: Record<string, unknown> } }
    | undefined;
  const rheb = sb?.rheb;
  if (!rheb?.away || !rheb?.home) return null;
  const awayE = parseErrorCell(rheb.away.e);
  const homeE = parseErrorCell(rheb.home.e);
  const awayR = parseErrorCell(rheb.away.r);
  const homeR = parseErrorCell(rheb.home.r);
  // 한쪽만 유효하면 그 경기는 통째로 미확인 — 반쪽 사실로 태그를 만들지 않는다.
  if (awayE === null || homeE === null || awayR === null || homeR === null) return null;
  return { away: awayE, home: homeE, awayRuns: awayR, homeRuns: homeR };
}

export interface GameErrorFetchers {
  kbo?: (gameId: string, signal?: AbortSignal) => Promise<unknown>;
  naver?: (gameId: string, signal?: AbortSignal) => Promise<unknown>;
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

/** 직관 경기의 canonical 최종 스코어 — stale/다른 경기 응답을 걸러내는 기준. */
export interface CanonicalScore {
  awayScore: number;
  homeScore: number;
}

/**
 * 경기 1건의 팀별 실책. KBO → Naver failover. 확인 불가면 null.
 *
 * `canonical` 을 주면 소스 응답의 최종 득점과 **exact 대조**해서, 다른 경기·중간
 * 상태 응답을 채택하지 않는다(삼순 P0). 대조에 실패하면 다음 소스로 넘어간다.
 */
export async function fetchGameErrors(
  gameId: string,
  options: {
    fetchers?: GameErrorFetchers;
    canonical?: CanonicalScore | null;
    signal?: AbortSignal;
  } = {},
): Promise<GameErrorCounts | null> {
  const { fetchers = {}, canonical = null, signal } = options;

  const matchesCanonical = (o: RawErrorObservation) =>
    canonical == null ||
    (o.awayRuns === canonical.awayScore && o.homeRuns === canonical.homeScore);

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
      return { away: observed.away, home: observed.home };
    }
    return null;
  } catch {
    return null;
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
  games: readonly { gameId: string; canonical?: CanonicalScore | null }[],
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
          fetchGameErrors(item.gameId, {
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
