"use client";

import { useState, useRef, useEffect } from "react";
import { Send, LogIn } from "lucide-react";
import TeamBadge from "@/components/ui/TeamBadge";
import { getTeamById } from "@/lib/constants/teams";
import { useChat, type ChatMessage } from "@/lib/supabase/useChat";
import LoginSheet from "@/components/auth/LoginSheet";

interface LiveChatProps {
  gameId: string;
  homeTeamId: number;
  awayTeamId: number;
}

function formatTime(dateStr: string) {
  const d = new Date(dateStr);
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

const GRADE_EMOJI: Record<string, string> = {
  rookie: "🌱",
  regular: "⚾",
  allstar: "⭐",
  mvp: "🏆",
  hof: "👑",
};

export default function LiveChat({ gameId, homeTeamId, awayTeamId }: LiveChatProps) {
  const roomId = `game:${gameId}:all`;
  const { messages, loading, sendMessage, isLoggedIn } = useChat(roomId);
  const [input, setInput] = useState("");
  const [showLogin, setShowLogin] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 자동 스크롤
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim()) return;
    if (!isLoggedIn) {
      setShowLogin(true);
      return;
    }
    const ok = await sendMessage(input);
    if (ok) setInput("");
  };

  const home = getTeamById(homeTeamId);
  const away = getTeamById(awayTeamId);

  return (
    <div className="flex flex-col h-[400px]">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-white/5">
        <span className="text-xs text-text-tertiary">
          실시간 채팅 · {messages.length}개 메시지
        </span>
        <div className="flex gap-1">
          {away && <TeamBadge teamId={awayTeamId} size="xs" />}
          <span className="text-xs text-text-tertiary">vs</span>
          {home && <TeamBadge teamId={homeTeamId} size="xs" />}
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-2 space-y-1">
        {loading ? (
          <div className="flex items-center justify-center h-full text-text-tertiary text-sm">
            로딩 중...
          </div>
        ) : messages.length === 0 ? (
          <div className="flex items-center justify-center h-full text-text-tertiary text-sm">
            첫 메시지를 남겨보세요! ⚾
          </div>
        ) : (
          messages.map((msg) => {
            const team = msg.team_id ? getTeamById(msg.team_id) : null;
            return (
              <div key={msg.id} className="flex items-start gap-2 py-0.5">
                <div className="flex items-center gap-1 shrink-0">
                  {msg.team_id && <TeamBadge teamId={msg.team_id} size="xs" />}
                  <span className="text-xs text-text-tertiary">
                    {GRADE_EMOJI[msg.grade ?? "rookie"]}
                  </span>
                </div>
                <div className="min-w-0">
                  <span
                    className="text-xs font-medium mr-1.5"
                    style={{ color: team?.colorLight ?? "#999" }}
                  >
                    {msg.nickname ?? "익명"}
                  </span>
                  <span className="text-sm text-text-primary break-words">
                    {msg.content}
                  </span>
                </div>
                <span className="text-[10px] text-text-tertiary shrink-0 ml-auto">
                  {formatTime(msg.created_at)}
                </span>
              </div>
            );
          })
        )}
      </div>

      {/* Input */}
      <div className="px-3 py-2 border-t border-white/5">
        <div className="flex items-center gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSend()}
            placeholder={isLoggedIn ? "응원 메시지를 입력하세요..." : "로그인 후 채팅 가능"}
            className="flex-1 bg-bg-tertiary rounded-full px-4 py-2 text-sm text-text-primary placeholder:text-text-tertiary outline-none"
          />
          <button
            onClick={isLoggedIn ? handleSend : () => setShowLogin(true)}
            className="p-2 rounded-full bg-accent text-white shrink-0"
          >
            {isLoggedIn ? <Send size={16} /> : <LogIn size={16} />}
          </button>
        </div>
      </div>

      <LoginSheet isOpen={showLogin} onClose={() => setShowLogin(false)} />
    </div>
  );
}
