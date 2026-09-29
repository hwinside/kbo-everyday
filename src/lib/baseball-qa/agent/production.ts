import { BASEBALL_QA_GEMINI_MODEL } from "../gemini-request";
import { searchWiki, toEvidence } from "./search-adapters";
import { runVerifiedFallback, FALLBACK_VERIFY_PROMPT } from "./fallback";
import { AGENT_POC_PROMPT, type AgentPorts, type ConversationInput, type Evidence } from "./poc";
import { tournamentSearch, newsTermFilter, newsIntentFilter } from "./bounded-news";

/** Read-only, bounded production adapters. No CLI import, full-corpus scan or writes. */
export function createProductionAgentPorts(): AgentPorts {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const databaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!base || !databaseKey || !apiKey || new URL(base).protocol !== "https:") throw new Error("agent_configuration_missing");
  const read = async (table: string, params: URLSearchParams, signal: AbortSignal): Promise<Record<string, unknown>[]> => {
    const url = new URL(`/rest/v1/${table}`, base);
    url.search = params.toString();
    const response = await fetch(url, { signal, headers: { apikey: databaseKey, Authorization: `Bearer ${databaseKey}` } });
    if (!response.ok) throw new Error("agent_search_failed");
    const rows: unknown = await response.json();
    if (!Array.isArray(rows)) throw new Error("agent_search_invalid");
    return rows;
  };
  return {
    decide: async (system, state, signal) => {
      const context = state && typeof state === "object" ? state as Record<string, unknown> : {};
      const seeded = system === AGENT_POC_PROMPT && typeof context.question === "string"
        ? tournamentSearch(context.question) : null;
      if (seeded && Array.isArray(context.trace) && context.trace.length === 0) return { action: "search", ...seeded };
      // One synthesis plus the unchanged independent verifier. No repeated planning/repair loop.
      if (seeded && context.citationFeedback) return { action: "insufficient", reason: "invalid_citations" };
      const partialPolicy = "전체 일정·명단·결과가 없다는 이유만으로 확인된 부분 사실까지 버리지 않는다. 질문과 직접 관련된 사실을 단일 기사에서 확인할 수 있으면 그 부분을 답하고, 확인하지 못한 범위를 같은 답변에서 명시한다. 전체 명단 질문에는 확인된 발탁 선수만 일부로 소개하고 전체 명단 미확인을 알린다. 결과 질문에 경기 예고만 있으면 예고라고 구분하고 경기 결과는 확인하지 못했다고 밝힌다. 무관한 정보를 대신 답하거나 과거 예고를 현재 진행/확정 결과로 바꾸면 안 된다. 인용은 한 문서의 원문 그대로 유지한다.";
      const tournament = typeof context.question === "string" && tournamentSearch(context.question);
      const prompt = seeded ? system + "\n검색은 이미 완료되었다. 추가 search는 금지한다. " + partialPolicy
        : tournament && system === FALLBACK_VERIFY_PROMPT ? system + "\n" + partialPolicy
        : system;
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${BASEBALL_QA_GEMINI_MODEL}:generateContent`, {
        method: "POST", signal, headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: prompt + "\n운영 보조 검색에서는 official 도구가 연결되지 않았다. news 또는 wiki만 사용한다." }] },
          contents: [{ role: "user", parts: [{ text: JSON.stringify(state) }] }],
          generationConfig: { temperature: 0, responseMimeType: "application/json", maxOutputTokens: 2500 } }),
      });
      if (!response.ok) throw new Error("agent_model_failed");
      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text ?? "").join("");
      if (!text) throw new Error("agent_model_empty");
      const action = JSON.parse(text);
      if (seeded && action?.action === "search") return { action: "insufficient", reason: "bounded_search_complete" };
      return action;
    },
    search: async (request, now, signal) => {
      if (request.source === "wiki") return searchWiki(request.terms, now, signal, read);
      // KBO rules cannot establish international tournament schedules/results. Production
      // fallback deliberately has no official adapter; existing official RAG is unchanged.
      if (request.source !== "news") return [];
      if (!tournamentSearch(request.query)) {
        // Non-tournament path is byte-for-byte the deployed retrieval policy.
        const found = [];
        for (const term of [...new Set(request.terms)].slice(0, 3)) {
          const cleaned = term.replace(/[^\p{L}\p{N}\s]/gu, " ").trim();
          if (cleaned.length < 2 || /^(야구|경기|선수|일정|결과|뉴스|최근|오늘)$/.test(cleaned)) continue;
          const params = new URLSearchParams({ select: "article_key,title,content,link,published_at",
            content: `ilike.*${cleaned.replace(/\s+/g, "*")}*`, collected_at: `lte.${now}`,
            order: "published_at.desc,article_key.asc", limit: "6" });
          params.append("published_at", `gte.${new Date(Date.parse(now) - 30 * 86400000).toISOString()}`);
          params.append("published_at", `lte.${now}`);
          // query-guard: bounded -- deployed max 3 terms x 6 rows, no vectors/corpus download.
          const rows = await read("genius_news_articles", params, signal);
          found.push(...rows.map(row => toEvidence(row, "news")));
        }
        return [...new Map(found.map(row => [row.id, row])).values()].slice(0, 6);
      }
      const terms = [...new Set(request.terms)].slice(0, 3);
      const intent = newsIntentFilter(request.query);
      // At most 3 parallel DB reads x 6 rows. Narrow lane before broad lane; no corpus scan.
      const lanes = terms.map(term => ({ term, intent: null as string | null }));
      if (intent && lanes.length < 3 && terms.length) lanes.unshift({ term: terms[0], intent });
      const batches = await Promise.all(lanes.slice(0, 3).map(async lane => {
        const filter = newsTermFilter(lane.term);
        if (!filter) return [];
        const params = new URLSearchParams({ select: "article_key,title,content,link,published_at",
          and: `(${filter})`, collected_at: `lte.${now}`,
          order: "published_at.desc,article_key.asc", limit: "6" });
        if (lane.intent) params.set("or", `(${lane.intent})`);
        params.append("published_at", `gte.${new Date(Date.parse(now) - 30 * 86400000).toISOString()}`);
        params.append("published_at", `lte.${now}`);
        // query-guard: bounded -- max 3 queries x 6 rows; predicates before LIMIT, no vector/corpus download.
        const rows = await read("genius_news_articles", params, signal);
        return rows.map(row => toEvidence(row, "news"));
      }));
      // Interleave lanes so a broad or secondary-topic match is not hidden by six narrow hits.
      const found: Evidence[] = [];
      for (let index = 0; index < 6; index++) for (const batch of batches) if (batch[index]) found.push(batch[index]);
      return [...new Map(found.map(row => [row.id, row])).values()].slice(0, 6);
    },
  };
}

export async function productionAgentFallback(input: ConversationInput, budgetMs: number) {
  // Default-on after reviewed deployment; explicit server-side kill switch restores old replies.
  if (process.env.BASEBALL_GENIUS_AGENT_FALLBACK === "0") return null;
  try { return await runVerifiedFallback(input, createProductionAgentPorts(), budgetMs); }
  catch { return null; }
}
