"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { useAuth } from "@/lib/supabase/AuthContext";
import { supabase } from "@/lib/supabase/client";

interface ReportSheetProps {
  isOpen: boolean;
  onClose: () => void;
  targetType: "post" | "comment" | "chat";
  targetId: number;
  onReported?: (result: { hidden: boolean }) => void;
}

const REASONS = [
  { id: "spam", label: "스팸/도배", icon: "🚫" },
  { id: "abuse", label: "욕설/비하", icon: "🤬" },
  { id: "sexual", label: "음란/선정적", icon: "⚠️" },
  { id: "ads", label: "광고/홍보", icon: "📢" },
  { id: "other", label: "기타", icon: "📝" },
];

// iOS/WKWebView 대응: body를 position:fixed로 고정하면 시트 내부 overflow 스크롤까지 죽어서(벽돌 현상)
// body는 건드리지 않고, document touchmove를 "스크롤 영역(data-report-scroll) 밖에서만" 막는다.
// 내부 스크롤 영역은 네이티브 스크롤(WebkitOverflowScrolling: touch)을 그대로 허용 → 배경은 고정, 시트는 스크롤.
function useBackgroundTouchLock(isOpen: boolean) {
  useEffect(() => {
    if (!isOpen) return;

    const onTouchMove = (e: TouchEvent) => {
      const target = e.target as Element | null;
      // 신고 시트 스크롤 영역 안에서의 터치는 네이티브 스크롤 허용
      if (target && target.closest("[data-report-scroll]")) return;
      // 그 밖(배경/백드롭)에서의 터치 스크롤은 차단
      if (e.cancelable) e.preventDefault();
    };

    document.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => document.removeEventListener("touchmove", onTouchMove);
  }, [isOpen]);
}

export default function ReportSheet({ isOpen, onClose, targetType, targetId, onReported }: ReportSheetProps) {
  const { user } = useAuth();
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  useBackgroundTouchLock(isOpen);

  async function handleSubmit() {
    if (!user || !selected) return;
    setSubmitting(true);
    setError("");

    const { data: { session } } = await supabase.auth.getSession();
    const accessToken = session?.access_token;
    if (!accessToken) {
      setError("로그인이 필요합니다");
      setSubmitting(false);
      return;
    }

    const res = await fetch("/api/report", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
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
      onReported?.({ hidden: data.hidden === true });
      setDone(true);
      setTimeout(onClose, 1500);
    }
    setSubmitting(false);
  }

  if (!isOpen || typeof document === "undefined") return null;

  // 부모의 transform/filter에 fixed가 갇혀 시트가 잘리던 문제(벽돌) 방지 — document.body로 포털(작동하는 CommentSheet와 동일)
  return createPortal(
    <AnimatePresence>
      <motion.div
        className="fixed inset-0 z-[10000] flex items-end overscroll-none"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
      >
        <div className="absolute inset-0 bg-black/60" onClick={onClose} />
        <motion.div
          className="relative w-full max-w-lg mx-auto bg-bg-secondary rounded-t-3xl max-h-[85dvh] overflow-hidden flex flex-col"
          initial={{ y: "100%" }}
          animate={{ y: 0 }}
          exit={{ y: "100%" }}
          transition={{ type: "spring", damping: 25 }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="shrink-0 px-5 py-4 border-b border-border">
            <h2 className="text-lg font-bold text-text-primary">🚨 신고하기</h2>
            <p className="text-xs text-text-tertiary">신고 3회 누적 시 자동 블라인드 처리됩니다</p>
          </div>

          {done ? (
            <div className="py-10 pb-safe [--pb-safe-base:2.5rem] text-center overflow-y-auto overscroll-contain">
              <span className="text-4xl">✅</span>
              <p className="text-sm text-text-primary mt-2">신고가 접수되었습니다</p>
            </div>
          ) : (
            <div
              data-report-scroll
              style={{ WebkitOverflowScrolling: "touch" }}
              // --pb-safe-base = py-4(1rem) — nav bar 가 없는 환경에서 기존 여백 그대로 유지
              className="flex-1 min-h-0 overflow-y-scroll overscroll-contain px-5 py-4 pb-safe [--pb-safe-base:1rem] space-y-3"
            >
              {REASONS.map(r => (
                <button
                  key={r.id}
                  onClick={() => setSelected(r.id)}
                  className={`w-full flex items-center gap-3 p-3 rounded-xl transition-all ${
                    selected === r.id ? "bg-black/8 dark:bg-white/10 ring-2 ring-red-500/50" : "bg-bg-tertiary"
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
    </AnimatePresence>,
    document.body
  );
}
