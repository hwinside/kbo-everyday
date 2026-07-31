/**
 * Fault-injection smoke for contextual-stats live-source failover and deadline.
 */
import "./_smoke-env";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import {
  GET,
  fetchContextualBeforeDeadline,
  fetchLiveGame,
  readTextBeforeDeadline,
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

  // T9: readTextBeforeDeadline은 headers 200 후 body-stall을 절대 deadline에서 null degrade.
  {
    const stallSignalStream = (signal?: AbortSignal | null): Response => {
      const stream = new ReadableStream({
        start(controller) {
          if (signal?.aborted) {
            controller.error(new DOMException("aborted", "AbortError"));
            return;
          }
          signal?.addEventListener(
            "abort",
            () => controller.error(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const ac = new AbortController();
    const res = stallSignalStream(ac.signal);
    const startedAt = Date.now();
    // deadline이 지난 후 호출이지만(remaining<=0) 멈추지 않고 null로 degrade.
    setTimeout(() => ac.abort(), 40);
    const text = await readTextBeforeDeadline(res, Date.now() + 60);
    assert.equal(text, null);
    assert.ok(Date.now() - startedAt < 400);
  }

  // ===== actual GET(req) headers+body-stall 회귀 =====
  // KBO 200 헤더 후 box/basic/situation 본문이 멈춰도 route가 500이 아니라 200(empty degrade)로
  // 응답해야 한다(삼순 NO-GO: actual GET 7.003s 후 reject/500 재현 차단).
  const liveRaw = (gameId: string): Record<string, unknown> => ({
    G_ID: gameId,
    GAME_STATE_SC: "2",
    AWAY_NM: "롯데",
    HOME_NM: "두산",
    GAME_TB_SC: "T",
    T_P_NM: "김도영",
    B_P_NM: "원태인",
    GAME_INN_NO: 4,
    OUT_CN: 1,
    BALL_CN: 2,
    STRIKE_CN: 1,
    B1_BAT_ORDER_NO: 0,
    B2_BAT_ORDER_NO: 0,
    B3_BAT_ORDER_NO: 0,
    SR_ID: "1",
  });

  const bodyStallFetch = (
    gameId: string,
    shouldStall: (url: string) => boolean,
  ): typeof fetch =>
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url;
      if (url.includes("GetKboGameList")) {
        return new Response(JSON.stringify({ game: [liveRaw(gameId)] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (shouldStall(url)) {
        const signal = init?.signal;
        const stream = new ReadableStream({
          start(controller) {
            if (signal?.aborted) {
              controller.error(new DOMException("aborted", "AbortError"));
              return;
            }
            signal?.addEventListener(
              "abort",
              () => controller.error(new DOMException("aborted", "AbortError")),
              { once: true },
            );
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // 비-stall KBO 호출(box/basic/situation 중 대상 아닌 것)은 빠른 hard-fail → null degrade
      // (프로필 캐시 오염 없이 대상 read site만 격리 검증).
      return new Response("", { status: 500 });
    }) as typeof fetch;

  const runGetWithStall = async (
    gameId: string,
    shouldStall: (url: string) => boolean,
  ): Promise<{ status: number; body: { gameId?: string } }> => {
    const prevFetch = globalThis.fetch;
    globalThis.fetch = bodyStallFetch(gameId, shouldStall);
    try {
      const req = new NextRequest(
        `http://localhost/api/contextual-stats?gameId=${gameId}`,
      );
      const res = await GET(req);
      const body = (await res.json()) as { gameId?: string };
      return { status: res.status, body };
    } finally {
      globalThis.fetch = prevFetch;
    }
  };

  // T10: GetBoxScore 본문 stall → actual GET HTTP 200.
  {
    const out = await runGetWithStall("20260731LTOB0", (u) =>
      u.includes("GetBoxScore"),
    );
    assert.equal(out.status, 200);
    assert.equal(out.body.gameId, "20260731LTOB0");
  }

  // T11: HitterDetail/PitcherDetail Basic.aspx 본문 stall → actual GET HTTP 200.
  {
    const out = await runGetWithStall("20260731LTOB1", (u) =>
      u.includes("Basic.aspx"),
    );
    assert.equal(out.status, 200);
    assert.equal(out.body.gameId, "20260731LTOB1");
  }

  // T12: Situation.aspx 본문 stall → actual GET HTTP 200.
  {
    const out = await runGetWithStall("20260731LTOB2", (u) =>
      u.includes("Situation.aspx"),
    );
    assert.equal(out.status, 200);
    assert.equal(out.body.gameId, "20260731LTOB2");
  }

  // T13: box+basic+situation 동시 stall도 actual GET HTTP 200(전 read site 동시 degrade).
  {
    const out = await runGetWithStall(
      "20260731LTOB3",
      (u) =>
        u.includes("GetBoxScore") ||
        u.includes("Basic.aspx") ||
        u.includes("Situation.aspx"),
    );
    assert.equal(out.status, 200);
    assert.equal(out.body.gameId, "20260731LTOB3");
  }

  clearInterval(keepAlive);
  console.log("contextual-stats-naver-failover: 13/13 PASS");
}

main().catch((error) => {
  clearInterval(keepAlive);
  console.error(error);
  process.exit(1);
});
