"use client";

import { useState, useRef, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Send } from "lucide-react";
import { motion } from "framer-motion";
import { useDMChat } from "@/lib/supabase/useDM";
import { useAuth } from "@/lib/supabase/AuthContext";
import TeamBadge from "@/components/ui/TeamBadge";

export default function DMChatPage() {
  const params = useParams();
  const router = useRouter();
  const conversationId = params.conversationId as string;
  const { user } = useAuth();
  const { messages, loading, sendMessage } = useDMChat(conversationId);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  const handleSend = async () => {
    if (!input.trim() || sending) return;
    setSending(true);
    const ok = await sendMessage(input.trim());
    if (ok) setInput("");
    setSending(false);
  };

  // 상대방 이름 찾기
  const otherMsg = messages.find((m) => m.sender_id !== user?.id);
  const otherName = otherMsg?.sender_nickname ?? "상대방";

  return (
    <div className="flex flex-col h-screen bg-bg-primary">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 pt-safe pb-3 border-b border-border bg-bg-secondary">
        <button onClick={() => router.back()} className="p-1">
          <ArrowLeft size={24} className="text-text-primary" />
        </button>
        <div>
          <h1 className="text-base font-bold text-text-primary">{otherName}</h1>
          <p className="text-[10px] text-text-tertiary">1:1 쪽지</p>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {loading ? (
          <div className="text-center text-sm text-text-tertiary py-10">불러오는 중...</div>
        ) : messages.length === 0 ? (
          <div className="text-center text-sm text-text-tertiary py-10">
            첫 쪽지를 보내보세요! 💌
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
                    className={`px-3.5 py-2.5 rounded-2xl text-sm leading-relaxed ${
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
      <div className="px-4 py-3 border-t border-border bg-bg-secondary pb-safe">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && handleSend()}
            placeholder="쪽지를 입력하세요..."
            className="flex-1 px-4 py-2.5 rounded-full bg-bg-tertiary text-sm text-text-primary placeholder:text-text-tertiary outline-none"
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
    </div>
  );
}
