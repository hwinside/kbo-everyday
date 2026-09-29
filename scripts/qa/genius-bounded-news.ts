import assert from "node:assert/strict";
import { createProductionAgentPorts } from "../../src/lib/baseball-qa/agent/production";
import { tournamentSearch, newsTermFilter } from "../../src/lib/baseball-qa/agent/bounded-news";
import { runVerifiedFallback } from "../../src/lib/baseball-qa/agent/fallback";

/** Actual production adapter wiring, with transport only replaced. No external requests. */
export async function boundedNewsContracts() {
  assert.equal(tournamentSearch("아시안게임과 WBC 비교"), null);
  assert.equal(tournamentSearch("그럼 언제야"), null, "no stale-history subject inference");
  assert.ok(tournamentSearch("아시안게임 일정"));
  assert.ok(newsTermFilter("아시안게임")?.includes("title.ilike.*아시안*"));
  assert.equal(newsTermFilter("오늘"), null);
  assert.ok(!newsTermFilter('LG),or(secret.eq.true')?.includes('secret.eq.true'));
  const keys = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "GEMINI_API_KEY"] as const;
  const saved = keys.map(key => process.env[key]); const originalFetch = globalThis.fetch;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://db.example.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "fixture"; process.env.GEMINI_API_KEY = "fixture";
  const input = { question: "아시안게임 야구 일정", now: "2026-09-29T03:00:00Z", history: [] };
  let models = 0, searches = 0;
  let invalid = false, rejected = false, stale = false, searchAgain = false, legacy = false;
  const urls: URL[] = [];
  globalThis.fetch = async (raw, init) => {
    const url = new URL(String(raw));
    if (url.hostname === "db.example.test") {
      searches++; urls.push(url);
      assert.equal(url.pathname, "/rest/v1/genius_news_articles", "explicit tournament never searches slow wiki");
      assert.equal(url.searchParams.get("limit"), "6");
      assert.equal(url.searchParams.get("collected_at"), `lte.${input.now}`);
      assert.deepEqual(url.searchParams.getAll("published_at"), ["gte.2026-08-30T03:00:00.000Z", `lte.${input.now}`]);
      if (!legacy) assert.ok(url.searchParams.get("and")?.includes("or(title.ilike.*게임*,content.ilike.*게임*)"));
      return Response.json([{ article_key: "test", title: "아시안게임 야구 일정", content: "야구 대표팀은 대회 일정을 추후 발표할 예정입니다.", link: "https://sports.naver.com/news/1", published_at: stale ? "2026-09-28T00:00:00Z" : input.now }]);
    }
    assert.equal(url.hostname, "generativelanguage.googleapis.com"); models++;
    const request = JSON.parse(String(init?.body));
    const state = JSON.parse(request.contents[0].parts[0].text);
    const answer = searchAgain ? { action: "search", source: "wiki", query: input.question, terms: ["아시안게임"] } : state.claims ? { supported: !rejected, temporalSupported: true, answersCore: true }
      : { action: "answer", claims: [{ text: state.evidence[0].content, citations: [{ id: state.evidence[0].id, quote: invalid ? "없는 인용을 만들어 냈습니다." : state.evidence[0].content }] }] };
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] });
  };
  try {
    const result = await runVerifiedFallback(input, createProductionAgentPorts());
    assert.equal(result?.source, "news_rag");
    assert.equal(models, 2, "one synthesis plus one independent verification; no planner model");
    assert.ok(searches > 0 && searches <= 3);
    assert.ok(urls.some(url => url.searchParams.has("or")), "intent predicate precedes limit");
    assert.ok(urls.some(url => !url.searchParams.has("or")), "retain broad lane");
    models = 0; invalid = true;
    assert.equal(await runVerifiedFallback(input, createProductionAgentPorts()), null);
    assert.equal(models, 1, "invalid citation cannot enter repeated repair/model loop");
    invalid = false; searchAgain = true; models = 0; searches = 0;
    assert.equal(await runVerifiedFallback(input, createProductionAgentPorts()), null);
    assert.equal(models, 1, "post-seed search action must stop without further model calls");
    assert.equal(searches, 2, "post-seed search action must never reach wiki/another search");
    searchAgain = false; legacy = true; urls.length = 0;
    await createProductionAgentPorts().search({ source: "news", query: "오늘 삼성 퓨처스팀 어디 가?", terms: ["삼성 퓨처스", "삼성 라이온즈"] }, input.now, new AbortController().signal);
    assert.deepEqual(urls.map(url => url.searchParams.get("content")), ["ilike.*삼성*퓨처스*", "ilike.*삼성*라이온즈*"]);
    assert.ok(urls.every(url => !url.searchParams.has("and") && !url.searchParams.has("or")), "non-tournament deployed retrieval unchanged");
    legacy = false; rejected = true;
    assert.equal(await runVerifiedFallback(input, createProductionAgentPorts()), null, "independent semantic reject still enforced");
    rejected = false; stale = true;
    assert.equal(await runVerifiedFallback({ ...input, question: "오늘 아시안게임 일정" }, createProductionAgentPorts()), null, "today guard cannot be bypassed by prefetched evidence");
    // The transport ignores cancellation: outer deadline must still bound the request.
    globalThis.fetch = () => new Promise(() => {});
    const began = Date.now();
    assert.equal(await runVerifiedFallback(input, createProductionAgentPorts(), 3000), null);
    assert.ok(Date.now() - began < 4000, "search ignoring abort is bounded");
  } finally {
    globalThis.fetch = originalFetch;
    keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; });
  }
}
