"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useAuth } from "@/lib/supabase/AuthContext";

interface ReportSheetProps {
  isOpen: boolean;
  onClose: () => void;
  targetType: "post" | "comment" | "chat";
  targetId: number;
}

const REASONS = [
  { id: "spam", label: "스팸/도배", icon: "🚫" },
  { id: "abuse", label: "욕설/비하", icon: "🤬" },
  { id: "sexual", label: "음란/선정적", icon: "⚠️" },
  { id: "ads", label: "광고/홍보", icon: "📢" },
  { id: "other", label: "기타", icon: "📝" },
];

export default function ReportSheet({ isOpen, onClose, targetType, targetId }: ReportSheetProps) {
  const { user } = useAuth();
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit() {
    if (!user || !selected) return;
    setSubmitting(true);
    setError("");

    const res = await fetch("/api/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reporterId: user.id,
        targetType,
        targetId,
        reason: selected,
        detail: detail.trim() || null,
      }),
    });

    const data = await res.json();
    if (data.error) {
      setError(data.error);
    } else {
      setDone(true);
      setTimeout(onClose, 1500);
    }
    setSubmitting(false);
  }

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <motion.div
        className="fixed inset-0 z-50 flex items-end"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
      >
        <div className="absolute inset-0 bg-black/60" onClick={onClose} />
        <motion.div
          className="relative w-full max-w-lg mx-auto bg-bg-secondary rounded-t-3xl"
          initial={{ y: "100%" }}
          animate={{ y: 0 }}
          exit={{ y: "100%" }}
          transition={{ type: "spring", damping: 25 }}
        >
          <div className="px-5 py-4 border-b border-border">
            <h2 className="text-lg font-bold text-text-primary">🚨 신고하기</h2>
            <p className="text-xs text-text-tertiary">신고 3회 누적 시 자동 블라인드 처리됩니다</p>
          </div>

          {done ? (
            <div className="py-10 text-center">
              <span className="text-4xl">✅</span>
              <p className="text-sm text-text-primary mt-2">신고가 접수되었습니다</p>
            </div>
          ) : (
            <div className="px-5 py-4 space-y-3">
              {REASONS.map(r => (
                <button
                  key={r.id}
                  onClick={() => setSelected(r.id)}
                  className={`w-full flex items-center gap-3 p-3 rounded-xl transition-all ${
                    selected === r.id ? "bg-white/10 ring-2 ring-red-500/50" : "bg-bg-tertiary"
                  }`}
                >
                  <span className="text-xl">{r.icon}</span>
                  <span className="text-sm font-medium text-text-primary">{r.label}</span>
                </button>
              ))}

              {selected === "other" && (
                <textarea
                  value={detail}
                  onChange={e => setDetail(e.target.value)}
                  placeholder="상세 사유를 입력해주세요"
                  className="w-full px-4 py-3 rounded-xl bg-bg-tertiary text-sm text-text-primary outline-none resize-none h-20"
                />
              )}

              {error && <p className="text-xs text-red-400">{error}</p>}

              <button
                onClick={handleSubmit}
                disabled={!selected || submitting}
                className="w-full py-3 rounded-xl bg-red-500/20 text-red-400 font-bold text-sm disabled:opacity-30"
              >
                {submitting ? "처리 중..." : "신고하기"}
              </button>
            </div>
          )}
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
