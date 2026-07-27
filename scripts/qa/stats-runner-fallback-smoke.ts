import assert from "node:assert";
import test from "node:test";
import { fetchAllRunnerRows } from "../../src/app/api/stats/route";

const PAGER_PREFIX = "ctl00$ctl00$ctl00$cphContents$cphContents$cphContents$ucPager$";

function pageHtml(page: number): string {
  const first = Math.floor((page - 1) / 5) * 5 + 1;
  const last = Math.min(first + 4, 11);
  const links = [];
  for (let p = first; p <= last; p += 1) {
    links.push(
      `<a id="ucPager_btnNo${p - first + 1}"${p === page ? ' class="on"' : ""} ` +
        `href="javascript:__doPostBack(&#39;${PAGER_PREFIX}btnNo${p - first + 1}&#39;,&#39;&#39;)">${p}</a>`,
    );
  }
  if (page < 11) {
    links.push(
      `<a href="javascript:__doPostBack(&#39;${PAGER_PREFIX}btnNext&#39;,&#39;&#39;)">next</a>`,
    );
  }
  const count = page === 11 ? 29 : 30;
  const rows = Array.from({ length: count }, (_, index) => {
    const isKim = page === 2 && index === 0;
    return `<tr><td>${(page - 1) * 30 + index + 1}</td><td>${isKim ? "김도영" : `선수${page}-${index}`}</td>` +
      `<td>${isKim ? "KIA" : "팀"}</td><td>1</td><td>1</td><td>${isKim ? 6 : 0}</td>` +
      `<td>${isKim ? 1 : 0}</td><td>0</td><td>0</td><td>0</td></tr>`;
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
