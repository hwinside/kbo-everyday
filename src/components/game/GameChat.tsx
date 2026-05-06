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
  const prevKeyboardFocusedRef = useRef(false);
  const lastAlignedCountRef = useRef(0);
  // 삼순이 NO-GO (2026-05-06): focus-entry align 타이머 추적용.
  // rapid focus→blur→focus 시 stale 타이머가 새 focus 위에 누적 fire하면
  // scrollTo가 다중 호출되어 jump 발생할 수 있음 → blur 시 cancel 필요.
  const focusAlignTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const [keyboardFocused, setKeyboardFocused] = useState(false);
  // ref mirror of keyboardFocused for sync access from non-React-state code
  // (alignLatestMessagesAboveComposer / messages effect closure).
  const keyboardFocusedRef = useRef(false);
  const [tabBarHeight, setTabBarHeight] = useState<number | null>(null);

  // 최신순: 최신 메시지가 리스트 상단. 크관은 중계↔최신댓글 왕복 부담을
  // 줄이기 위해 최신글이 위에 오는 레이아웃을 사용한다.
  const displayMessages = [...messages].reverse();

  // 최신 5개 메시지 묶음이 입력창 바로 위에 보이도록 window 스크롤을 맞춘다.
  // 최신순 상단이므로 5번째 최신 메시지(DOM idx 4)의 하단이 composer 바로 위.
  const alignLatestMessagesAboveComposer = useCallback((opts?: { bypassFocusGuard?: boolean }) => {
    // CSO 삼순이 NO-GO #1 (2026-05-06): focus 중에는 window.scrollTo 절대 차단.
    // messages.length effect 등 모든 진입점에 대한 defense-in-depth 가드.
    // 예외: focus 진입 직후 5→50 slice 확장 후 1회 정렬은 bypassFocusGuard로 통과
    // (Webkit DOM QA visible=0/8 회귀 / iOS 26.4 시뮬 메시지 가려짐 회귀 해소).
    if (!opts?.bypassFocusGuard && keyboardFocusedRef.current) return;
    if (!scrollRef.current || !composerRef.current) return;
    const msgs = scrollRef.current.querySelectorAll<HTMLElement>("[data-chat-msg]");
    if (msgs.length === 0) return;

    const target = msgs[Math.min(4, msgs.length - 1)];
    // scrollTo 절대 위치 방식: scrollBy 누적 drift 완전 제거.
    // 고정 composer의 viewport top은 scrollY 무관 (fixed positioning).
    // keyboardLift transform 제거 후 composer top은 그대로 사용.
    const targetDocBottom = target.getBoundingClientRect().bottom + window.scrollY;
    const composerVpTop = composerRef.current.getBoundingClientRect().top;
    const desired = targetDocBottom - composerVpTop + 8;
    if (desired < 0) return;
    if (Math.abs(desired - window.scrollY) <= 4) return; // 이미 정렬됨
    window.scrollTo({ top: desired, behavior: "auto" });
  }, []);

  const scheduleChatFocusAlign = useCallback(() => {
    if (typeof window === "undefined") return;
    // scrollTo가 idempotent이므로 3회면 충분. 키보드 애니메이션 ~400ms 커버.
    // (rAF 사용 OK: 이 함수는 focus→idle / messages.length 경로에서만 호출되며
    //  키보드가 dismiss된 상태에선 iOS Safari가 rAF 콜백을 정상 실행함.
    //  키보드 raise 중 rAF suspend 이슈는 아래 scheduleChatFocusEntryAlign 참고.)
    requestAnimationFrame(() => alignLatestMessagesAboveComposer());
    setTimeout(() => requestAnimationFrame(() => alignLatestMessagesAboveComposer()), 200);
    setTimeout(() => requestAnimationFrame(() => alignLatestMessagesAboveComposer()), 500);
  }, [alignLatestMessagesAboveComposer]);

  // idle→focus 진입 시 1회 정렬: 5→50 slice 확장 직후, 키보드 raise 동안
  // 최신 5개 메시지가 composer 위에 보이도록 scrollTo 절대 정렬.
  // bypassFocusGuard=true 로 keyboardFocusedRef 가드를 우회 (focus-entry 한정).
  // 100/350/700ms 3회는 키보드 애니메이션 + visualViewport resize 타이밍 커버.
  // ⚠️ requestAnimationFrame은 사용 금지: iOS Safari는 키보드 raise 애니메이션
  //    중 rAF 콜백을 suspend하여 호출되지 않는다 (실측 확인 2026-05-06).
  //    scrollTo는 idempotent하므로 동기 호출로 충분.
  const scheduleChatFocusEntryAlign = useCallback(() => {
    if (typeof window === "undefined") return;
    // 삼순이 NO-GO (2026-05-06): rapid focus→blur→focus 시 stale 타이머가
    // 새 focus 위에 누적되어 scrollTo가 다중 호출되는 문제 방지.
    // 새 batch 시작 전 기존 pending 타이머 모두 cancel.
    focusAlignTimersRef.current.forEach(clearTimeout);
    const align = () => alignLatestMessagesAboveComposer({ bypassFocusGuard: true });
    focusAlignTimersRef.current = [
      setTimeout(align, 100),
      setTimeout(align, 350),
      setTimeout(align, 700),
    ];
  }, [alignLatestMessagesAboveComposer]);

  // focus 종료 시 pending focus-entry 타이머 cancel.
  const cancelFocusEntryAligns = useCallback(() => {
    focusAlignTimersRef.current.forEach(clearTimeout);
    focusAlignTimersRef.current = [];
  }, []);

  // 진입/방 변경/새 메시지 도착 시 최신글 5개 + 입력창이 함께 보이도록 맞춘다.
  useEffect(() => {
    lastAlignedCountRef.current = 0;
  }, [roomId]);

  useEffect(() => {
    if (loading || messages.length === 0) return;
    if (messages.length === lastAlignedCountRef.current) return;
    lastAlignedCountRef.current = messages.length;
    // CSO 삼순이 NO-GO #1 (2026-05-06): focus 중 새 메시지/late load가 들어와도
    // window.scrollTo 호출하지 않는다. focus 해제 시 prevKeyboardFocusedRef
    // effect에서 재정렬됨.
    if (keyboardFocusedRef.current) return;
    scheduleChatFocusAlign();
  }, [loading, messages.length, scheduleChatFocusAlign]);

  // 키보드 포커스 전환 시 정렬:
  //  - idle→focus: 5→50 slice 확장 직후 1회 align (focus-entry, focusedRef 우회)
  //  - focus→idle: 5-slice 위치 복원 align (기존 동작)
  useEffect(() => {
    if (prevKeyboardFocusedRef.current === keyboardFocused) return;
    prevKeyboardFocusedRef.current = keyboardFocused;
    if (loading || messages.length === 0) return;
    if (keyboardFocused) {
      scheduleChatFocusEntryAlign();
    } else {
      scheduleChatFocusAlign();
    }
  }, [keyboardFocused, loading, messages.length, scheduleChatFocusAlign, scheduleChatFocusEntryAlign]);

  // composer는 idle일 때 TabBar 위, focus일 때 viewport bottom(=keyboard 위).
  // viewport meta `interactiveWidget: "resizes-content"` 가 layout viewport를
  // 키보드만큼 줄여주므로 focus 시 `bottom: 0`이 자연스럽게 키보드 위에 붙는다.
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

    const isGameChatComposerTarget = (target: EventTarget | null) => {
      const t = target as HTMLElement | null;
      if (!t || (t.tagName !== "INPUT" && t.tagName !== "TEXTAREA")) return false;
      return Boolean(t.closest('[data-composer="game-chat"]'));
    };

    // CSO 삼순이 NO-GO #2 (2026-05-06): visualViewport 이벤트 기반 timed lift
    // 루프 (9개 setTimeout × accessoryOffset=125 × clamp max 90)를 완전 제거.
    // viewport meta interactiveWidget="resizes-content" 가 layout viewport를
    // 키보드만큼 줄여주므로 composer는 fixed bottom: 0 만으로 키보드 위에 붙는다.
    // QuickType/IME accessory 차이는 매직 오프셋이 아니라 OS가 처리할 영역이며,
    // 매직값은 기기/iOS 버전 간 회귀를 만들기 때문에 두지 않는다.

    const onFocusIn = (e: FocusEvent) => {
      if (!isGameChatComposerTarget(e.target)) return;
      document.body.classList.add("kbd-open");
      keyboardFocusedRef.current = true;
      setKeyboardFocused(true);
      // align/scrollBy 호출 없음: native scroll-into-view + bottom:0 가 배치 담당.
    };

    const onFocusOut = (e: FocusEvent) => {
      if (!isGameChatComposerTarget(e.target)) return;
      // 짧은 지연: blur → 다시 focus(예: 한글 IME 토글) 케이스 흡수
      const settle = () => {
        if (isGameChatComposerTarget(document.activeElement)) return;
        document.body.classList.remove("kbd-open");
        keyboardFocusedRef.current = false;
        setKeyboardFocused(false);
        // 삼순이 NO-GO (2026-05-06): blur 확정 시 pending focus-entry align 타이머
        // 모두 cancel — rapid focus→blur→focus stale 타이머 누적 jump 방지.
        cancelFocusEntryAligns();
      };
      setTimeout(settle, 50);
      setTimeout(settle, 300);
    };

    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      document.body.classList.remove("kbd-open");
    };
  }, [cancelFocusEntryAligns]);

  // idle: 최신 5개만 표시하여 score 영역 자연 노출
  // focus: 전체 메시지 (자유 스크롤)
  const renderedMessages = keyboardFocused ? displayMessages : displayMessages.slice(0, 5);

  const homeTeam = getTeamById(homeTeamId)!;
  const awayTeam = getTeamById(awayTeamId)!;

  // 팬방 글쓰기 권한 체크: 전체는 누구나, 팬방은 해당 팀 팬만
  const qaKeyboardInputEnabled = typeof window !== "undefined"
    && new URLSearchParams(window.location.search).get("chatQaKeyboard") === "1";
  const qaAutoFocus = typeof window !== "undefined"
    && new URLSearchParams(window.location.search).get("chatQaAutoFocus") === "1";

  // QA auto-focus: 페이지 로드 후 textarea 자동 포커스 (시뮬레이터 자동화용)
  useEffect(() => {
    if (!qaAutoFocus) return;
    const timer = setTimeout(() => {
      const ta = composerRef.current?.querySelector("textarea");
      if (ta) ta.focus();
    }, 2000);
    return () => clearTimeout(timer);
  }, [qaAutoFocus]);
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

      {/* Messages — 최신순(최신→오래된), 최신글이 리스트 상단 */}
      <div
        ref={scrollRef}
        className="px-4 py-2 space-y-0.5"
        style={{ paddingBottom: `${56 + (keyboardFocused ? 0 : (tabBarHeight ?? 56))}px` }}
      >
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

      {/* Input — always fixed: above TabBar when idle, above keyboard when focused.
          interactiveWidget=resizes-content가 layout viewport를 키보드만큼 줄여
          주므로 focus 시 `bottom: 0`이 키보드 위에 자연스럽게 붙는다. */}
      <div
        ref={composerRef}
        data-composer="game-chat"
        className="fixed left-0 right-0 z-[98] border-t border-border"
        style={{
          background: keyboardFocused ? "rgba(10,10,15,1)" : "var(--chat-input-bg, rgba(10,10,15,0.98))",
          backdropFilter: keyboardFocused ? undefined : "blur(12px)",
          bottom: keyboardFocused ? "0px" : composerBottom,
          transition: keyboardFocused ? "none" : "bottom 80ms ease-out",
        }}
      >
        <div className="max-w-[640px] mx-auto px-3 py-2 flex items-center gap-2">
          <div className="relative flex-1">
            <textarea
              rows={1}
              value={input}
              onChange={(e) => {
                const v = e.target.value.replace(/\n/g, "");
                if (v.length <= 120) setInput(v);
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
              className={clsx(
                "w-full h-10 px-4 rounded-full text-base resize-none overflow-hidden",
                "bg-bg-tertiary text-text-primary placeholder:text-text-tertiary",
                "border focus:outline-none transition-colors",
                "leading-10",
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
