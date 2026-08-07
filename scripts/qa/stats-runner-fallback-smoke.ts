// @crawl-managed-read: structural  (크롤 관리 데이터 파일을 구조·불변식 검증에만 사용 — 값 하드코딩 금지, 축② 순환참조 메타게이트)
import assert from "node:assert";
import test from "node:test";
import { NextRequest } from "next/server";
import { fetchAllRunnerRows, GET } from "../../src/app/api/stats/route";
import statsMeta from "../../src/lib/constants/stats-2026-meta.json";
import batterStats2026 from "../../src/lib/constants/stats-2026-batters.json";

const PAGER_PREFIX = "ctl00$ctl00$ctl00$cphContents$cphContents$cphContents$ucPager$";

function pageHtml(page: number, terminalPage = 11, coverStatic = false): string {
  const first = Math.floor((page - 1) / 5) * 5 + 1;
  const last = Math.min(first + 4, terminalPage);
  const links = [];
  for (let p = first; p <= last; p += 1) {
    links.push(
      `<a id="ucPager_btnNo${p - first + 1}"${p === page ? ' class="on"' : ""} ` +
        `href="javascript:__doPostBack(&#39;${PAGER_PREFIX}btnNo${p - first + 1}&#39;,&#39;&#39;)">${p}</a>`,
    );
  }
  if (page < terminalPage) {
    links.push(
      `<a href="javascript:__doPostBack(&#39;${PAGER_PREFIX}btnNext&#39;,&#39;&#39;)">next</a>`,
    );
  }
  const count = page === 11 && terminalPage === 11 ? 29 : 30;
  const rows = Array.from({ length: count }, (_, index) => {
    const globalIndex = (page - 1) * 30 + index;
    const staticPlayer = coverStatic ? batterStats2026[globalIndex] : undefined;
    const isKim = page === 2 && index === 0;
    const isStaticOnly = page === 3 && index === 0;
    const name = staticPlayer?.name ?? (isKim ? "김도영" : isStaticOnly ? "전다민" : `선수${page}-${index}`);
    const team = staticPlayer?.team ?? (isKim ? "KIA" : isStaticOnly ? "두산" : "팀");
    const sb = name === "전다민" && team === "두산" ? 9 : staticPlayer?.sb ?? (isKim ? 6 : isStaticOnly ? 9 : 0);
    const cs = name === "전다민" && team === "두산" ? 4 : staticPlayer?.cs ?? (isKim ? 1 : isStaticOnly ? 4 : 0);
    return `<tr><td>${(page - 1) * 30 + index + 1}</td><td>${name}</td>` +
      `<td>${team}</td><td>1</td><td>1</td><td>${sb}</td>` +
      `<td>${cs}</td><td>0</td><td>0</td><td>0</td></tr>`;
  }).join("");
  return `<form><input type="hidden" name="__VIEWSTATE" value="vs-${page}" />` +
    `<input type="hidden" name="__VIEWSTATEGENERATOR" value="vg" />` +
    `<input type="hidden" name="__EVENTVALIDATION" value="ev-${page}" />` +
    `<tbody>${rows}</tbody>${links.join("")}</form>`;
}

test("production helper가 session+postback으로 11페이지 329행을 전수 수집한다", async () => {
  let currentPage = 1;
  const requests: Array<{ method: string; body: string; cookie: string }> = [];
  const fakeFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = String(init?.body ?? "");
    const cookie = new Headers(init?.headers).get("cookie") ?? "";
    requests.push({ method, body, cookie });
    if (method === "POST") {
      assert.match(body, new RegExp(`__VIEWSTATE=vs-${currentPage}`));
      assert.strictEqual(cookie, "ASP.NET_SessionId=test-session");
      currentPage += 1;
    }
    return new Response(pageHtml(currentPage), {
      status: 200,
      headers: currentPage === 1 ? { "set-cookie": "ASP.NET_SessionId=test-session; path=/" } : {},
    });
  }) as typeof fetch;

  const rows = await fetchAllRunnerRows(fakeFetch);
  assert.strictEqual(rows.length, 329);
  assert.strictEqual(requests.length, 11);
  assert.strictEqual(requests.filter((request) => request.method === "POST").length, 10);
  const kim = rows.find((row) => row[1] === "김도영");
  assert.deepStrictEqual(kim?.slice(1, 7), ["김도영", "KIA", "1", "1", "6", "1"]);
});

