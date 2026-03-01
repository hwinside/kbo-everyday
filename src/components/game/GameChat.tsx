"use client";

import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Send, Users, BarChart3, Flame, ChevronDown } from "lucide-react";
import { clsx } from "clsx";
import Image from "next/image";
import TeamBadge from "@/components/ui/TeamBadge";
import LevelBadge from "@/components/ui/LevelBadge";
import { getTeamById } from "@/lib/constants/teams";
import { getMyTeamId } from "@/lib/store/myteam";
import type { ChatMessage } from "@/lib/constants/games";

type ChatRoom = "all" | "home" | "away";

interface GameChatProps {
  messages: ChatMessage[];
  homeTeamId: number;
  awayTeamId: number;
  participantCount?: number;
}

/* ===== 인라인 투표 ===== */
interface PollData {
  id: number;
  question: string;
  options: { label: string; votes: number }[];
  totalVotes: number;
  votedIdx: number | null;
}

function InlinePoll({ poll, onVote }: { poll: PollData; onVote: (idx: number) => void }) {
  return (
    <div className="my-2 p-3 rounded-xl bg-bg-tertiary/80 border border-border">
      <div className="flex items-center gap-2 mb-2">
        <BarChart3 size={14} className="text-accent" />
        <span className="text-xs font-bold text-text-primary">{poll.question}</span>
      </div>
      <div className="space-y-1.5">
        {poll.options.map((opt, i) => {
          const pct = poll.totalVotes > 0 ? Math.round((opt.votes / poll.totalVotes) * 100) : 0;
          const voted = poll.votedIdx === i;
          return (
            <button
              key={i}
              onClick={() => poll.votedIdx === null && onVote(i)}
              disabled={poll.votedIdx !== null}
              className="w-full relative overflow-hidden rounded-lg h-8 flex items-center px-3 text-xs transition-colors"
              style={{ background: poll.votedIdx !== null ? `linear-gradient(90deg, rgba(99,102,241,${pct / 200}) ${pct}%, transparent ${pct}%)` : "rgba(255,255,255,0.05)" }}
            >
              <span className={clsx("relative z-10 font-medium", voted ? "text-accent" : "text-text-primary")}>{opt.label}</span>
              {poll.votedIdx !== null && (
                <span className="relative z-10 ml-auto text-text-tertiary tabular-nums">{pct}%</span>
              )}
            </button>
          );
        })}
      </div>
      <p className="text-[10px] text-text-tertiary mt-1.5">{poll.totalVotes}명 참여</p>
    </div>
  );
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

export default function GameChat({
  messages: initialMessages,
  homeTeamId,
  awayTeamId,
  participantCount = 142,
}: GameChatProps) {
  const [messages, setMessages] = useState(initialMessages);
  const [input, setInput] = useState("");
  const [room, setRoom] = useState<ChatRoom>("all");
  const [showRoomPicker, setShowRoomPicker] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const myTeamId = getMyTeamId();

  // mock poll
  const [poll, setPoll] = useState<PollData>({
    id: 1,
    question: "🗳️ 오늘의 MVP는?",
    options: [
      { label: "오스틴 (3안타 2타점)", votes: 89 },
      { label: "임찬규 (7이닝 1실점)", votes: 124 },
      { label: "김현수 (결승 홈런)", votes: 67 },
    ],
    totalVotes: 280,
    votedIdx: null,
  });

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length, room]);

  // 채팅방 필터링
  const filteredMessages = messages.filter((msg) => {
    if (room === "all") return true;
    if (room === "home") return msg.teamId === homeTeamId;
    if (room === "away") return msg.teamId === awayTeamId;
    return true;
  });

  function handleSend() {
    if (!input.trim()) return;
    const newMessage: ChatMessage = {
      id: Date.now(),
      teamId: myTeamId ?? 1,
      nickname: "나",
      level: 5,
      content: input.trim(),
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, newMessage]);
    setInput("");
  }

  function handleVote(idx: number) {
    setPoll((prev) => ({
      ...prev,
      votedIdx: idx,
      totalVotes: prev.totalVotes + 1,
      options: prev.options.map((o, i) =>
        i === idx ? { ...o, votes: o.votes + 1 } : o
      ),
    }));
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

  const roomCounts: Record<ChatRoom, number> = {
    all: participantCount,
    home: Math.round(participantCount * 0.55),
    away: Math.round(participantCount * 0.38),
  };

  return (
    <div className="flex flex-col h-full">
      {/* Room selector + mood gauge */}
      <div className="relative">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
          <button
            onClick={() => setShowRoomPicker(!showRoomPicker)}
            className="flex items-center gap-2"
          >
            <Users className="w-4 h-4 text-text-tertiary" />
            <span className="text-sm font-semibold text-text-primary">{roomLabels[room]}</span>
            <ChevronDown size={14} className={clsx("text-text-tertiary transition-transform", showRoomPicker && "rotate-180")} />
          </button>
          <span className="text-xs text-text-tertiary">{roomCounts[room]}명</span>
        </div>

        {/* Room picker dropdown */}
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
                    <span className="ml-auto text-xs text-text-tertiary">{roomCounts[r]}명</span>
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
        {/* Pinned poll */}
        <InlinePoll poll={poll} onVote={handleVote} />

        <AnimatePresence initial={false}>
          {filteredMessages.map((msg) => (
            <motion.div
              key={msg.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.15 }}
              className="flex items-start gap-4 py-1 group"
            >
              <TeamBadge teamId={msg.teamId} size="sm" className="mt-0.5 shrink-0" />
              <div className="min-w-0 flex-1">
                <span className="inline">
                  <span className="text-base font-semibold text-text-primary mr-1">{msg.nickname}</span>
                  <LevelBadge level={msg.level} className="inline-flex mr-1 align-middle" />
                  <span className="text-base text-text-secondary">{msg.content}</span>
                </span>
              </div>
              <span className="text-sm text-text-tertiary shrink-0 mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                {formatTime(msg.createdAt)}
              </span>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {/* Input */}
      <div className="px-4 py-3 border-t border-border bg-bg-secondary/50 backdrop-blur-lg">
        <div className="flex items-center gap-3">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSend()}
            placeholder={room === "all" ? "메시지 입력..." : `${roomLabels[room]}에 메시지...`}
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
            disabled={!input.trim()}
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
