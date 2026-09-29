import { BASEBALL_QA_GEMINI_MODEL } from "../gemini-request";
import { searchWiki, toEvidence } from "./search-adapters";
import { runVerifiedFallback } from "./fallback";
import type { AgentPorts, ConversationInput } from "./poc";

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
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${BASEBALL_QA_GEMINI_MODEL}:generateContent`, {
        method: "POST", signal, headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: system + "\n운영 보조 검색에서는 official 도구가 연결되지 않았다. news 또는 wiki만 사용한다." }] },
          contents: [{ role: "user", parts: [{ text: JSON.stringify(state) }] }],
          generationConfig: { temperature: 0, responseMimeType: "application/json", maxOutputTokens: 2500 } }),
      });
      if (!response.ok) throw new Error("agent_model_failed");
      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text ?? "").join("");
      if (!text) throw new Error("agent_model_empty");
      return JSON.parse(text);
    },
    search: async (request, now, signal) => {
      if (request.source === "wiki") return searchWiki(request.terms, now, signal, read);
      // KBO rules cannot establish international tournament schedules/results. Production
      // fallback deliberately has no official adapter; existing official RAG is unchanged.
      if (request.source !== "news") return [];
      const found = [];
      for (const term of [...new Set(request.terms)].slice(0, 3)) {
        const cleaned = term.replace(/[^\p{L}\p{N}\s]/gu, " ").trim();
        if (cleaned.length < 2 || /^(야구|경기|선수|일정|결과|뉴스|최근|오늘)$/.test(cleaned)) continue;
        const params = new URLSearchParams({ select: "article_key,title,content,link,published_at",
          content: `ilike.*${cleaned.replace(/\s+/g, "*")}*`, collected_at: `lte.${now}`,
          order: "published_at.desc,article_key.asc", limit: "6" });
        params.append("published_at", `gte.${new Date(Date.parse(now) - 30 * 86400000).toISOString()}`);
        params.append("published_at", `lte.${now}`);
        // query-guard: bounded -- max 3 terms x 6 rows; predicates before LIMIT, no vector/corpus download.
        const rows = await read("genius_news_articles", params, signal);
        found.push(...rows.map(row => toEvidence(row, "news")));
      }
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
