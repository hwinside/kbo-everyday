"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Send, EllipsisVertical, AlertTriangle, ShieldBan, Flag, X } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useDMChat } from "@/lib/supabase/useDM";
import { useAuth } from "@/lib/supabase/AuthContext";
import { useBlockUser } from "@/lib/supabase/useBlock";
import { submitDMReport } from "@/lib/supabase/useBlock";
import { supabase } from "@/lib/supabase/client";
import TeamBadge from "@/components/ui/TeamBadge";

const REPORT_CATEGORIES = [
  { id: "spam", label: "스팸" },
  { id: "abuse", label: "욕설/비방" },
  { id: "scam", label: "사기/피싱" },
  { id: "inappropriate", label: "불쾌한 내용" },
  { id: "other", label: "기타" },
] as const;

export default function DMChatPage() {
  const params = useParams();
  const router = useRouter();
  const conversationId = params.conversationId as string;
  const { user } = useAuth();
  const { messages, loading, sendMessage } = useDMChat(conversationId);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // 상대방 프로필 직접 fetch
  const [otherName, setOtherName] = useState("상대방");
  const [otherTeamId, setOtherTeamId] = useState<number | null>(null);
  const [otherId, setOtherId] = useState<string | null>(null);

  useEffect(() => {
    if (!user || !conversationId) return;

    async function fetchOther() {
      const { data: conv } = await supabase
        .from("dm_conversations")
        .select("user1_id, user2_id")
        .eq("id", conversationId)
        .single();

      if (!conv) return;
      const oid = conv.user1_id === user!.id ? conv.user2_id : conv.user1_id;
      setOtherId(oid);

      const { data: prof } = await supabase
        .from("profiles")
        .select("nickname, team_id")
        .eq("id", oid)
        .single();

      if (prof) {
        setOtherName(prof.nickname ?? "상대방");
        setOtherTeamId(prof.team_id);
      }
    }
    fetchOther();
  }, [user, conversationId]);

  // Block hook
  const { block, isBlocked } = useBlockUser(otherId ?? "");

  // UI states
  const [showMenu, setShowMenu] = useState(false);
  const [showBlockConfirm, setShowBlockConfirm] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [reportCategory, setReportCategory] = useState("");
  const [reportDetail, setReportDetail] = useState("");
  const [reportSubmitting, setReportSubmitting] = useState(false);
  const [reportDone, setReportDone] = useState(false);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  // 입력창 내용 길이에 맞춰 세로 자동 확장 (최대 max-h-32 = 128px)
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
  }, [input]);

  const handleSend = async () => {
    if (!input.trim() || sending) return;
    setSending(true);
    const ok = await sendMessage(input.trim());
    if (ok) setInput("");
    setSending(false);
  };

  const handleBlock = useCallback(async () => {
    await block();
    setShowBlockConfirm(false);
    router.back();
  }, [block, router]);

  const handleReport = useCallback(async () => {
    if (!user || !otherId || !reportCategory) return;
    setReportSubmitting(true);
    const reason = reportCategory + (reportDetail.trim() ? `|${reportDetail.trim()}` : "");
    await submitDMReport(user.id, otherId, conversationId, reason);
    setReportSubmitting(false);
    setReportDone(true);
    setTimeout(() => {
      setShowReport(false);
      setReportDone(false);
      setReportCategory("");
      setReportDetail("");
    }, 1500);
  }, [user, otherId, conversationId, reportCategory, reportDetail]);

  return (
    <div className="flex flex-col h-screen bg-bg-primary">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 pt-safe pb-3 border-b border-border bg-bg-secondary">
        <button onClick={() => router.back()} className="p-1">
          <ArrowLeft size={24} className="text-text-primary" />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            {otherName === "크보팬 운영팀" ? (
              <img src="/apple-touch-icon.png" alt="크보팬" className="w-5 h-5 rounded-full object-cover" />
            ) : otherTeamId ? (
              <TeamBadge teamId={otherTeamId} size="xs" />
            ) : null}
            <h1 className="text-base font-bold text-text-primary truncate">{otherName}</h1>
          </div>
          <p className="text-[10px] text-text-tertiary">1:1 쪽지</p>
        </div>
        <div className="relative">
          <button onClick={() => setShowMenu(!showMenu)} className="p-1.5 rounded-full hover:bg-bg-tertiary transition-colors">
            <EllipsisVertical size={20} className="text-text-secondary" />
          </button>
          {/* Dropdown Menu */}
          <AnimatePresence>
            {showMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowMenu(false)} />
                <motion.div
                  initial={{ opacity: 0, scale: 0.95, y: -4 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95, y: -4 }}
                  transition={{ duration: 0.15 }}
                  className="absolute right-0 top-full mt-1 w-36 rounded-xl bg-bg-secondary border border-border shadow-xl z-50 overflow-hidden"
                >
                  <button
                    onClick={() => { setShowMenu(false); setShowReport(true); }}
                    className="flex items-center gap-2 w-full px-4 py-3 text-sm text-text-primary hover:bg-bg-tertiary transition-colors"
                  >
                    <Flag size={16} className="text-text-tertiary" />
                    신고하기
                  </button>
                  <button
                    onClick={() => { setShowMenu(false); setShowBlockConfirm(true); }}
                    className="flex items-center gap-2 w-full px-4 py-3 text-sm text-red-500 hover:bg-bg-tertiary transition-colors"
                  >
                    <ShieldBan size={16} />
                    차단하기
                  </button>
                </motion.div>
              </>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {/* Safety Banner */}
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-yellow-500/10 text-yellow-500 text-xs">
          <AlertTriangle size={14} className="flex-shrink-0" />
          <span>쪽지는 개인 간 대화입니다. 금전 거래 시 사기에 주의하세요.</span>
        </div>

        {loading ? (
          <div className="text-center text-sm text-text-tertiary py-10">불러오는 중...</div>
        ) : messages.length === 0 ? (
          <div className="text-center text-sm text-text-tertiary py-10">
            첫 쪽지를 보내보세요!
          </div>
        ) : (
          messages.map((msg) => {
            const isMe = msg.sender_id === user?.id;
            return (
              <motion.div
                key={msg.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                className={`flex ${isMe ? "justify-end" : "justify-start"}`}
              >
                <div className={`max-w-[75%] ${isMe ? "order-2" : ""}`}>
                  {!isMe && (
                    <div className="flex items-center gap-1.5 mb-1">
                      {msg.sender_team_id && <TeamBadge teamId={msg.sender_team_id} size="xs" />}
                      <span className="text-xs font-semibold text-text-secondary">{msg.sender_nickname}</span>
                    </div>
                  )}
                  <div
                    className={`px-3.5 py-2.5 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap break-words ${
                      isMe
                        ? "bg-accent text-white rounded-br-md"
                        : "bg-bg-tertiary text-text-primary rounded-bl-md"
                    }`}
                  >
                    {msg.content}
                  </div>
                  <div className={`text-[10px] text-text-tertiary mt-1 ${isMe ? "text-right" : ""}`}>
                    {new Date(msg.created_at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}
                    {isMe && msg.is_read && " ✓"}
                  </div>
                </div>
              </motion.div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      {isBlocked ? (
        <div className="px-5 py-3 border-t border-border bg-bg-secondary pb-safe text-center text-sm text-text-tertiary">
          차단된 사용자에게 쪽지를 보낼 수 없습니다.
        </div>
      ) : (
        <div className="px-5 py-3 border-t border-border bg-bg-secondary pb-safe">
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder="쪽지를 입력하세요..."
              rows={1}
              className="flex-1 px-4 py-2.5 rounded-2xl bg-bg-tertiary text-sm text-text-primary placeholder:text-text-tertiary outline-none resize-none max-h-32 overflow-y-auto"
            />
            <button
              onClick={handleSend}
              disabled={!input.trim() || sending}
              className="w-10 h-10 rounded-full bg-accent flex items-center justify-center disabled:opacity-30 transition-opacity"
            >
              <Send size={18} className="text-white" />
            </button>
          </div>
        </div>
      )}

      {/* Block Confirm Modal */}
      <AnimatePresence>
        {showBlockConfirm && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-6"
            onClick={() => setShowBlockConfirm(false)}
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-sm rounded-2xl bg-bg-secondary border border-border p-6 shadow-2xl"
            >
              <div className="text-center">
                <ShieldBan size={40} className="mx-auto mb-3 text-red-500" />
                <h3 className="text-base font-bold text-text-primary mb-2">정말 차단하시겠어요?</h3>
                <p className="text-sm text-text-secondary mb-6">차단하면 쪽지를 주고받을 수 없습니다.</p>
                <div className="flex gap-3">
                  <button
                    onClick={() => setShowBlockConfirm(false)}
                    className="flex-1 py-2.5 rounded-xl bg-bg-tertiary text-sm font-semibold text-text-primary transition-colors hover:bg-bg-primary"
                  >
                    취소
                  </button>
                  <button
                    onClick={handleBlock}
                    className="flex-1 py-2.5 rounded-xl bg-red-500 text-sm font-semibold text-white transition-colors hover:bg-red-600"
                  >
                    차단
                  </button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Report Bottom Sheet */}
      <AnimatePresence>
        {showReport && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm"
            onClick={() => setShowReport(false)}
          >
            <motion.div
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "100%" }}
              transition={{ type: "spring", damping: 25, stiffness: 300 }}
              onClick={(e) => e.stopPropagation()}
              className="absolute bottom-0 left-0 right-0 rounded-t-2xl bg-bg-secondary border-t border-border p-5 pb-safe max-h-[80vh] overflow-y-auto"
            >
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-base font-bold text-text-primary">신고하기</h3>
                <button onClick={() => setShowReport(false)} className="p-1">
                  <X size={20} className="text-text-tertiary" />
                </button>
              </div>

              {reportDone ? (
                <div className="text-center py-8">
                  <p className="text-sm text-text-primary font-semibold">신고가 접수되었습니다.</p>
                  <p className="text-xs text-text-tertiary mt-1">검토 후 조치하겠습니다.</p>
                </div>
              ) : (
                <>
                  <p className="text-sm text-text-secondary mb-3">사유를 선택해주세요</p>
                  <div className="space-y-2 mb-4">
                    {REPORT_CATEGORIES.map((cat) => (
                      <button
                        key={cat.id}
                        onClick={() => setReportCategory(cat.id)}
                        className={`w-full text-left px-4 py-3 rounded-xl text-sm transition-colors border ${
                          reportCategory === cat.id
                            ? "border-accent bg-accent/10 text-accent font-semibold"
                            : "border-border bg-bg-tertiary text-text-primary"
                        }`}
                      >
                        {cat.label}
                      </button>
                    ))}
                  </div>

                  <textarea
                    value={reportDetail}
                    onChange={(e) => setReportDetail(e.target.value)}
                    placeholder="추가 설명 (선택사항)"
                    rows={3}
                    className="w-full px-4 py-3 rounded-xl bg-bg-tertiary text-sm text-text-primary placeholder:text-text-tertiary outline-none border border-border resize-none mb-4"
                  />

                  <button
                    onClick={handleReport}
                    disabled={!reportCategory || reportSubmitting}
                    className="w-full py-3 rounded-xl bg-accent text-white text-sm font-semibold disabled:opacity-40 transition-opacity"
                  >
                    {reportSubmitting ? "제출 중..." : "신고 제출"}
                  </button>
                </>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
