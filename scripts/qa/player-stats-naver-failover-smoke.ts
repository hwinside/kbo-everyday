import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import {
  fetchNaverPlayerStats,
  parseNaverPlayerStats,
} from "../../src/lib/crawler/naver-player-stats";

const teamIds = ["LG", "OB", "KT", "SK", "NC", "HT", "LT", "SS", "HH", "WO"];
const teamNames = ["LG", "두산", "KT", "SSG", "NC", "KIA", "롯데", "삼성", "한화", "키움"];

function payload(type: "batter" | "pitcher", count: number) {
  const seasonPlayerStats = Array.from({ length: count }, (_, index) => {
    const teamIndex = index % teamIds.length;
    const common = {
      ranking: index + 1,
      playerId: String(50000 + index),
      playerName: `선수${index}`,
      teamId: teamIds[teamIndex],
      teamName: teamNames[teamIndex],
      isQualified: index < 30,
    };
    return type === "batter"
      ? {
          ...common,
          hitterHra: 0.3,
          hitterRbi: 30,
          hitterRun: 40,
          hitterHr: 5,
          hitterHit: 90,
          hitterH2: 15,
          hitterH3: 2,
          hitterGameCount: 80,
          hitterAb: 300,
          hitterSb: 7,
          hitterBb: 25,
          hitterHp: 3,
          hitterKk: 40,
          hitterObp: 0.36,
          hitterSlg: 0.413,
          hitterOps: 0.773,
        }
      : {
          ...common,
          pitcherEra: 3.25,
          pitcherWin: 7,
          pitcherLose: 3,
          pitcherSave: 0,
          pitcherHold: 2,
          pitcherGameCount: 20,
          pitcherInning: "88 2/3",
          pitcherKk: 80,
          pitcherHit: 70,
          pitcherHr: 6,
          pitcherR: 35,
          pitcherEr: 32,
          pitcherBb: 24,
          pitcherHp: 2,
          pitcherWra: 0.7,
          pitcherWhip: 1.06,
        };
  });
  return { success: true, code: 200, result: { seasonPlayerStats } };
}

function pitcherTableHtml(rowCount: number): string {
  const rows = Array.from({ length: rowCount }, (_, index) => {
    const cells = Array.from({ length: 19 }, () => "0");
    cells[0] = String(index + 1);
    cells[1] = `KBO투수${index}`;
    cells[2] = teamNames[index % teamNames.length];
    cells[3] = "3.25";
    cells[10] = "10";
    cells[18] = "1.20";
    return `<tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`;
  }).join("");
  return `<html><tbody>${rows}</tbody></html>`;
}

function batterTableHtml(kind: "basic1" | "basic2"): string {
  const columnCount = kind === "basic1" ? 16 : 12;
  const rows = Array.from({ length: 30 }, (_, index) => {
    const cells = Array.from({ length: columnCount }, () => "0");
    cells[0] = String(index + 1);
    cells[1] =
      index === 29
        ? kind === "basic1"
          ? "Basic1전용"
          : "Basic2전용"
        : `KBO타자${index}`;
    cells[2] = teamNames[index % teamNames.length];
    cells[3] = ".300";
    if (kind === "basic2") {
      cells[9] = ".400";
      cells[10] = ".350";
      cells[11] = ".750";
    }
    return `<tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`;
  }).join("");
  return `<html><tbody>${rows}</tbody></html>`;
}

