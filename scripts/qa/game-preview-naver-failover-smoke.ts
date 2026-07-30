import "./_smoke-env";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import {
  GET,
  resolvePreviewGameContext,
} from "@/app/api/game-preview/route";

const GAME_ID = "20260731HHKT0";
const realFetch = globalThis.fetch;

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function naverScheduleGame() {
  return {
    gameId: "20260731HHKT02026",
    gameDateTime: "2026-07-31T18:30:00",
    stadium: "수원",
    awayTeamCode: "HH",
    awayTeamName: "한화",
    awayTeamScore: 0,
    homeTeamCode: "KT",
    homeTeamName: "KT",
    homeTeamScore: 0,
    statusCode: "BEFORE",
    statusInfo: "경기전",
    cancel: false,
    suspended: false,
  };
}

function naverPreview() {
  return {
    code: 200,
    success: true,
    result: {
      previewData: {
        gameInfo: {
          gdate: 20260731,
          aCode: "HH",
          hCode: "KT",
        },
        awayStarter: { playerInfo: { name: "류현진" } },
        homeStarter: { playerInfo: { name: "소형준" } },
      },
    },
  };
}

function stubFetch(handler: (url: string) => Response | Promise<Response>) {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("http://localhost:54321/rest/v1/api_fallback_events")) {
      return Promise.resolve(response([], 201));
    }
    return Promise.resolve(handler(url));
  }) as typeof fetch;
}

async function main() {
  // KBO 정상 경로: 기존 선발/경기값을 그대로 쓰고 Naver를 호출하지 않는다.
  {
    let naverCalls = 0;
    stubFetch((url) => {
      if (url.includes("GetKboGameList")) {
        return response({
          game: [{
            G_ID: GAME_ID,
            G_DT: "20260731",
            G_TM: "18:30",
            S_NM: "수원",
            AWAY_ID: "HH",
            AWAY_NM: "한화",
            HOME_ID: "KT",
            HOME_NM: "KT",
            GAME_STATE_SC: "1",
            CANCEL_SC_ID: "0",
            GAME_TB_SC: "T",
            T_PIT_P_NM: "KBO원정선발",
            B_PIT_P_NM: "KBO홈선발",
          }],
        });
      }
      if (url.includes("api-gw.sports.naver.com")) naverCalls += 1;
      throw new Error(`unexpected url ${url}`);
    });
    const game = await resolvePreviewGameContext(GAME_ID);
    assert.equal(game.awayStarterName, "KBO원정선발");
    assert.equal(game.homeStarterName, "KBO홈선발");
    assert.equal(naverCalls, 0);
  }

  // 결함주입: KBO hard-fail + Naver 경기/preview 있음 → 일정·양팀·상태·선발 복구.
  {
    stubFetch((url) => {
      if (url.includes("GetKboGameList")) return response({}, 503);
      if (url.includes("schedule/games?")) {
        return response({
          code: 200,
          success: true,
          result: { games: [naverScheduleGame()] },
        });
      }
      if (url.endsWith("/preview")) return response(naverPreview());
      throw new Error(`unexpected url ${url}`);
    });
    const game = await resolvePreviewGameContext(GAME_ID);
    assert.equal(game.gameId, GAME_ID);
    assert.equal(game.date, "20260731");
    assert.equal(game.time, "18:30");
    assert.equal(game.stadium, "수원");
    assert.equal(game.awayTeamId, 9);
    assert.equal(game.homeTeamId, 3);
    assert.equal(game.awayName, "한화");
    assert.equal(game.homeName, "KT");
    assert.equal(game.status, "scheduled");
    assert.equal(game.awayStarterName, "류현진");
    assert.equal(game.homeStarterName, "소형준");
  }

  // 결함주입: KBO soft-empty도 Naver witness로 복구한다.
  {
    stubFetch((url) => {
      if (url.includes("GetKboGameList")) return response({ game: [] });
      if (url.includes("schedule/games?")) {
        return response({
          code: 200,
          success: true,
          result: { games: [naverScheduleGame()] },
        });
      }
      if (url.endsWith("/preview")) return response(naverPreview());
      throw new Error(`unexpected url ${url}`);
    });
    const game = await resolvePreviewGameContext(GAME_ID);
    assert.equal(game.awayStarterName, "류현진");
    assert.equal(game.homeStarterName, "소형준");
  }

  // Naver preview가 선발 발표 전이면 경기 core는 유지하고 선발만 비운다.
  {
    stubFetch((url) => {
      if (url.includes("GetKboGameList")) return response({}, 503);
      if (url.includes("schedule/games?")) {
        return response({
          code: 200,
          success: true,
          result: { games: [naverScheduleGame()] },
        });
      }
      if (url.endsWith("/preview")) {
        return response({
          code: 200,
          success: true,
          result: { previewData: { gameInfo: { gdate: 20260731, aCode: "HH", hCode: "KT" } } },
        });
      }
      throw new Error(`unexpected url ${url}`);
    });
    const game = await resolvePreviewGameContext(GAME_ID);
    assert.equal(game.status, "scheduled");
    assert.equal(game.awayStarterName, "");
    assert.equal(game.homeStarterName, "");
  }

  // KBO와 Naver 일정이 모두 실패하면 가짜 "경기 없음"으로 닫지 않는다.
  {
    stubFetch((url) => {
      if (url.includes("GetKboGameList")) return response({}, 503);
      if (url.includes("schedule/games?")) return response({}, 503);
      throw new Error(`unexpected url ${url}`);
    });
    await assert.rejects(resolvePreviewGameContext(GAME_ID), /HTTP 503|unavailable/);
    const routeResponse = await GET(
      new NextRequest(`http://localhost/api/game-preview?gameId=${GAME_ID}`),
    );
    assert.equal(routeResponse.status, 503);
    assert.deepEqual(await routeResponse.json(), {
      preview: null,
      source: "unavailable",
      message: "경기 정보를 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.",
    });
  }

  // Naver가 정상 응답했어도 요청 경기 자체가 없으면 fail-close한다.
  {
    stubFetch((url) => {
      if (url.includes("GetKboGameList")) return response({}, 503);
      if (url.includes("schedule/games?")) {
        return response({ code: 200, success: true, result: { games: [] } });
      }
      throw new Error(`unexpected url ${url}`);
    });
    await assert.rejects(resolvePreviewGameContext(GAME_ID), /unavailable/);
  }
}

main()
  .finally(() => {
    globalThis.fetch = realFetch;
  })
  .then(() => {
    console.log("game-preview Naver failover smoke: PASS");
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
