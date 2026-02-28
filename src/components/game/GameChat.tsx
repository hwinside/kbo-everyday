"use client";

import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Send, Users } from "lucide-react";
import { clsx } from "clsx";
import TeamBadge from "@/components/ui/TeamBadge";
import LevelBadge from "@/components/ui/LevelBadge";
import type { ChatMessage } from "@/lib/constants/games";

interface GameChatProps {
  messages: ChatMessage[];
  participantCount?: number;
}

export default function GameChat({
  messages: initialMessages,
  participantCount = 142,
}: GameChatProps) {
  const [messages, setMessages] = useState(initialMessages);
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length]);

  function handleSend() {
    if (!input.trim()) return;
    const newMessage: ChatMessage = {
      id: Date.now(),
      teamId: 1, // mock: LG fan
      nickname: "나",
      level: 5,
      content: input.trim(),
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, newMessage]);
    setInput("");
  }

  function formatTime(dateStr: string) {
    const d = new Date(dateStr);
    return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-1.5 px-4 py-2.5 border-b border-border">
        <Users className="w-4 h-4 text-text-tertiary" />
        <span className="text-xs text-text-tertiary">
          {participantCount}명 참여 중
        </span>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-2 space-y-0.5">
        <AnimatePresence initial={false}>
          {messages.map((msg) => (
            <motion.div
              key={msg.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.15 }}
              className="flex items-start gap-1.5 py-1 group"
            >
              {/* Team badge */}
              <TeamBadge teamId={msg.teamId} size="sm" className="mt-0.5 shrink-0" />

              {/* Message content */}
              <div className="min-w-0 flex-1">
                <span className="inline">
                  <span className="text-xs font-semibold text-text-primary mr-1">
                    {msg.nickname}
                  </span>
                  <LevelBadge level={msg.level} className="inline-flex mr-1 align-middle" />
                  <span className="text-sm text-text-secondary">
                    {msg.content}
                  </span>
                </span>
              </div>

              {/* Time */}
              <span className="text-xs text-text-tertiary shrink-0 mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                {formatTime(msg.createdAt)}
              </span>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {/* Input bar */}
      <div className="px-3 py-2.5 border-t border-border bg-bg-secondary/50 backdrop-blur-lg">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSend()}
            placeholder="메시지 입력..."
            maxLength={200}
            className={clsx(
              "flex-1 h-9 px-3 rounded-full text-sm",
              "bg-bg-tertiary text-text-primary placeholder:text-text-tertiary",
              "border border-border focus:border-accent/50 focus:outline-none",
              "transition-colors"
            )}
          />
          <motion.button
            whileTap={{ scale: 0.9 }}
            onClick={handleSend}
            disabled={!input.trim()}
            className={clsx(
              "w-9 h-9 rounded-full flex items-center justify-center shrink-0 transition-colors",
              input.trim()
                ? "bg-accent text-white"
                : "bg-bg-tertiary text-text-tertiary"
            )}
          >
            <Send className="w-5 h-5" />
          </motion.button>
        </div>
      </div>
    </div>
  );
}
