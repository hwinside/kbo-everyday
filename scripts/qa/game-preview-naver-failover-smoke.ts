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

function stubFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("http://localhost:54321/rest/v1/api_fallback_events")) {
      return Promise.resolve(response([], 201));
    }
    return Promise.resolve(handler(url, init));
  }) as typeof fetch;
}

// 실제 네트워크 hang(응답이 영원히 안 옴)을 모델링 — 명시적 절대 deadline 백스톱만이 이걸 끊을 수 있다.
function neverResolves(): Promise<Response> {
  return new Promise<Response>(() => {});
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

  // ── §blocker1: KBO 결함 4종(503/204/200-empty/hard-hang) 각각, 절대 deadline 안에서
  //    Naver reserve 로 경기 core+선발을 복구한다(elapsed 가 deadline 이하로 수렴). ──
  async function kboFaultRecoversViaNaver(
    label: string,
    kboResponder: () => Response | Promise<Response>,
  ) {
    stubFetch((url) => {
      if (url.includes("GetKboGameList")) return kboResponder();
      if (url.includes("schedule/games?")) {
        return response({ code: 200, success: true, result: { games: [naverScheduleGame()] } });
      }
      if (url.endsWith("/preview")) return response(naverPreview());
      throw new Error(`unexpected url ${url}`);
    });
    const deadlineMs = 1_200;
    const startedAt = Date.now();
    const game = await resolvePreviewGameContext(GAME_ID, undefined, undefined, {
      deadlineAtMs: Date.now() + deadlineMs,
      kboBudgetMs: 200,
    });
    const elapsed = Date.now() - startedAt;
    assert.equal(game.gameId, GAME_ID, `${label}: game core recovered`);
    assert.equal(game.awayTeamId, 9, `${label}: away team recovered from Naver`);
    assert.equal(game.homeTeamId, 3, `${label}: home team recovered from Naver`);
    assert.equal(game.awayStarterName, "류현진", `${label}: away starter from Naver preview`);
    assert.equal(game.homeStarterName, "소형준", `${label}: home starter from Naver preview`);
    assert.ok(elapsed < deadlineMs, `${label}: elapsed ${elapsed}ms < deadline ${deadlineMs}ms`);
  }

  await kboFaultRecoversViaNaver("KBO 503", () => response({}, 503));
  await kboFaultRecoversViaNaver("KBO 204", () => new Response(null, { status: 204 }));
  await kboFaultRecoversViaNaver("KBO 200-empty", () => response({ game: [] }));
  // hard-hang: 응답이 영원히 오지 않아도 runBeforeDeadline 백스톱이 budget 에서 끊고 reserve 진입.
  await kboFaultRecoversViaNaver("KBO hard-hang", () => neverResolves());

  // ── §Naver: KBO+Naver 일정이 동시에 hard-hang 이어도 전체 deadline 안에서 fail-close 수렴. ──
  {
    stubFetch((url) => {
      if (url.includes("GetKboGameList")) return neverResolves();
      if (url.includes("schedule/games?")) return neverResolves();
      throw new Error(`unexpected url ${url}`);
    });
    const deadlineMs = 800;
    const startedAt = Date.now();
    await assert.rejects(
      resolvePreviewGameContext(GAME_ID, undefined, undefined, {
        deadlineAtMs: Date.now() + deadlineMs,
        kboBudgetMs: 200,
      }),
      /unavailable/,
      "KBO+Naver 동시 hard-hang → unavailable",
    );
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < deadlineMs + 400, `Naver timeout: elapsed ${elapsed}ms 수렴(deadline ${deadlineMs}ms)`);
  }

  // ── §Naver partial: Naver preview 부분(홈 선발 미발표) → 경기 core + 발표된 원정 선발만
  //    보존하고, 미발표 홈 선발은 blank 로 degrade(크래시 없음). ──
  {
    stubFetch((url) => {
      if (url.includes("GetKboGameList")) return response({}, 503);
      if (url.includes("schedule/games?")) {
        return response({ code: 200, success: true, result: { games: [naverScheduleGame()] } });
      }
      if (url.endsWith("/preview")) {
        return response({
          code: 200,
          success: true,
          result: { previewData: {
            gameInfo: { gdate: 20260731, aCode: "HH", hCode: "KT" },
            awayStarter: { playerInfo: { name: "류현진" } },
          } },
        });
      }
      throw new Error(`unexpected url ${url}`);
    });
    const game = await resolvePreviewGameContext(GAME_ID);
    assert.equal(game.status, "scheduled");
    assert.equal(game.awayStarterName, "류현진", "partial: 발표된 원정 선발 보존");
    assert.equal(game.homeStarterName, "", "partial: 미발표 홈 선발 blank(무크래시)");
  }

  // ── §blocker2: dual-source 장애 + game_summaries 캐시 존재 → 저장된 AI 프리뷰를 서빙한다
  //    (503 아님, getCached 조회 0 아님). ──
  {
    const CACHED = { prediction: "cache-preserved", awayWinPct: 50, homeWinPct: 50 };
    let summariesReads = 0;
    stubFetch((url) => {
      if (url.includes("GetKboGameList")) return response({}, 503);
      if (url.includes("schedule/games?")) return response({}, 503);
      if (url.includes("/rest/v1/game_summaries")) {
        summariesReads += 1;
        return response([{ summary: CACHED, prompt_version: 999 }]);
      }
      throw new Error(`unexpected url ${url}`);
    });
    const res = await GET(
      new NextRequest(`http://localhost/api/game-preview?gameId=${GAME_ID}`),
    );
    assert.equal(res.status, 200, "dual-fail + 캐시 → 200 (503 아님)");
    const body = await res.json();
    assert.equal(body.source, "cache", "dual-fail + 캐시 → source=cache");
    assert.deepEqual(body.preview, CACHED, "저장된 AI 프리뷰 그대로 서빙");
    assert.ok(summariesReads >= 1, "getCached 조회 실제 발생(조회 0 아님)");
  }

  // ── §blocker2 대칭: dual-source 장애 + 캐시 없음 → 503 fail-close(기존 계약 그대로). ──
  {
    stubFetch((url) => {
      if (url.includes("GetKboGameList")) return response({}, 503);
      if (url.includes("schedule/games?")) return response({}, 503);
      if (url.includes("/rest/v1/game_summaries")) return response([]);
      throw new Error(`unexpected url ${url}`);
    });
    const res = await GET(
      new NextRequest(`http://localhost/api/game-preview?gameId=${GAME_ID}`),
    );
    assert.equal(res.status, 503, "dual-fail + 무캐시 → 503");
    assert.deepEqual(await res.json(), {
      preview: null,
      source: "unavailable",
      message: "경기 정보를 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.",
    });
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
