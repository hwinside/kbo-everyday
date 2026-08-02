/**
 * 직관 경기의 팀별 실책(E) 조회 — `발암경기 인내형` 태그 데이터 소스.
 *
 * 하린아빠 2026-08-02: "발암경기 인내형 태그도 추가해줘".
 *
 * ⚠️ **player_game_logs 에 실책 컬럼을 추가하지 않는다.** canonical payload hash(§12)가
 * 20필드 전체를 묶어 계산되므로 컬럼을 하나 끼우면 해시가 전부 바뀌고, 운영 ledger
 * complete 468경기가 통째로 `payload_hash_mismatch` 로 떨어져 B/C 집계가 fail-close 된다
 * (실측: 20필드 `9fb53858…` vs 21필드 `53a253a3…`). 실책은 팀 단위 지표라 선수별로
 * 쪼갤 이유도 없다 — 이미 존재하는 linescore 의 `E` 를 그대로 쓴다.
 *
 * ⚠️ **데이터소스 failover 는 이 파일이 SSOT** (AGENTS P0 2026-07-30 재발방지).
 * KBO 단독 경로를 새로 만들지 않는다. KBO `GetScoreBoard` → 실패/결손 시 Naver record
 * 순으로 타고, 둘 다 실패하면 그 경기는 **미확인**으로 남긴다(0 으로 채우지 않는다 —
 * 0 은 "실책 없음"이라는 사실 주장이고, 조회 실패는 사실이 아니라 무지다).
 */
import { fetchGameLinescore } from "@/lib/crawler/kbo-api";
import { fetchNaverLinescore } from "@/lib/crawler/naver-record";

/** 한 경기의 원정/홈 실책 수. */
export interface GameErrorCounts {
  away: number;
  home: number;
}

/**
 * 실책 수로 인정할 수 있는 값인지. 음수·비정수·비현실적 값은 결손으로 본다.
 * 실측 상한은 4(2026 시즌 200경기 400 팀-경기)라 여유를 크게 두되, 파싱 사고를
 * 사실로 승격시키지는 않는다.
 */
const MAX_PLAUSIBLE_ERRORS = 30;

function validCount(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isInteger(v)) return null;
  if (v < 0 || v > MAX_PLAUSIBLE_ERRORS) return null;
  return v;
}

function toCounts(side: { away?: { E?: number }; home?: { E?: number } } | null): GameErrorCounts | null {
  if (!side?.away || !side?.home) return null;
  const away = validCount(side.away.E);
  const home = validCount(side.home.E);
  // 한쪽만 유효하면 그 경기는 통째로 미확인 — 반쪽 사실로 태그를 만들지 않는다.
  if (away === null || home === null) return null;
  return { away, home };
}

export interface GameErrorFetchers {
  kbo?: (gameId: string) => Promise<{ away?: { E?: number }; home?: { E?: number } } | null>;
  naver?: (gameId: string) => Promise<{ away?: { E?: number }; home?: { E?: number } } | null>;
}

/**
 * 경기 1건의 팀별 실책. KBO → Naver failover. 확인 불가면 null.
 *
 * KBO 가 200 을 주면서 이닝표를 비우는 열화(2026-07-30 P0)가 실재하므로,
 * "응답이 왔다"가 아니라 **값이 유효한가**로 판정하고 아니면 Naver 로 넘어간다.
 */
export async function fetchGameErrors(
  gameId: string,
  fetchers: GameErrorFetchers = {},
): Promise<GameErrorCounts | null> {
  const kbo = fetchers.kbo ?? ((id: string) => fetchGameLinescore(id));
  const naver = fetchers.naver ?? ((id: string) => fetchNaverLinescore(id));

  try {
    const fromKbo = toCounts(await kbo(gameId));
    if (fromKbo) return fromKbo;
  } catch {
    // KBO 실패는 삼키고 Naver 로 — 단, 아래에서 Naver 도 실패하면 null(미확인).
  }
  try {
    return toCounts(await naver(gameId));
  } catch {
    return null;
  }
}

/**
 * 직관 경기 여러 건의 팀별 실책을 동시성·deadline 안에서 조회.
 *
 * 유저 1인의 직관 경기는 실측 최대 4경기라 비용이 작지만, KBO 장애가 API 전체를
 * 붙잡지 않도록 기존 `fetchAttendanceGamesWithinDeadline` 과 같은 계약을 쓴다.
 * **확인 못 한 경기는 Map 에 넣지 않는다** — 호출측이 "키 부재 = 미확인"으로 읽는다.
 */
export async function fetchGameErrorsWithinDeadline(
  gameIds: readonly string[],
  options: {
    deadlineMs?: number;
    maxConcurrency?: number;
    fetchers?: GameErrorFetchers;
  } = {},
): Promise<Map<string, GameErrorCounts>> {
  const out = new Map<string, GameErrorCounts>();
  const ids = [...new Set(gameIds)];
  if (ids.length === 0) return out;

  const deadlineAt = Date.now() + (options.deadlineMs ?? 6_000);
  const maxConcurrency = Math.max(1, options.maxConcurrency ?? 5);
  let cursor = 0;

  async function worker() {
    while (cursor < ids.length && Date.now() < deadlineAt) {
      const gameId = ids[cursor++];
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) return;
      const counts = await new Promise<GameErrorCounts | null>((resolve) => {
        const timer = setTimeout(() => resolve(null), remainingMs);
        void fetchGameErrors(gameId, options.fetchers).then(
          (v) => { clearTimeout(timer); resolve(v); },
          () => { clearTimeout(timer); resolve(null); },
        );
      });
      if (counts) out.set(gameId, counts);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(maxConcurrency, ids.length) }, () => worker()),
  );
  return out;
}
