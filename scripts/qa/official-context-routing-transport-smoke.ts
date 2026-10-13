/** Offline transport contract; never sends network requests or reads real credentials. */
import assert from "node:assert/strict";
import { callContextRouting, contextRoutingRequest } from "../baseball-qa/rag/experimental-context-routing";
import { BASEBALL_QA_GEMINI_MODEL } from "../../src/lib/baseball-qa/gemini-request";
import { DEFINITION_REPAIR_TIMEOUT_MS } from "../../src/lib/baseball-qa/stats/definition-intent";

async function main() {
  const originalFetch = globalThis.fetch;
  const originalTimeout = AbortSignal.timeout;
  const originalKey = process.env.GEMINI_API_KEY;
  const request = contextRoutingRequest("질문", []);
  let calls = 0;
  let timeoutMs = 0;
  let reply: () => Response = () => new Response(JSON.stringify({
    candidates:[{content:{parts:[{}, {text:""}, {text:"answer"}, {text:"ignored"}]}}],
    usageMetadata:{promptTokenCount:12,candidatesTokenCount:3},
  }));
  try {
    process.env.GEMINI_API_KEY = "offline-test-key";
    AbortSignal.timeout = (ms) => { timeoutMs = ms; return new AbortController().signal; };
    globalThis.fetch = async (url, init) => {
      calls++;
      assert.equal(url, `https://generativelanguage.googleapis.com/v1beta/models/${BASEBALL_QA_GEMINI_MODEL}:generateContent`);
      assert.equal(init?.method, "POST");
      assert.deepEqual(init?.headers, {"Content-Type":"application/json", "x-goog-api-key":"offline-test-key"});
      assert.deepEqual(JSON.parse(String(init?.body)), request);
      assert.ok(init?.signal);
      return reply();
    };
    assert.deepEqual(await callContextRouting(request), {text:"answer",inputTokens:12,outputTokens:3});
    assert.equal(timeoutMs,15000);
    type Extras = NonNullable<Parameters<typeof callContextRouting>[1]>;
    await callContextRouting(request, {definition:{repair:true}} as Extras);
    assert.equal(timeoutMs,DEFINITION_REPAIR_TIMEOUT_MS);
    reply = () => new Response("{}");
    assert.deepEqual(await callContextRouting(request), {text:"",inputTokens:null,outputTokens:null});
    for (const status of [429,500]) {
      reply = () => new Response("", {status});
      const before = calls;
      await assert.rejects(callContextRouting(request), new RegExp(`Gemini API failed: ${status}`));
      assert.equal(calls,before+1,"no retry");
    }
    reply = () => new Response("not json");
    await assert.rejects(callContextRouting(request), SyntaxError);
    for (const error of [new Error("network"), new DOMException("timeout","TimeoutError")]) {
      reply = () => { throw error; };
      await assert.rejects(callContextRouting(request), e => e === error);
    }
    delete process.env.GEMINI_API_KEY;
    const before = calls;
    await assert.rejects(callContextRouting(request), /GEMINI_API_KEY missing/);
    assert.equal(calls,before);
  } finally {
    globalThis.fetch = originalFetch;
    AbortSignal.timeout = originalTimeout;
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;
  }
  console.log("PASS: timeout, body, model, parsing, missing key, HTTP/network/JSON errors; no retries/network");
}
void main();
