/**
 * Fault-injection smoke for contextual-stats live-source failover and deadline.
 */
import "./_smoke-env";
import assert from "node:assert/strict";
import {
  fetchContextualBeforeDeadline,
  fetchLiveGame,
} from "@/app/api/contextual-stats/route";
import type { KboGame } from "@/lib/crawler/kbo-api";
import {
  fetchKboLiveGames,
  naverGameToRaw,
} from "@/lib/notifications/kbo-live-games";

const GAME_ID = "20260731LTOB0";
const keepAlive = setInterval(() => {}, 1_000);

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function naverGame(isTop: boolean, batter: string, pitcher: string): KboGame {
  return {
    gameId: GAME_ID,
    date: "20260731",
    time: "18:30",
    stadium: "사직",
    awayName: "롯데",
    homeName: "두산",
    awayScore: 1,
    homeScore: 2,
    inning: 4,
    isTop,
    status: "live",
    strikes: 1,
    balls: 2,
    outs: 1,
    runnersOn: { first: false, second: false, third: false },
    currentPitcher: pitcher,
    currentBatter: batter,
  };
}

const evidence = async () => ({
  hasRealPlay: true,
  balls: 2,
  strikes: 1,
  outs: 1,
  runner1b: false,
  runner2b: false,
  runner3b: false,
  runner1bOrder: 0,
  runner2bOrder: 0,
  runner3bOrder: 0,
  currentPitcher: "네이버투수",
  currentBatter: "네이버타자",
});

type LiveGames = typeof fetchKboLiveGames;
type NaverFetcher = Parameters<LiveGames>[3];
type EvidenceFetcher = Parameters<LiveGames>[4];

function shared(
  kboFetch: typeof fetch,
  naverFetch: NaverFetcher,
  evidenceFetch: EvidenceFetcher = evidence,
): LiveGames {
  return ((
    date: string,
    deadlineAtMs?: number,
    _fetchImpl?: typeof fetch,
    _fetchNaverImpl?: NaverFetcher,
    _fetchNaverEvidenceImpl?: EvidenceFetcher,
    requiredGameId?: string,
  ) =>
    fetchKboLiveGames(
      date,
      deadlineAtMs,
      kboFetch,
      naverFetch,
      evidenceFetch,
      requiredGameId,
    )) as LiveGames;
}

function abortAwareHang(): typeof fetch {
  return ((_url: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(new DOMException("aborted", "AbortError"));
        return;
      }
      signal?.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true },
      );
    })) as typeof fetch;
}

async function main() {
  // T1: KBO 정상 응답은 공용 helper에서 그대로 사용한다.
  {
    const raw = naverGameToRaw(naverGame(true, "KBO타자", "KBO투수"));
    const kboFetch = (async () => response({ game: [raw] })) as typeof fetch;
    let naverCalls = 0;
    const naverFetch = (async () => {
      naverCalls += 1;
      return [];
    }) as NaverFetcher;
    const snapshot = await fetchLiveGame(
      GAME_ID,
      shared(kboFetch, naverFetch),
      Date.now() + 500,
    );
    assert.equal(snapshot?.batterName, "KBO타자");
    assert.equal(snapshot?.pitcherName, "KBO투수");
    assert.equal(naverCalls, 0);
  }

  // T2: KBO 200-empty도 authoritative empty로 확정하지 않고 Naver를 사용한다.
  {
    const kboFetch = (async () => response({ game: [] })) as typeof fetch;
    let naverCalls = 0;
    const naverFetch = (async () => {
      naverCalls += 1;
      return [naverGame(true, "", "")];
    }) as NaverFetcher;
    const snapshot = await fetchLiveGame(
      GAME_ID,
      shared(kboFetch, naverFetch),
      Date.now() + 500,
    );
    assert.equal(snapshot?.batterName, "네이버타자");
    assert.equal(snapshot?.pitcherName, "네이버투수");
    assert.equal(naverCalls, 1);
  }

  // T3: KBO에 다른 경기만 있고 요청 경기 부재여도 Naver로 교차확인한다.
  {
    const otherRaw = {
      ...naverGameToRaw(naverGame(true, "다른타자", "다른투수")),
      G_ID: "20260731XXYY0",
    };
    const kboFetch = (async () => response({ game: [otherRaw] })) as typeof fetch;
    let naverCalls = 0;
    const naverFetch = (async () => {
      naverCalls += 1;
      return [naverGame(true, "", "")];
    }) as NaverFetcher;
    const snapshot = await fetchLiveGame(
      GAME_ID,
      shared(kboFetch, naverFetch),
      Date.now() + 500,
    );
    assert.equal(snapshot?.batterName, "네이버타자");
    assert.equal(naverCalls, 1);
  }

  // T4: KBO hard-hang은 sub-budget에서 끊고 남은 reserve로 Naver에 도달한다.
  {
    let naverCalls = 0;
    const naverFetch = (async () => {
      naverCalls += 1;
      return [naverGame(false, "", "")];
    }) as NaverFetcher;
    const startedAt = Date.now();
    const snapshot = await fetchLiveGame(
      GAME_ID,
      shared(abortAwareHang(), naverFetch),
      Date.now() + 2_000,
    );
    assert.equal(snapshot?.batterName, "네이버타자");
    assert.equal(snapshot?.pitcherName, "네이버투수");
    assert.equal(naverCalls, 1);
    assert.ok(Date.now() - startedAt < 2_000);
  }

  // T5: Naver partial(해당 경기 없음)은 추측하지 않고 null degrade.
  {
    const kboFetch = (async () => response({}, 500)) as typeof fetch;
    const naverFetch = (async () => [
      { ...naverGame(true, "", ""), gameId: "20260731XXYY0" },
    ]) as NaverFetcher;
    const snapshot = await fetchLiveGame(
      GAME_ID,
      shared(kboFetch, naverFetch),
      Date.now() + 500,
    );
    assert.equal(snapshot, null);
  }

  // T6: Naver timeout도 전체 deadline 안에서 null degrade.
  {
    const kboFetch = (async () => response({}, 500)) as typeof fetch;
    const naverFetch = (async (
      _date: string,
      _srId?: string,
      opts?: { signal?: AbortSignal },
    ) => new Promise<KboGame[]>((_resolve, reject) => {
      opts?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true },
      );
    })) as NaverFetcher;
    const startedAt = Date.now();
    const snapshot = await fetchLiveGame(
      GAME_ID,
      shared(kboFetch, naverFetch),
      Date.now() + 80,
    );
    assert.equal(snapshot, null);
    assert.ok(Date.now() - startedAt < 250);
  }

  // T7: dual-fail도 null degrade.
  {
    const kboFetch = (async () => response({}, 500)) as typeof fetch;
    const naverFetch = (async () => {
      throw new Error("Naver down");
    }) as NaverFetcher;
    const snapshot = await fetchLiveGame(
      GAME_ID,
      shared(kboFetch, naverFetch),
      Date.now() + 500,
    );
    assert.equal(snapshot, null);
  }

  // T8: Box/Profile이 사용하는 공용 fetch wrapper도 hard-hang을 deadline에서 끊는다.
  {
    const startedAt = Date.now();
    const result = await fetchContextualBeforeDeadline(
      "https://example.invalid/hang",
      { cache: "no-store" },
      Date.now() + 60,
      abortAwareHang(),
    );
    assert.equal(result, null);
    assert.ok(Date.now() - startedAt < 250);
  }

  clearInterval(keepAlive);
  console.log("contextual-stats-naver-failover: 8/8 PASS");
}

main().catch((error) => {
  clearInterval(keepAlive);
  console.error(error);
  process.exit(1);
});