test("중간 POST 실패 시 부분 rows를 성공으로 반환하지 않는다", async () => {
  let calls = 0;
  const fakeFetch = (async () => {
    calls += 1;
    if (calls === 4) return new Response("fail", { status: 503 });
    return new Response(pageHtml(calls), {
      status: 200,
      headers: calls === 1 ? { "set-cookie": "ASP.NET_SessionId=test-session; path=/" } : {},
    });
  }) as typeof fetch;
  await assert.rejects(fetchAllRunnerRows(fakeFetch), /Runner page 4 POST HTTP 503/);
});

function basicHtml(): string {
  const rows = batterStats2026.slice(0, 250).map((player, index) =>
    `<tr><td>${index + 1}</td><td>${player.name}</td><td>${player.team}</td><td>${player.avg}</td>` +
      `<td>${player.games}</td><td>${player.pa}</td><td>${player.ab}</td><td>${player.runs}</td>` +
      `<td>${player.hits}</td><td>${player.doubles}</td><td>${player.triples}</td>` +
      `<td>${player.hr}</td><td>${player.tb}</td><td>${player.rbi}</td><td>${player.sac}</td>` +
      `<td>${player.sf}</td></tr>`,
  ).join("");
  return `<tbody>${rows}</tbody>`;
}

function routeFetch(options: { runnerPostFails?: boolean; runnerEarlyEndAt?: number }): typeof fetch {
  let runnerPage = 1;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!url.includes("/Record/Player/Runner/Basic.aspx")) {
      return new Response(basicHtml(), { status: 200 });
    }
    if ((init?.method ?? "GET") === "POST") {
      if (options.runnerPostFails) return new Response("fail", { status: 503 });
      runnerPage += 1;
    }
    return new Response(pageHtml(runnerPage, options.runnerEarlyEndAt ?? 11, true), {
      status: 200,
      headers: runnerPage === 1 ? { "set-cookie": "ASP.NET_SessionId=route-test; path=/" } : {},
    });
  }) as typeof fetch;
}

test("actual GET full=1이 static-only 선수도 live Runner 값으로 보정하고 source를 노출한다", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = routeFetch({});
  try {
    const response = await GET(new NextRequest(
      `http://localhost/api/stats?type=batter&full=1&season=qa-live-${Date.now()}`,
    ));
    const body = await response.json();
    const player = body.stats.find((row: { name: string; team: string }) =>
      row.name === "전다민" && row.team === "두산");
    assert.deepStrictEqual({ sb: player?.sb, cs: player?.cs }, { sb: 9, cs: 4 });
    assert.strictEqual(body.runnerSource, "live");
    assert.ok(Date.now() - Date.parse(body.runnerUpdatedAt) < 5_000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("actual GET은 Runner 중간 실패 시 static 전체 fallback과 stale timestamp를 사실대로 노출한다", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = routeFetch({ runnerPostFails: true });
  try {
    const response = await GET(new NextRequest(
      `http://localhost/api/stats?type=batter&full=1&season=qa-fallback-${Date.now()}`,
    ));
    const body = await response.json();
    const player = body.stats.find((row: { name: string; team: string }) =>
      row.name === "전다민" && row.team === "두산");
    assert.deepStrictEqual({ sb: player?.sb, cs: player?.cs }, { sb: 1, cs: 0 });
    assert.strictEqual(body.source, "live+static-runner-fallback");
    assert.strictEqual(body.updatedAt, statsMeta.battersGeneratedAt);
    assert.strictEqual(body.runnerSource, "static-fallback");
    assert.strictEqual(body.runnerUpdatedAt, statsMeta.battersGeneratedAt);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("actual GET은 page 9 HTTP 200 조기 종료를 live로 채택하지 않고 static 전체로 전환한다", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = routeFetch({ runnerEarlyEndAt: 9 });
  try {
    const response = await GET(new NextRequest(
      `http://localhost/api/stats?type=batter&full=1&season=qa-early-end-${Date.now()}`,
    ));
    const body = await response.json();
    const player = body.stats.find((row: { name: string; team: string }) =>
      row.name === "최원준" && row.team === "KT");
    assert.strictEqual(body.runnerSource, "static-fallback");
    assert.strictEqual(body.updatedAt, statsMeta.battersGeneratedAt);
    assert.deepStrictEqual({ sb: player?.sb, cs: player?.cs }, { sb: 18, cs: 8 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
