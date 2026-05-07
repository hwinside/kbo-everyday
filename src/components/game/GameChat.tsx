"use client";

import { useState, useRef, useEffect } from "react";
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
  const composerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 최신순: 최신 메시지가 리스트 상단. 크관은 중계↔최신댓글 왕복 부담을
  // 줄이기 위해 최신글이 위에 오는 레이아웃을 사용한다.
  const displayMessages = [...messages].reverse();

  /*
   * V3: inline composer (TOP) 모델
   * ----------------------------------------------------------------
   * - composer는 fixed가 아니라 messages 리스트 *앞*(MoodGauge 직후)에
   *   inline 배치한다. reverse(최신순) 리스트의 최신글이 composer 바로
   *   아래로 슬롯되어 "최신글=상단" 제약을 만족.
   * - focus 시 textarea를 scrollIntoView({block:"start"}) 단발 — iOS
   *   native가 키보드 + 액세서리 바(^V✓)와 함께 자동 정렬하도록 위임.
   *   visualViewport listener / window.scrollBy / 다중 setTimeout align
   *   루프는 전부 제거(V2 회귀 방지).
   * - body.kbd-open 토글로 TabBar 숨김. iOS interactive-widget=
   *   resizes-content가 layout viewport를 키보드만큼 줄여준다.
   * - 풀스크린 focus 효과(=focus 시 채팅 풀화면)는 V4로 분리한다.
   */
  useEffect(() => {
    if (typeof window === "undefined") return;

    const isComposerTarget = (target: EventTarget | null) => {
      const t = target as HTMLElement | null;
      if (!t || (t.tagName !== "INPUT" && t.tagName !== "TEXTAREA")) return false;
      return Boolean(t.closest('[data-composer="game-chat"]'));
    };

    const onFocusIn = (e: FocusEvent) => {
      if (!isComposerTarget(e.target)) return;
      document.body.classList.add("kbd-open");
      // composer-top 모델: focused textarea를 viewport *상단*으로 정렬.
      // 페이지 상단(Room selector / MoodGauge)이 화면 밖으로 밀리고
      // composer + 최신글 묶음만 보이게 된다. iOS form-assistant는
      // 액세서리 바를 focused input 위로 자동 push.
      requestAnimationFrame(() => {
        textareaRef.current?.scrollIntoView({ block: "start", behavior: "auto" });
      });
    };

    const onFocusOut = (e: FocusEvent) => {
      if (!isComposerTarget(e.target)) return;
      // settle: 한글 IME 토글 등 짧은 blur→refocus 흡수
      const settle = () => {
        if (!isComposerTarget(document.activeElement)) {
          document.body.classList.remove("kbd-open");
        }
      };
      setTimeout(settle, 100);
    };

    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      document.body.classList.remove("kbd-open");
    };
  }, []);

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

      {/* Input — INLINE composer (TOP, V3).
          composer는 messages 리스트 *앞*(MoodGauge 직후)에 위치. reverse
          리스트의 최신글이 composer 바로 아래로 슬롯되어 "최신글=상단"
          제약을 만족한다. fixed 폐기 + focus 시 textarea.scrollIntoView
          ({block:"start"}) 단발만. iOS interactive-widget=resizes-content가
          layout viewport를 키보드만큼 줄여주고, 액세서리 바(^V✓)는 native
          form-assistant가 focused input 위로 자동 push.
          textarea는 auto-grow (Safari 17.4+ field-sizing:content + JS scrollHeight
          fallback). max 4줄(~6rem) 후 내부 세로 스크롤. */}
      <div
        ref={composerRef}
        data-composer="game-chat"
        className="border-b border-border bg-bg-secondary/95"
        style={{ backdropFilter: "blur(12px)" }}
      >
        <div className="max-w-[640px] mx-auto px-3 py-2 flex items-end gap-2">
          <div className="relative flex-1">
            <textarea
              ref={textareaRef}
              rows={1}
              value={input}
              onChange={(e) => {
                const v = e.target.value.replace(/\n/g, "");
                if (v.length <= 120) setInput(v);
                const el = e.target;
                el.style.height = "auto";
                el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleSend();
                }
              }}
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
              style={{ fieldSizing: "content" } as React.CSSProperties}
              className={clsx(
                "w-full min-h-[40px] max-h-[6rem] px-4 py-2 rounded-2xl text-base leading-6",
                "resize-none overflow-y-auto",
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

      {/* Messages — 최신순(최신→오래된), 최신글이 리스트 상단 */}
      <div className="px-4 py-2 space-y-0.5">
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

    </div>
  );
}
