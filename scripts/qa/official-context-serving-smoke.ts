/** Offline: execute the real official server call with synthetic credentials + mocked fetch. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { contextRoutingRequest } from "../baseball-qa/rag/experimental-context-routing";
import { buildRagLlmRequest, RAG_TEAM_SYSTEM_PROMPT, RAG_OFFICIAL_SYSTEM_PROMPT, type RagEvidence, type RagRequestExtras } from "../../src/lib/baseball-qa/rag/retrieve";

async function main() {
  const oldEnv = { ...process.env };
  const oldFetch = globalThis.fetch;
  let calls = 0;
  try {
    // Never import the server against actual credentials in this contract check.
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://offline.invalid";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "offline-anon";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "offline-service";
    process.env.GEMINI_API_KEY = "offline-gemini";
    globalThis.fetch = async () => { throw new Error("unexpected network"); };
    const server = await import("../../src/lib/baseball-qa/server");
    const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/official-parenthetical-serving.json",import.meta.url),"utf8"));
    const sample = fixture.rows.find((x: {row:{section:string}}) => x.row.section.includes("40. INFIELD FLY"));
    assert.ok(sample);
    const evidence: RagEvidence[] = [{content:sample.row.text,canonicalUrl:sample.row.canonicalUrl,
      revision:sample.row.revision,sectionPath:sample.row.section,pageTitle:"2026 공식야구규칙",
      sourceKind:"kbo_ebook",sourceGrade:"tier1",asOf:"2026-10-02"}];
    const referenceTimeMs = Date.UTC(2026,9,2);
    const variants: RagRequestExtras[] = [
      {referenceTimeMs},
      {referenceTimeMs,context:{question:"포구는 뭐야?",answer:"잘못된 이전 답변"}},
      {referenceTimeMs,context:{question:"포구는 뭐야?",answer:"이전 답변"},recordbookRequest:true},
      {referenceTimeMs,context:{question:"포구는 뭐야?",answer:"이전 답변"},recordbookRequest:true,allowRecordbookGeneral:true},
    ];
    for (const extras of variants) {
      const q = "그건 플라이아웃 아니야?";
      const expected = contextRoutingRequest(q,evidence,extras);
      assert.deepEqual(server.buildProductionRagRequest(q,evidence,RAG_OFFICIAL_SYSTEM_PROMPT,extras),expected);
      assert.deepEqual(server.buildProductionRagRequest(q,evidence,RAG_TEAM_SYSTEM_PROMPT,extras),buildRagLlmRequest(q,evidence,RAG_TEAM_SYSTEM_PROMPT,extras));
      assert.deepEqual(server.buildProductionRagRequest(q,evidence,undefined,extras),buildRagLlmRequest(q,evidence,undefined,extras));
      globalThis.fetch = async (_url, init) => {
        calls++;
        assert.deepEqual(JSON.parse(String(init?.body)),expected);
        return new Response(JSON.stringify({candidates:[{content:{parts:[{text:"mocked"}]}}]}));
      };
      const before = calls;
      assert.equal((await server.callOfficialRagLlm(q,evidence,extras)).text,"mocked");
      assert.equal(calls,before+1,"exactly one existing official call");
    }
  } finally {
    globalThis.fetch = oldFetch;
    for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
    Object.assign(process.env,oldEnv);
  }
  console.log("PASS: real server official payload equals reviewed R4; other modes unchanged; one mocked call per request");
}
void main();
