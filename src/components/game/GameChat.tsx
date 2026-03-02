"use client";

import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Send, Users, BarChart3, Flame, ChevronDown } from "lucide-react";
import { clsx } from "clsx";
import Image from "next/image";
import TeamBadge from "@/components/ui/TeamBadge";
import { getTeamById } from "@/lib/constants/teams";
import { getMyTeamId } from "@/lib/store/myteam";
import { useChat } from "@/lib/supabase/useChat";
import { useAuth } from "@/lib/supabase/AuthContext";

type ChatRoom = "all" | "home" | "away";

interface GameChatProps {
  gameId: string;
  homeTeamId: number;
  awayTeamId: number;
}

/* ===== 분위기 게이지 ===== */
function MoodGauge({ homeTeamId, awayTeamId, homePct }: { homeTeamId: number; awayTeamId: number; homePct: number }) {
  const home = getTeamById(homeTeamId)!;
  const away = getTeamById(awayTeamId)!;
  return (
    <div className="px-4 py-2 border-b border-border">
      <div className="flex items-center justify-between text-[10px] text-text-tertiary mb-1">
        <span className="flex items-center gap-1"><Flame size={10} className="text-orange-400" />팬 분위기</span>
        <span>실시간</span>
      </div>
      <div className="flex h-2.5 rounded-full overflow-hidden bg-bg-tertiary">
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${100 - homePct}%` }}
          transition={{ duration: 0.8 }}
          className="rounded-l-full"
          style={{ backgroundColor: away.colorLight }}
        />
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${homePct}%` }}
          transition={{ duration: 0.8 }}
          className="rounded-r-full"
          style={{ backgroundColor: home.colorLight }}
        />
      </div>
      <div className="flex justify-between mt-1 text-xs font-medium">
        <span style={{ color: away.colorLight }}>{away.shortName} {100 - homePct}%</span>
        <span style={{ color: home.colorLight }}>{home.shortName} {homePct}%</span>
      </div>
    </div>
  );
}

export default function GameChat({ gameId, homeTeamId, awayTeamId }: GameChatProps) {
  const roomId = `game:${gameId}`;
  const { messages, loading, sendMessage, isLoggedIn } = useChat(roomId);
  const { user } = useAuth();
  const [input, setInput] = useState("");
  const [room, setRoom] = useState<ChatRoom>("all");
  const [showRoomPicker, setShowRoomPicker] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length]);

  const filteredMessages = messages.filter((msg) => {
    if (room === "all") return true;
    if (room === "home") return msg.team_id === homeTeamId;
    if (room === "away") return msg.team_id === awayTeamId;
    return true;
  });

  async function handleSend() {
    if (!input.trim()) return;
    if (!isLoggedIn) { alert("로그인이 필요합니다"); return; }
    const ok = await sendMessage(input.trim());
    if (ok) setInput("");
  }

  function formatTime(dateStr: string) {
    const d = new Date(dateStr);
    return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
  }

  const homeTeam = getTeamById(homeTeamId)!;
  const awayTeam = getTeamById(awayTeamId)!;

  const roomLabels: Record<ChatRoom, string> = {
    all: "전체 채팅",
    home: `${homeTeam.shortName} 팬방`,
    away: `${awayTeam.shortName} 팬방`,
  };

  return (
    <div className="flex flex-col h-full">
      {/* Room selector */}
      <div className="relative">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
          <button onClick={() => setShowRoomPicker(!showRoomPicker)} className="flex items-center gap-2">
            <Users className="w-4 h-4 text-text-tertiary" />
            <span className="text-sm font-semibold text-text-primary">{roomLabels[room]}</span>
            <ChevronDown size={14} className={clsx("text-text-tertiary transition-transform", showRoomPicker && "rotate-180")} />
          </button>
          <span className="text-xs text-text-tertiary">{messages.length}개 메시지</span>
        </div>

        <AnimatePresence>
          {showRoomPicker && (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              className="absolute top-full left-0 right-0 z-20 bg-bg-secondary border-b border-border shadow-lg"
            >
              {(["all", "away", "home"] as ChatRoom[]).map((r) => {
                const team = r === "home" ? homeTeam : r === "away" ? awayTeam : null;
                return (
                  <button
                    key={r}
                    onClick={() => { setRoom(r); setShowRoomPicker(false); }}
                    className={clsx(
                      "w-full flex items-center gap-3 px-4 py-3 text-left transition-colors",
                      room === r ? "bg-accent/10" : "hover:bg-bg-tertiary"
                    )}
                  >
                    {team ? (
                      <div className="w-6 h-6 rounded-full bg-white p-0.5 flex items-center justify-center">
                        <Image src={team.logoPath} alt="" width={18} height={18} unoptimized className="object-contain" />
                      </div>
                    ) : (
                      <Users size={18} className="text-text-tertiary" />
                    )}
                    <span className={clsx("text-sm font-medium", room === r ? "text-accent" : "text-text-primary")}>
                      {roomLabels[r]}
                    </span>
                  </button>
                );
              })}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Mood gauge */}
      <MoodGauge homeTeamId={homeTeamId} awayTeamId={awayTeamId} homePct={58} />

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-2 space-y-0.5">
        {loading ? (
          <div className="text-center py-8 text-text-tertiary text-sm">로딩 중...</div>
        ) : messages.length === 0 ? (
          <div className="text-center py-8 text-text-tertiary">
            <p className="text-sm">아직 채팅이 없어요</p>
            <p className="text-xs mt-1">첫 번째 메시지를 보내보세요! 🔥</p>
          </div>
        ) : (
          <AnimatePresence initial={false}>
            {filteredMessages.map((msg) => {
              const isMe = user?.id === msg.user_id;
              return (
                <motion.div
                  key={msg.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.15 }}
                  className="flex items-start gap-2 py-0.5 group"
                >
                  {msg.team_id && <TeamBadge teamId={msg.team_id} size="xs" className="shrink-0" />}
                  <div className="min-w-0 flex-1">
                    <span className="inline">
                      <span className={clsx("text-xs font-semibold mr-1", isMe ? "text-accent" : "text-text-tertiary")}>
                        {msg.nickname || "익명"}
                      </span>
                      <span className="text-sm text-text-primary">{msg.content}</span>
                    </span>
                  </div>
                  <span className="text-[10px] text-text-tertiary shrink-0 mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    {formatTime(msg.created_at)}
                  </span>
                </motion.div>
              );
            })}
          </AnimatePresence>
        )}
      </div>

      {/* Input */}
      <div className="px-4 py-3 border-t border-border bg-bg-secondary/50 backdrop-blur-lg">
        <div className="flex items-center gap-3">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSend()}
            placeholder={isLoggedIn ? (room === "all" ? "메시지 입력..." : `${roomLabels[room]}에 메시지...`) : "로그인 후 채팅 가능"}
            disabled={!isLoggedIn}
            maxLength={200}
            className={clsx(
              "flex-1 h-10 px-4 rounded-full text-base",
              "bg-bg-tertiary text-text-primary placeholder:text-text-tertiary",
              "border border-border focus:border-accent/50 focus:outline-none transition-colors"
            )}
          />
          <motion.button
            whileTap={{ scale: 0.9 }}
            onClick={handleSend}
            disabled={!input.trim() || !isLoggedIn}
            className={clsx(
              "w-10 h-10 rounded-full flex items-center justify-center shrink-0 transition-colors",
              input.trim() ? "bg-accent text-white" : "bg-bg-tertiary text-text-tertiary"
            )}
          >
            <Send className="w-5 h-5" />
          </motion.button>
        </div>
      </div>
    </div>
  );
}
