// 야구 용어/룰 질문 AI (spec: specs/baseball-qa-mvp.md)
// POST { question } → ①검수 사전 → ②캐시 → ③gemini flash-lite (미매칭만).
// 3테이블(baseball_glossary/qa_cache/qa_log)은 RLS 전면 차단 — service_role 전용.
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getVerifiedUserFromRequest } from "@/lib/auth/verified-user";
import {
  answerQuestion,
  MIN_QUESTION_LEN,
  MAX_QUESTION_LEN,
  type GlossaryEntry,
  type LlmResult,
  type QaDeps,
} from "@/lib/baseball-qa/pipeline";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`;

// 짧은 고정 시스템 프롬프트 (§5): 야구 한정 + 추측 금지 센티널
const SYSTEM_PROMPT = [
  "너는 한국 프로야구(KBO) 룰/용어 도우미다.",
  "야구 룰·용어·기록 질문에만 80~120자의 쉬운 한국어로 답한다. 존댓말(~요체)을 쓴다.",
  "야구와 무관한 질문이면 정확히 NOT_BASEBALL 만 출력한다.",
  "확실하지 않으면 추측하지 말고 정확히 UNSURE 만 출력한다.",
].join("\n");

// 사전 모듈 메모리 캐시 (테이블 bounded, 10분 TTL)
let glossaryCache: { entries: GlossaryEntry[]; loadedAt: number } | null = null;
const GLOSSARY_TTL_MS = 10 * 60 * 1000;

async function loadGlossary(): Promise<GlossaryEntry[]> {
  if (glossaryCache && Date.now() - glossaryCache.loadedAt < GLOSSARY_TTL_MS) {
    return glossaryCache.entries;
  }
  const { data, error } = await supabaseAdmin
    .from("baseball_glossary")
    .select("term, aliases, answer")
    .limit(1000);
  if (error) throw error;
  const entries = (data ?? []) as GlossaryEntry[];
  glossaryCache = { entries, loadedAt: Date.now() };
  return entries;
}

async function callLlm(question: string): Promise<LlmResult> {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY missing");
  const res = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ parts: [{ text: question }] }], // 단발 — 대화이력 미전송
      generationConfig: { temperature: 0.2, maxOutputTokens: 256, thinkingConfig: { thinkingBudget: 0 } },
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Gemini API failed: ${res.status}`);
  const data = await res.json();
  const text: string =
    data.candidates?.[0]?.content?.parts?.find((p: { text?: string }) => p.text)?.text ?? "";
  return {
    text,
    inputTokens: data.usageMetadata?.promptTokenCount ?? null,
    outputTokens: data.usageMetadata?.candidatesTokenCount ?? null,
  };
}

function kstDayStartUtc(): string {
  // KST 자정 리셋: 현재 KST 날짜의 00:00을 UTC로 환산
  const kstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const day = kstNow.toISOString().slice(0, 10);
  return new Date(`${day}T00:00:00+09:00`).toISOString();
}

const deps: QaDeps = {
  loadGlossary,
  callLlm,
  getCache: async (questionNorm) => {
    const { data } = await supabaseAdmin
      .from("baseball_qa_cache")
      .select("id, answer, hit_count")
      .eq("question_norm", questionNorm)
      .maybeSingle();
    if (!data) return null;
    // hit 카운트 갱신 (best-effort)
    await supabaseAdmin
      .from("baseball_qa_cache")
      .update({ hit_count: (data.hit_count ?? 0) + 1, last_hit_at: new Date().toISOString() })
      .eq("id", data.id);
    return data.answer as string;
  },
  setCache: async (questionNorm, answer) => {
    await supabaseAdmin
      .from("baseball_qa_cache")
      .upsert({ question_norm: questionNorm, answer }, { onConflict: "question_norm" });
  },
  countToday: async (userId) => {
    const { count } = await supabaseAdmin
      .from("baseball_qa_log")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId)
      .gte("created_at", kstDayStartUtc());
    return count ?? 0;
  },
  log: async (entry) => {
    await supabaseAdmin.from("baseball_qa_log").insert({
      user_id: entry.userId,
      question: entry.question,
      question_norm: entry.questionNorm,
      match_path: entry.matchPath,
      answer: entry.answer,
      input_tokens: entry.inputTokens,
      output_tokens: entry.outputTokens,
    });
  },
};

export async function POST(req: NextRequest) {
  const verified = await getVerifiedUserFromRequest(req);
  if (!verified) {
    return NextResponse.json({ error: "인증이 필요합니다" }, { status: 401 });
  }

  let question: unknown;
  try {
    ({ question } = await req.json());
  } catch {
    return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
  }
  if (typeof question !== "string" || question.trim().length < MIN_QUESTION_LEN || question.trim().length > MAX_QUESTION_LEN) {
    return NextResponse.json({ error: `질문은 ${MIN_QUESTION_LEN}~${MAX_QUESTION_LEN}자로 입력해 주세요` }, { status: 400 });
  }

  try {
    const result = await answerQuestion(verified.user.id, question, deps);
    if (result.status !== 200) {
      return NextResponse.json({ error: result.answer, source: result.source, remaining: result.remaining }, { status: result.status });
    }
    return NextResponse.json({
      answer: result.answer,
      source: result.source,
      term: result.term ?? null,
      remaining: result.remaining,
    });
  } catch (e) {
    console.error("baseball-qa failed:", (e as Error).message);
    return NextResponse.json({ error: "질문 처리에 실패했어요. 잠시 후 다시 시도해 주세요." }, { status: 500 });
  }
}
