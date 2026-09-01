"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Send } from "lucide-react";
import { useAuth } from "@/lib/supabase/AuthContext";
import { supabase } from "@/lib/supabase/client";

type FeedbackType = "bug" | "data" | "feature" | "android_test" | "other";

interface FeedbackSheetProps {
  isOpen: boolean;
  onClose: () => void;
  defaultType?: FeedbackType;
}

const TYPES: { value: FeedbackType; label: string }[] = [
  { value: "bug", label: "🐛 버그" },
  { value: "data", label: "📊 데이터" },
  { value: "feature", label: "💡 제안" },
  { value: "android_test", label: "📱 안드로이드앱 테스트" },
  { value: "other", label: "💬 기타" },
];

export default function FeedbackSheet({ isOpen, onClose, defaultType }: FeedbackSheetProps) {
  const { user } = useAuth();

  useEffect(() => {
    if (!isOpen) return;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, [isOpen]);

  const [type, setType] = useState<FeedbackType>(defaultType ?? "bug");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  const resetForm = () => {
    setType(defaultType ?? "bug");
    setTitle("");
    setBody("");
    setError("");
    setSuccess(false);
  };

  const handleClose = () => {
    resetForm();
    onClose();
  };

  const handleSubmit = async () => {
    if (!title.trim()) {
      setError("제목을 입력해주세요");
      return;
    }
    if (!user) return;

    setLoading(true);
    setError("");

    try {
      const { data: { session } } = await supabase.auth.getSession();
      const accessToken = session?.access_token;

      if (!accessToken) {
        setError("로그인이 필요합니다");
        return;
      }

      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          type,
          title: title.trim(),
          body: body.trim() || null,
          pageUrl: window.location.pathname,
          deviceInfo: navigator.userAgent,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "전송에 실패했습니다");
        return;
      }

      setSuccess(true);
      setTimeout(() => {
        handleClose();
      }, 1500);
    } catch {
      setError("네트워크 오류가 발생했습니다");
    } finally {
      setLoading(false);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[90] bg-black/60"
            onClick={handleClose}
            aria-hidden
          />
          <motion.div
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", damping: 25, stiffness: 300 }}
            className="fixed bottom-0 left-0 right-0 z-[91] mx-auto max-w-lg rounded-t-3xl bg-bg-secondary p-5 pb-safe"
            role="dialog"
            aria-modal="true"
            aria-label="피드백 보내기"
          >
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-lg font-bold text-text-primary">📮 피드백 보내기</h2>
              <button onClick={handleClose} aria-label="닫기" className="p-1 rounded-full hover:bg-bg-tertiary">
                <X size={20} className="text-text-tertiary" />
              </button>
            </div>

            {success ? (
              <div className="flex flex-col items-center gap-3 py-8">
                <span className="text-4xl">🙏</span>
                <p className="text-base font-semibold text-text-primary">소중한 의견 감사합니다!</p>
              </div>
            ) : (
              <>
                {/* Type pills */}
                <div className="flex flex-wrap gap-2 mb-5">
                  {TYPES.map((t) => (
                    <button
                      key={t.value}
                      onClick={() => setType(t.value)}
                      aria-pressed={type === t.value}
                      className={`rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
                        type === t.value
                          ? "bg-accent text-white"
                          : "bg-bg-tertiary text-text-secondary"
                      }`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>

                {/* Title */}
                <input
                  type="text"
                  placeholder="제목 (필수)"
                  aria-label="제목"
                  aria-required="true"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  maxLength={100}
                  className="w-full rounded-xl bg-bg-tertiary px-4 py-3 text-sm text-text-primary placeholder:text-text-tertiary outline-none focus:ring-1 focus:ring-accent mb-3"
                />

                {/* Body */}
                <textarea
                  placeholder="상세 설명 (선택)"
                  aria-label="상세 설명"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={4}
                  maxLength={2000}
                  className="w-full rounded-xl bg-bg-tertiary px-4 py-3 text-sm text-text-primary placeholder:text-text-tertiary outline-none focus:ring-1 focus:ring-accent resize-none mb-4 [overscroll-behavior:contain]"
                />

                {error && <p className="text-red-400 text-xs mb-3">{error}</p>}

                {/* Submit */}
                <button
                  onClick={handleSubmit}
                  disabled={loading || !title.trim()}
                  className="w-full flex items-center justify-center gap-2 rounded-xl bg-accent py-3 text-sm font-semibold text-white transition-opacity disabled:opacity-40"
                >
                  <Send size={16} />
                  {loading ? "보내는 중..." : "보내기"}
                </button>
              </>
            )}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
