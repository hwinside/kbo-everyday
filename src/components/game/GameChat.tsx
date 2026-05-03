"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Send, Users, Flame, ChevronDown } from "lucide-react";
import { clsx } from "clsx";
import Image from "next/image";
import TeamBadge from "@/components/ui/TeamBadge";
import { getTeamById } from "@/lib/constants/teams";
import { useChat } from "@/lib/supabase/useChat";
import { useMoodGauge } from "@/lib/supabase/useMoodGauge";
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

/* ===== Room ID builder ===== */
function getRoomId(gameId: string, room: ChatRoom): string {
  if (room === "all") return `game:${gameId}`;
  return `game:${gameId}:${room}`;
}

export default function GameChat({ gameId, homeTeamId, awayTeamId }: GameChatProps) {
  const [room, setRoom] = useState<ChatRoom>("all");
  const roomId = getRoomId(gameId, room);
  const { messages, loading, sendMessage, cooldown, cooldownReason, isLoggedIn } = useChat(roomId);
  const { homePct } = useMoodGauge(gameId, homeTeamId, awayTeamId);
  const { user, profile, loading: authLoading } = useAuth();
  const [input, setInput] = useState("");
  const [showRoomPicker, setShowRoomPicker] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const focusLockRef = useRef(false);
  const lastAlignedCountRef = useRef(0);

  const displayMessages = [...messages].reverse(); // 최신순: 최신 메시지가 리스트 상단

  // 최신 ~5개 메시지가 입력창 바로 위에 보이도록 window 스크롤을 맞춘다.
  // 채팅 리스트 자체는 별도 스크롤이 없고, 페이지 전체 스크롤만 사용한다.
  const alignLatestMessagesAboveComposer = useCallback(() => {
    if (!scrollRef.current || !composerRef.current) return;
    const msgs = scrollRef.current.querySelectorAll<HTMLElement>("[data-chat-msg]");
    if (msgs.length === 0) return;

    // 최신순 상단이므로 5번째 최신 메시지의 하단이 composer 바로 위에 오게 맞춘다.
    const target = msgs[Math.min(4, msgs.length - 1)];
    const targetBottom = target.getBoundingClientRect().bottom;
    const composerTop = composerRef.current.getBoundingClientRect().top;
    const diff = targetBottom - (composerTop - 8);

    if (Math.abs(diff) > 4) {
      window.scrollBy({ top: diff, behavior: "auto" });
    }
  }, []);

  const scheduleChatFocusAlign = useCallback(() => {
    if (typeof window === "undefined") return;
    // iOS keyboard/layout viewport animation timing 편차 흡수.
    [0, 50, 150, 300, 600, 1000].forEach((ms) => {
      setTimeout(() => requestAnimationFrame(alignLatestMessagesAboveComposer), ms);
    });
  }, [alignLatestMessagesAboveComposer]);

  // 진입/방 변경/새 메시지 도착 시 최신글 5개 + 입력창이 함께 보이도록 맞춘다.
  // 단, 키보드가 열려있으면(포커스 중) 스크롤을 건드리지 않는다.
  useEffect(() => {
    lastAlignedCountRef.current = 0;
  }, [roomId]);

  useEffect(() => {
    if (loading || messages.length === 0) return;
    if (messages.length === lastAlignedCountRef.current) return;
    if (focusLockRef.current) return; // 키보드 열린 상태에서는 스크롤 안 건드림
    lastAlignedCountRef.current = messages.length;
    scheduleChatFocusAlign();
  }, [loading, messages.length, scheduleChatFocusAlign]);

  // Keyboard mode with viewport `interactive-widget=resizes-content`:
  // - Browser shrinks the layout viewport when the software keyboard opens.
  // - Composer can stay `position: fixed` with `bottom: 0` while focused; no
  //   visualViewport tracking/inset math is needed.
  // - While idle, composer sits above the global TabBar using its measured height.
  const [keyboardFocused, setKeyboardFocused] = useState(false);
  const [tabBarHeight, setTabBarHeight] = useState<number | null>(null);
  const composerBottom = tabBarHeight != null ? `${tabBarHeight}px` : "calc(52px + env(safe-area-inset-bottom, 0px))";

  useEffect(() => {
    if (typeof window === "undefined") return;
    const tabBar = document.querySelector<HTMLElement>("[data-global-tabbar]");
    if (!tabBar) return;

    const measure = () => {
      const height = tabBar.getBoundingClientRect().height;
      if (height > 0) setTabBarHeight(Math.round(height));
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(tabBar);
    window.addEventListener("resize", measure);

    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const closeKeyboardMode = () => {
      focusLockRef.current = false;
      document.body.classList.remove("kbd-open");
      setKeyboardFocused(false);
    };

    const onFocusIn = (e: FocusEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t || (t.tagName !== "INPUT" && t.tagName !== "TEXTAREA")) return;
      focusLockRef.current = true;
      document.body.classList.add("kbd-open");
      setKeyboardFocused(true);
      scheduleChatFocusAlign();

      [0, 50, 150, 300, 600, 900, 1200].forEach((ms) => {
        setTimeout(scheduleChatFocusAlign, ms);
      });
    };

    const onFocusOut = (e: FocusEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t || (t.tagName !== "INPUT" && t.tagName !== "TEXTAREA")) return;
      [50, 300].forEach((ms) => setTimeout(closeKeyboardMode, ms));
    };

    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      closeKeyboardMode();
    };
  }, [scheduleChatFocusAlign]);

  const activeComposerBottom = keyboardFocused ? "0px" : composerBottom;
  const renderedMessages = displayMessages;

  const homeTeam = getTeamById(homeTeamId)!;
  const awayTeam = getTeamById(awayTeamId)!;

  // 팬방 글쓰기 권한 체크: 전체는 누구나, 팬방은 해당 팀 팬만
  const qaKeyboardInputEnabled = typeof window !== "undefined"
    && new URLSearchParams(window.location.search).get("chatQaKeyboard") === "1";
  const myTeamId = profile?.team_id != null ? Number(profile.team_id) : undefined;
  const canWrite = (() => {
    if (qaKeyboardInputEnabled) return true;
    if (!isLoggedIn) return false;
    if (authLoading) return false;  // 프로필 로딩 중엔 입력 차단 (오판 방지)
    if (room === "all") return true;
    if (room === "home") return myTeamId === homeTeamId;
    if (room === "away") return myTeamId === awayTeamId;
    return false;
  })();

  const writeBlockedReason = (() => {
    if (!isLoggedIn) return "로그인 후 채팅 가능";
    if (authLoading) return "로딩 중...";
    if (!canWrite) {
      const teamName = room === "home" ? homeTeam.shortName : awayTeam.shortName;
      return `${teamName} 팬만 글쓰기 가능`;
    }
    return "";
  })();

  async function handleSend() {
    if (qaKeyboardInputEnabled) return;
    if (!input.trim() || !canWrite) return;
    const ok = await sendMessage(input.trim());
    if (ok) setInput("");
  }

  function formatTime(dateStr: string) {
    const d = new Date(dateStr);
    return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
  }

  const roomLabels: Record<ChatRoom, string> = {
    all: "전체 채팅",
    home: `${homeTeam.shortName} 팬방`,
    away: `${awayTeam.shortName} 팬방`,
  };

  return (
    <>
    <div className="flex flex-col">
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
                    {r !== "all" && (
                      <span className="text-[10px] text-text-tertiary ml-auto">
                        {r === "home" ? homeTeam.shortName : awayTeam.shortName}팬 전용
                      </span>
                    )}
                  </button>
                );
              })}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Mood gauge */}
      <MoodGauge homeTeamId={homeTeamId} awayTeamId={awayTeamId} homePct={homePct} />

      {/* Messages — newest first */}
      <div ref={scrollRef} className="px-4 py-2 space-y-0.5">
        {loading ? (
          <div className="text-center py-8 text-text-tertiary text-sm">로딩 중...</div>
        ) : messages.length === 0 ? (
          <div className="text-center py-8 text-text-tertiary">
            <p className="text-sm">아직 채팅이 없어요</p>
            <p className="text-xs mt-1">첫 번째 메시지를 보내보세요! 🔥</p>
          </div>
        ) : (
          <div className="space-y-0.5">
            <AnimatePresence initial={false}>
                {renderedMessages.map((msg) => {
                  const isMe = user?.id === msg.user_id;
                  return (
                    <motion.div
                      key={msg.id}
                      data-chat-msg
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.15 }}
                      className="flex items-start gap-2 py-0.5 group"
                    >
                      {msg.team_id && <TeamBadge teamId={msg.team_id} size="xs" className="shrink-0" />}
                      <div className="min-w-0 flex-1">
                        <span className="inline">
                          <span className={clsx("text-xs font-semibold mr-1 cursor-pointer hover:underline", isMe ? "text-accent" : "text-text-tertiary")} onClick={() => msg.user_id && window.location.assign(`/profile/${msg.user_id}`)}>
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
          </div>
        )}
      </div>

      {/* Input — fixed above TabBar when idle; fixed above keyboard when focused */}
      <div
        ref={composerRef}
        data-composer="game-chat"
        className="fixed left-0 right-0 z-[98] border-t border-border"
        style={{
          background: "var(--chat-input-bg, rgba(10,10,15,0.98))",
          backdropFilter: "blur(12px)",
          bottom: activeComposerBottom,
          transition: keyboardFocused ? "none" : "bottom 80ms ease-out",
        }}
      >
        <div className="max-w-[640px] mx-auto px-3 py-2 flex items-center gap-2">
          <div className="relative flex-1">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSend()}
              placeholder={cooldown ? (cooldownReason || "잠시 후 다시 입력하세요...") : canWrite ? (room === "all" ? "메시지 입력..." : `${roomLabels[room]}에 메시지...`) : writeBlockedReason}
              disabled={!canWrite}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              enterKeyHint="send"
              inputMode="text"
              name="chat-message"
              maxLength={120}
              className={clsx(
                "w-full h-10 px-4 rounded-full text-base",
                "bg-bg-tertiary text-text-primary placeholder:text-text-tertiary",
                "border focus:outline-none transition-colors",
                !canWrite && "opacity-50",
                input.length >= 120 ? "border-red-500/60" : "border-border focus:border-accent/50"
              )}
            />
            {input.length >= 100 && (
              <span className={clsx(
                "absolute right-3 top-1/2 -translate-y-1/2 text-[10px] pointer-events-none",
                input.length >= 120 ? "text-red-400" : "text-text-tertiary"
              )}>
                {input.length}/120
              </span>
            )}
          </div>
          <motion.button
            whileTap={{ scale: 0.9 }}
            onClick={handleSend}
            disabled={!input.trim() || !canWrite || cooldown}
            className={clsx(
              "w-10 h-10 rounded-full flex items-center justify-center shrink-0 transition-colors",
              input.trim() && canWrite && !cooldown ? "bg-accent text-white" : "bg-bg-tertiary text-text-tertiary"
            )}
          >
            <Send className="w-5 h-5" />
          </motion.button>
        </div>
      </div>
    </div>
    </>
  );
}
