import assert from "node:assert/strict";
import { officialEventRequest, officialEventEvidence } from "../../src/lib/baseball-qa/agent/official-events";
import { createProductionAgentPorts } from "../../src/lib/baseball-qa/agent/production";
import { AGENT_POC_PROMPT } from "../../src/lib/baseball-qa/agent/poc";
import { resolveAllowedSource, splitProvenanceForDisplay } from "../../src/lib/baseball-qa/genius-reply-provenance";

export async function officialEventContracts() {
  const now = "2026-09-29T10:00:00Z";
  const question = "아시안게임 야구 일정 알려줘";
  const request = officialEventRequest(question, now);
  assert.ok(request); assert.equal(request.source, "official");
  const rows = officialEventEvidence(request, now);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].content.includes("9월 21일부터 27일까지"));
  assert.ok(rows[0].content.includes("김주원(NC)"));
  assert.equal(officialEventRequest(question, "2026-09-12T00:00:00Z"), null, "no backdating snapshot into historical evaluation");
  assert.equal(officialEventRequest(question, "2026-09-29T09:36:35.512Z"), null, "one millisecond before capture");
  assert.ok(officialEventRequest(question, "2026-09-29T09:36:35.513Z"));
  assert.equal(officialEventRequest(question, "2026-12-31T15:00:00Z"), null, "KST new year cannot silently reuse2026");
  assert.ok(officialEventRequest("2026 아시안게임 야구 일정", "2027-01-01T00:00:00Z"));
  for (const q of ["2018 아시안게임 언제야", "2026과2023 아시안게임 일정 비교", "아시안게임과 WBC 일정", "오늘 아시안게임 야구 일정", "아시안게임 결과 알려줘", "여자 아시안게임 야구 명단", "아시안게임 일본대표팀 명단", "아시안게임 축구 일정", "그럼 언제야"]) {
    assert.equal(officialEventRequest(q, now), null, q);
  }
  assert.equal(officialEventEvidence({ source: "official", query: "WBC 일정", terms: request.terms }, now).length, 0);
  assert.equal(resolveAllowedSource("https://www.olympics.com.evil.test/ko/news/1"), null);
  const link = resolveAllowedSource(rows[0].url); assert.equal(link?.label, "Olympics.com 공식 자료");
  assert.deepEqual(splitProvenanceForDisplay("답변\n\n📄 출처: Olympics.com 공식 자료", rows[0].url), { body: "답변", provenance: link });
  assert.equal(splitProvenanceForDisplay("답변\n\n📄 출처: OlympicsXcom 공식 자료").provenance, null, "label regex dot must be literal");
  const flag = process.env.BASEBALL_GENIUS_OFFICIAL_EVENT_EVIDENCE;
  try { process.env.BASEBALL_GENIUS_OFFICIAL_EVENT_EVIDENCE = "0"; assert.equal(officialEventRequest(question, now), null); }
  finally { if (flag === undefined) delete process.env.BASEBALL_GENIUS_OFFICIAL_EVENT_EVIDENCE; else process.env.BASEBALL_GENIUS_OFFICIAL_EVENT_EVIDENCE = flag; }
  // Actual adapter selects the reviewed event source before any DB/model transport.
  const keys = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "GEMINI_API_KEY"] as const;
  const saved = keys.map(key => process.env[key]); const originalFetch = globalThis.fetch;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://db.example.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "fixture"; process.env.GEMINI_API_KEY = "fixture";
  globalThis.fetch = async () => { throw new Error("event retrieval must not fetch network or DB"); };
  try {
    const ports = createProductionAgentPorts();
    const action = await ports.decide(AGENT_POC_PROMPT, { question, now, trace: [], evidence: [], history: [] }, new AbortController().signal);
    assert.deepEqual(action, { action: "search", ...request });
    assert.deepEqual(await ports.search(request, now, new AbortController().signal), rows);
  } finally {
    globalThis.fetch = originalFetch;
    keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; });
  }
}