async function main() {
  const batterPayload = payload("batter", 260);
  batterPayload.result.seasonPlayerStats[0].playerId = "54730";
  batterPayload.result.seasonPlayerStats[0].playerName = "페라자";
  batterPayload.result.seasonPlayerStats[0].teamId = "HH";
  batterPayload.result.seasonPlayerStats[0].teamName = "한화";
  const batters = parseNaverPlayerStats(batterPayload, "batter");
  assert.equal(batters.length, 260);
  assert.equal(batters[0].avg, ".300");
  assert.equal(batters[0].ops, ".773");
  assert.equal(batters[0].tb, 124);
  assert.equal(batters[0].playerId, "FP003");
  assert.equal(batters[0].kboId, "FP003");

  const pitcherPayload = payload("pitcher", 210);
  pitcherPayload.result.seasonPlayerStats[0].playerId = "56415";
  pitcherPayload.result.seasonPlayerStats[0].playerName = "미야지";
  pitcherPayload.result.seasonPlayerStats[0].teamId = "SS";
  pitcherPayload.result.seasonPlayerStats[0].teamName = "삼성";
  const pitchers = parseNaverPlayerStats(pitcherPayload, "pitcher");
  assert.equal(pitchers.length, 210);
  assert.equal(pitchers[0].era, "3.25");
  assert.equal(pitchers[0].ip, "88 2/3");
  assert.equal(pitchers[0].whip, "1.06");
  assert.equal(pitchers[0].playerId, "AQ003");
  assert.equal(pitchers[0].kboId, "AQ003");

  const partial = payload("batter", 249);
  assert.throws(() => parseNaverPlayerStats(partial, "batter"), /partial/);

  const duplicate = payload("batter", 260);
  duplicate.result.seasonPlayerStats[259].playerId =
    duplicate.result.seasonPlayerStats[0].playerId;
  assert.throws(() => parseNaverPlayerStats(duplicate, "batter"), /coverage/);

  const missingTeam = payload("pitcher", 210);
  for (const row of missingTeam.result.seasonPlayerStats) {
    if (row.teamId === "WO") {
      row.teamId = "LG";
      row.teamName = "LG";
    }
  }
  assert.throws(() => parseNaverPlayerStats(missingTeam, "pitcher"), /partial/);

  const wrongTeamName = payload("batter", 260);
  wrongTeamName.result.seasonPlayerStats[0].teamName = "가짜팀";
  assert.throws(
    () => parseNaverPlayerStats(wrongTeamName, "batter"),
    /coverage/,
  );

  const skewedTeams = payload("batter", 260);
  for (let i = 0; i < skewedTeams.result.seasonPlayerStats.length; i += 1) {
    const teamIndex = i < 241 ? 0 : Math.min(9, i - 240);
    skewedTeams.result.seasonPlayerStats[i].teamId = teamIds[teamIndex];
    skewedTeams.result.seasonPlayerStats[i].teamName = teamNames[teamIndex];
  }
  assert.throws(
    () => parseNaverPlayerStats(skewedTeams, "batter"),
    /partial/,
  );

  const invalidRate = payload("batter", 260);
  invalidRate.result.seasonPlayerStats[0].hitterHra = Number.NaN;
  assert.throws(() => parseNaverPlayerStats(invalidRate, "batter"), /required/);

  const missingCountingField = payload("batter", 260);
  missingCountingField.result.seasonPlayerStats[0].hitterRbi = undefined as unknown as number;
  assert.throws(
    () => parseNaverPlayerStats(missingCountingField, "batter"),
    /required/,
  );

  const invalidPitcherRate = payload("pitcher", 210);
  invalidPitcherRate.result.seasonPlayerStats[0].pitcherWhip = Number.NaN;
  assert.throws(
    () => parseNaverPlayerStats(invalidPitcherRate, "pitcher"),
    /required/,
  );

  const invalidPitcherInning = payload("pitcher", 210);
  invalidPitcherInning.result.seasonPlayerStats[0].pitcherInning = "not-an-inning";
  assert.throws(
    () => parseNaverPlayerStats(invalidPitcherInning, "pitcher"),
    /required/,
  );

  const responseStall = async (_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true },
      );
    });
  const responseStarted = Date.now();
  const keepAlive = setInterval(() => {}, 20);
  try {
    await assert.rejects(
      fetchNaverPlayerStats(
        "batter",
        2026,
        Date.now() + 60,
        [],
        responseStall as typeof fetch,
      ),
      /abort/i,
    );
  } finally {
    clearInterval(keepAlive);
  }
  assert.ok(Date.now() - responseStarted < 250, "response stall obeys deadline");

  const bodyStall = async () =>
    ({
      ok: true,
      json: () => new Promise<unknown>(() => {}),
    }) as Response;
  const bodyStarted = Date.now();
  const bodyKeepAlive = setInterval(() => {}, 20);
  try {
    await assert.rejects(
      fetchNaverPlayerStats(
        "batter",
        2026,
        Date.now() + 60,
        [],
        bodyStall as typeof fetch,
      ),
      /abort/i,
    );
  } finally {
    clearInterval(bodyKeepAlive);
  }
  assert.ok(Date.now() - bodyStarted < 250, "body stall obeys deadline");

  let naverPayload = payload("batter", 260);
  let kboMode:
    | "error"
    | "empty"
    | "stall"
    | "body-stall"
    | "partial-table"
    | "batter-basic2-gap" = "error";
  let naverMode: "ok" | "stall" = "ok";
  let naverCalls = 0;
  const originalFetch = global.fetch;
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role";
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("koreabaseball.com")) {
      if (kboMode === "batter-basic2-gap") {
        if (url.includes("/Runner/")) {
          return new Response("unavailable", { status: 503 });
        }
        return new Response(
          batterTableHtml(url.includes("/Basic2.aspx") ? "basic2" : "basic1"),
          { status: 200 },
        );
      }
      if (kboMode === "partial-table") {
        return new Response(pitcherTableHtml(10), { status: 200 });
      }
      if (kboMode === "empty") {
        return new Response("<html><tbody></tbody></html>", {
          status: 200,
          headers: { "set-cookie": "ASP.NET_SessionId=test" },
        });
      }
      if (kboMode === "body-stall") {
        return {
          ok: true,
          text: () => new Promise<string>(() => {}),
          headers: new Headers({ "set-cookie": "ASP.NET_SessionId=test" }),
        } as Response;
      }
      if (kboMode === "stall") {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      }
      return new Response("unavailable", { status: 503 });
    }
    if (url.includes("api-gw.sports.naver.com")) {
      naverCalls += 1;
      if (naverMode === "stall") {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      }
      return Response.json(naverPayload);
    }
    if (url.includes("example.supabase.co")) {
      return Response.json([], { status: 201 });
    }
    throw new Error(`unexpected URL: ${url}`);
  }) as typeof fetch;
  try {
    const { GET } = await import("../../src/app/api/stats/route");
    const response = await GET(
      new NextRequest("http://localhost/api/stats?type=batter&season=2026"),
    );
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.source, "naver-fallback");
    assert.equal(body.count, 260);
    assert.equal(body.stats[0].playerId, "50000");

    kboMode = "empty";
    const softEmptyResponse = await GET(
      new NextRequest("http://localhost/api/stats?type=batter&season=soft-empty"),
    );
    const softEmptyBody = await softEmptyResponse.json();
    assert.equal(softEmptyBody.source, "naver-fallback");

    kboMode = "error";
    naverPayload = payload("batter", 260);
    naverPayload.result.seasonPlayerStats[0].teamName = "가짜팀";
    const malformedNaverResponse = await GET(
      new NextRequest("http://localhost/api/stats?type=batter&season=current"),
    );
    const malformedNaverBody = await malformedNaverResponse.json();
    assert.equal(malformedNaverBody.source, "fallback");
    assert.ok(
      malformedNaverBody.stats.some(
        (row: { team?: string; name?: string }) => row.team === "LG" && row.name,
      ),
      "malformed Naver 200 falls back to static stats with LG players",
    );

    kboMode = "body-stall";
    naverPayload = payload("batter", 260);
    const bodyHangStarted = Date.now();
    const bodyHangResponse = await GET(
      new NextRequest("http://localhost/api/stats?type=batter&season=body-stall"),
    );
    const bodyHangBody = await bodyHangResponse.json();
    assert.equal(bodyHangBody.source, "naver-fallback");
    assert.ok(
      Date.now() - bodyHangStarted < 4_000,
      "KBO body hang preserves Naver reserve",
    );

    kboMode = "stall";
    naverPayload = payload("pitcher", 210);
    const hardHangStarted = Date.now();
    const pitcherResponse = await GET(
      new NextRequest("http://localhost/api/stats?type=pitcher&season=2026"),
    );
    const pitcherBody = await pitcherResponse.json();
    assert.equal(pitcherBody.source, "naver-fallback");
    assert.equal(pitcherBody.count, 210);
    assert.ok(
      Date.now() - hardHangStarted < 4_000,
      "KBO hard hang preserves Naver reserve",
    );

    kboMode = "partial-table";
    naverPayload = payload("pitcher", 210);
    const callsBeforePartial = naverCalls;
    const partialKboResponse = await GET(
      new NextRequest("http://localhost/api/stats?type=pitcher&season=kbo-partial"),
    );
    const partialKboBody = await partialKboResponse.json();
    assert.equal(partialKboBody.source, "naver-fallback");
    assert.equal(partialKboBody.count, 210);
    assert.equal(
      naverCalls,
      callsBeforePartial + 1,
      "10-row x 6 KBO sort partial calls Naver exactly once",
    );

    kboMode = "batter-basic2-gap";
    naverPayload = payload("batter", 260);
    const callsBeforeBasic2Gap = naverCalls;
    const basic2GapResponse = await GET(
      new NextRequest("http://localhost/api/stats?type=batter&season=basic2-gap"),
    );
    const basic2GapBody = await basic2GapResponse.json();
    assert.equal(basic2GapBody.source, "naver-fallback");
    assert.equal(basic2GapBody.count, 260);
    assert.equal(
      naverCalls,
      callsBeforeBasic2Gap + 1,
      "Basic1 player missing from Basic2 calls Naver exactly once",
    );

    kboMode = "stall";
    naverMode = "stall";
    const dualHangKeepAlive = setInterval(() => {}, 50);
    const dualHangStarted = Date.now();
    try {
      const dualHangResponse = await GET(
        new NextRequest("http://localhost/api/stats?type=pitcher&full=1"),
      );
      const dualHangBody = await dualHangResponse.json();
      assert.equal(dualHangBody.source, "fallback");
      assert.ok(
        Date.now() - dualHangStarted < 6_000,
        "dual hang terminates inside absolute deadline",
      );
    } finally {
      clearInterval(dualHangKeepAlive);
    }
  } finally {
    global.fetch = originalFetch;
  }

  console.log("player-stats Naver failover smoke: ALL assertions PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
