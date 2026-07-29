"use client";

// 야구 궁금증 바로 묻기 (spec: specs/baseball-qa-mvp.md §8)
// 질문 입력 + 추천 질문 칩(사전 히트 보장) + 답변 카드

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, Send } from "lucide-react";
import { useAuth } from "@/lib/supabase/AuthContext";
import { supabase } from "@/lib/supabase/client";
import HeaderProfileLink from "@/components/ui/HeaderProfileLink";

const SUGGESTED = ["ABS가 뭐야?", "보크가 뭐야?", "인필드 플라이가 뭐야?", "희생플라이가 뭐야?", "낫아웃이 뭐야?", "퀄리티스타트가 뭐야?"];

interface QaAnswer {
  answer: string;
  source: "dictionary" | "cache" | "llm" | "blocked" | "unsure";
  term: string | null;
  remaining: number;
}

const SOURCE_BADGE: Record<QaAnswer["source"], string> = {
  dictionary: "📖 크보팬 용어사전",
  cache: "🤖 AI 답변",
  llm: "🤖 AI 답변",
  blocked: "⚾ 야구 질문만 받아요",
  unsure: "🤔 아직 몰라요",
};

export default function BaseballAskPage() {
  const { user } = useAuth();
  const [question, setQuestion] = useState("");
  const [asked, setAsked] = useState("");
  const [result, setResult] = useState<QaAnswer | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function ask(q: string) {
    const trimmed = q.trim();
    if (!trimmed || loading) return;
    setLoading(true);
    setError("");
    setResult(null);
    setAsked(trimmed);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const accessToken = session?.access_token;
      if (!accessToken) {
        setError("로그인 후 질문할 수 있어요");
        return;
      }
      const res = await fetch("/api/baseball-qa", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ question: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "질문에 실패했어요");
        return;
      }
      setResult(data as QaAnswer);
    } catch {
      setError("네트워크 오류가 발생했어요");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-bg-primary pb-24">
      <div className="sticky top-0 z-30 border-b border-border bg-bg-primary" style={{ paddingTop: "env(safe-area-inset-top, 0px)", marginTop: "calc(env(safe-area-inset-top, 0px) * -1)" }}>
        <header className="px-5 min-h-[44px] flex items-center">
          <div className="flex w-full items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <Link href="/learn" aria-label="야구 배우기로" className="flex h-11 min-h-[44px] items-center -ml-1 text-text-secondary">
                <ArrowLeft size={20} />
              </Link>
              <h1 className="text-xl font-bold text-text-primary">💬 야구 궁금증 묻기</h1>
            </div>
            <HeaderProfileLink />
          </div>
        </header>
      </div>

      <div className="px-5 pt-3 space-y-4">
        <p className="text-sm text-text-tertiary">룰이든 용어든, 야구가 궁금하면 뭐든 물어보세요! (하루 20개)</p>

        {/* 질문 입력 */}
        <form
          onSubmit={(e) => { e.preventDefault(); ask(question); }}
          className="flex items-center gap-2"
        >
          <input
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="예: 보크가 뭐야?"
            maxLength={200}
            className="flex-1 min-h-[44px] rounded-xl border border-border bg-bg-secondary px-4 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent"
          />
          <button
            type="submit"
            disabled={loading || !question.trim()}
            aria-label="질문하기"
            className="flex h-11 w-11 min-h-[44px] items-center justify-center rounded-xl bg-accent text-white disabled:opacity-40"
          >
            <Send size={18} />
          </button>
        </form>

        {/* 추천 질문 칩 */}
        <div className="flex flex-wrap gap-2">
          {SUGGESTED.map((s) => (
            <button
              key={s}
              onClick={() => { setQuestion(s); ask(s); }}
              disabled={loading}
              className="rounded-full border border-border bg-bg-secondary px-3 py-2 text-xs text-text-secondary active:bg-bg-tertiary disabled:opacity-40"
            >
              {s}
            </button>
          ))}
        </div>

        {/* 비로그인 안내 */}
        {!user && (
          <p className="text-sm text-text-tertiary">🔒 질문하려면 로그인이 필요해요.</p>
        )}

        {/* 로딩 / 에러 / 답변 카드 */}
        {loading && (
          <div className="glass-card p-5 text-sm text-text-tertiary">생각 중이에요…</div>
        )}
        {error && !loading && (
          <div className="glass-card p-5 text-sm text-red-400">{error}</div>
        )}
        {result && !loading && (
          <div className="glass-card p-5 space-y-3">
            <p className="text-sm font-semibold text-text-primary">Q. {asked}</p>
            <p className="whitespace-pre-line text-sm leading-relaxed text-text-secondary">{result.answer}</p>
            <div className="flex items-center justify-between">
              <span className="text-xs text-text-tertiary">{SOURCE_BADGE[result.source]}{result.term ? ` · ${result.term}` : ""}</span>
              <span className="text-xs text-text-tertiary">오늘 남은 질문 {result.remaining}개</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
