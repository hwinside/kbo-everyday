"use client";

import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Send, Users, Flame, Trash2, Flag, Ban, MoreHorizontal, Reply, X, ImagePlay, EyeOff } from "lucide-react";
import { clsx } from "clsx";
import TeamBadge from "@/components/ui/TeamBadge";
import { getTeamById, isAllStarGame } from "@/lib/constants/teams";
import { allStarSideOfTeam } from "@/lib/constants/allstar-2026";
import { useChat, useChatCounts, type ChatMessage } from "@/lib/supabase/useChat";
import { useMoodGauge } from "@/lib/supabase/useMoodGauge";
import { useAuth } from "@/lib/supabase/AuthContext";
import { useBlockedIds, blockUserById } from "@/lib/supabase/useBlock";
import { supabase } from "@/lib/supabase/client";
import ReportSheet from "@/components/community/ReportSheet";
import GifPicker, { isGifComment } from "@/components/community/GifPicker";
import { buildCanonicalGiphyUrl } from "@/lib/community/giphy";
import { shouldShowVenueBadge, type VenueAttendees } from "@/lib/venue-stories/chat-badge";

interface GameChatProps {
  gameId: string;
  homeTeamId: number;
  awayTeamId: number;
  onHide?: () => void;
  toggleDisabled?: boolean;
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
function getRoomId(gameId: string): string {
  return `game:${gameId}`;
}

export default function GameChat({ gameId, homeTeamId, awayTeamId, onHide, toggleDisabled = false }: GameChatProps) {
  const roomId = getRoomId(gameId);
  const { messages, loading, loadingMore, hasMore, loadMore, sendMessage, deleteMyMessage, deleteAnyMessage, cooldown, cooldownReason, isLoggedIn, countReconcileKey } = useChat(roomId);
  const { homePct } = useMoodGauge(gameId, homeTeamId, awayTeamId);
  // 누적 카운트: 서버 count 베이스라인 + 새 도착 메시지 낙관적 즉시 증분(실시간 UX).
  const chatCounts = useChatCounts(roomId, homeTeamId, awayTeamId, messages, {
    reconcileKey: countReconcileKey,
  });
  const { user, profile, loading: authLoading } = useAuth();
  const { blockedIds } = useBlockedIds();
  const canModerateChat = profile?.is_operator === true;
  const [input, setInput] = useState("");
  const [showGifPicker, setShowGifPicker] = useState(false);
  const [msgMenuId, setMsgMenuId] = useState<number | null>(null);
  // 답글 대상 원글(루트). null이면 일반 메시지 전송.
  const [replyTo, setReplyTo] = useState<{ id: number; nickname: string } | null>(null);
  const [showReport, setShowReport] = useState(false);
  const [reportTargetId, setReportTargetId] = useState<number | null>(null);
  // [직관] 배지 — 이 경기에 직관 스토리(status='active')를 올린 유저 id 집합.
  // 경기당 1회 로드 후 client 매핑(메시지별 개별 조회 금지). Realtime 신규
  // 메시지도 user_id 매핑이라 자동 적용. 실패 시 배지만 생략(채팅 무영향).
  // [직관] 배지 명단은 반드시 *어느 경기의 명단인지*(gameId)와 함께 저장한다 —
  // 유저가 여러 경기 크관을 오갈 때 이전 경기 명단이 새 경기 채팅에 오표시되는 것을
  // 렌더 시점 gameId 일치 검사로 구조적으로 차단(fetch 응답 지연/경합에도 안전).
  const [venueAttendees, setVenueAttendees] = useState<VenueAttendees | null>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

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
      // 강제 scrollIntoView 점프 제거 (2026-05-27 #cs 회귀):
      // V3는 focus 시 textarea를 viewport 상단으로 강제 정렬했으나, iOS
      // form-assistant 자동 정렬과 충돌해 사용자가 보던 영역이 어색하게
      // 튀어오르는 회귀 발생. interactive-widget=resizes-content + form-
      // assistant native 동작에 위치 정렬을 전적으로 위임한다.
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

  useEffect(() => {
    let cancelled = false;
    const fetchedGameId = gameId;
    fetch(`/api/venue-stories/attendees?gameId=${encodeURIComponent(fetchedGameId)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((d) => {
        if (!cancelled && Array.isArray(d?.userIds)) {
          setVenueAttendees({ gameId: fetchedGameId, ids: new Set(d.userIds as string[]) });
        }
      })
      .catch(() => { /* 배지 로드 실패는 무시 — 채팅 기능 무영향 */ });
    return () => { cancelled = true; };
  }, [gameId]);

  // 무한 스크롤: list 끝(가장 오래된 메시지 아래) sentinel이 viewport에
  // 잡히면 이전 50개 추가 로드. 추가는 화면 *아래*로 자라므로 scroll
  // anchor 보존이 필요 없다(현재 보고 있는 컨텐츠가 위쪽에 그대로 유지).
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (loading || !hasMore) return;
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore();
      },
      { rootMargin: "200px 0px 200px 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [loading, hasMore, loadMore]);

  // 삭제된 메시지는 화면에서 완전히 숨김(placeholder 미표시).
  // DB는 여전히 soft-delete(content 마스킹 + deleted_at)로 보존됨.
  // 차단한 유저의 메시지도 즉시 숨김(차단 시 useBlockedIds 브로드캐스트로 갱신).
  const visibleMessages = displayMessages.filter((m) => m.deleted_at == null && !blockedIds.has(m.user_id));

  // 1-depth 답글 그룹핑: 원글 + 각 원글의 답글(오래된→최신).
  // 답글은 타임라인에 흩어지지 않고 원글 아래로 묶여 전부 노출된다(접기 없음).
  // 원글이 삭제/차단으로 숨겨진 답글은 그룹이 없어 자연히 미표시.
  // 그룹 정렬은 max(원글, 최신답글) 기준 최신순 — 오래된 원글에 새 답글이 달리면
  // 그룹이 상단으로 올라와 묻히지 않는다(크관 최신순 유지).
  const repliesByParent = new Map<number, ChatMessage[]>();
  for (const m of visibleMessages) {
    if (m.reply_to_id != null) {
      const arr = repliesByParent.get(m.reply_to_id);
      if (arr) arr.push(m);
      else repliesByParent.set(m.reply_to_id, [m]);
    }
  }
  const rootGroups = visibleMessages
    .filter((m) => m.reply_to_id == null)
    .map((root) => {
      const replies = (repliesByParent.get(root.id) ?? [])
        .slice()
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
      const lastReplyAt = replies.length ? replies[replies.length - 1].created_at : "";
      const lastActivity = lastReplyAt > root.created_at ? lastReplyAt : root.created_at;
      return { root, replies, lastActivity };
    })
    .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));

  // 올스타 크관 한정: 유저 팀 라벨 왼쪽에 최애팀 소속 사이드(나눔/드림) 표기
  // (하린아빠 2026-07-11). 매핑은 팬 분위기와 동일(allStarSideOfTeam).
  const isAllStar = isAllStarGame(awayTeamId, homeTeamId);
  function renderSideLabel(teamId: number | null | undefined) {
    if (!isAllStar) return null;
    const sideId = allStarSideOfTeam(teamId);
    if (!sideId) return null;
    const side = getTeamById(sideId);
    if (!side) return null;
    return (
      <span className="text-[10px] font-bold shrink-0 mt-0.5" style={{ color: side.colorLight }}>
        {side.shortName}
      </span>
    );
  }

  // 채팅 글쓰기 권한: 로그인 + 프로필 로딩 완료면 누구나 (전체 채팅 단일 방)
  const qaKeyboardInputEnabled = typeof window !== "undefined"
    && new URLSearchParams(window.location.search).get("chatQaKeyboard") === "1";
  const canWrite = (() => {
    if (qaKeyboardInputEnabled) return true;
    if (!isLoggedIn) return false;
    if (authLoading) return false;  // 프로필 로딩 중엔 입력 차단 (오판 방지)
    return true;
  })();

  const writeBlockedReason = (() => {
    if (!isLoggedIn) return "로그인 후 채팅 가능";
    if (authLoading) return "로딩 중...";
    return "";
  })();

  async function handleSend() {
    if (qaKeyboardInputEnabled) return;
    if (!input.trim() || !canWrite) return;
    const ok = await sendMessage(input.trim(), replyTo?.id ?? null);
    if (ok) {
      setInput("");
      setReplyTo(null);
    }
  }

  async function handleGifSelect(gifUrl: string, gifId: string) {
    if (qaKeyboardInputEnabled || !canWrite || cooldown) return;
    const canonicalUrl = buildCanonicalGiphyUrl(gifId);
    if (!canonicalUrl || !isGifComment(gifUrl)) return;
    const ok = await sendMessage(canonicalUrl, replyTo?.id ?? null);
    if (ok) {
      setShowGifPicker(false);
      setReplyTo(null);
    }
  }

  // 답글 작성 시작 — 입력창에 대상 칩 표시 + textarea 포커스. (루트 메시지에만)
  function startReply(msg: ChatMessage) {
    setMsgMenuId(null);
    setReplyTo({ id: msg.id, nickname: msg.nickname || "익명" });
    setTimeout(() => textareaRef.current?.focus(), 0);
  }

  async function handleDelete(messageId: number, isMine: boolean) {
    if (typeof window === "undefined") return;
    setMsgMenuId(null);
    const ok = window.confirm("이 메시지를 삭제하시겠어요?\n삭제된 메시지는 복구할 수 없습니다.");
    if (!ok) return;
    // 본인 메시지는 본인삭제 RPC, 타인 메시지는 운영자삭제 RPC(서버측 is_operator 확인).
    if (isMine) await deleteMyMessage(messageId);
    else await deleteAnyMessage(messageId);
  }

  // 채팅 메시지 신고 — ReportSheet(targetType 'chat') 오픈.
  function openReport(messageId: number) {
    setMsgMenuId(null);
    if (!user) return;
    setReportTargetId(messageId);
    setShowReport(true);
  }

  // 채팅 사용자 차단 — ①user_blocks 등록 ②운영팀에 해당 메시지 자동 신고 ③메시지 즉시 숨김(브로드캐스트).
  async function handleBlock(targetUserId: string, messageId: number) {
    setMsgMenuId(null);
    if (!user || targetUserId === user.id) return;
    if (!window.confirm("이 사용자를 차단할까요?\n차단하면 이 사용자의 메시지·글·댓글이 더 이상 보이지 않으며, 운영팀에 자동으로 신고됩니다.")) return;
    const ok = await blockUserById(user.id, targetUserId);
    if (!ok) { window.alert("차단에 실패했어요. 잠시 후 다시 시도해주세요."); return; }
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.access_token) {
        await fetch("/api/report", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
          body: JSON.stringify({ targetType: "chat", targetId: messageId, reason: "block", detail: "사용자 차단에 따른 자동 신고" }),
        });
      }
    } catch { /* 신고 실패는 차단을 막지 않음 */ }
  }

  function formatTime(dateStr: string) {
    const d = new Date(dateStr);
    return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
  }

  // 메시지 본문(닉네임 + 내용) — 루트/답글 공용.
  function renderMsgBody(msg: ChatMessage) {
    const isMe = user?.id === msg.user_id;
    const isGif = isGifComment(msg.content);
    return (
      <div className="min-w-0 flex-1">
        {shouldShowVenueBadge(venueAttendees, gameId, msg.user_id) && (
          <span className="inline-block text-[9px] font-bold text-accent-green border border-accent-green/40 rounded px-1 mr-1 align-[1px]">
            직관
          </span>
        )}
        <span
          className={clsx("text-xs font-semibold mr-1 cursor-pointer hover:underline", isMe ? "text-accent" : "text-text-tertiary")}
          onClick={() => msg.user_id && window.location.assign(`/profile/${msg.user_id}`)}
        >
          {msg.nickname || "익명"}
        </span>
        {isGif ? (
          // eslint-disable-next-line @next/next/no-img-element -- GIPHY 애니메이션 원본을 그대로 재생한다.
          <img
            src={msg.content.trim()}
            alt="GIPHY GIF"
            loading="lazy"
            className="mt-1 w-auto h-auto max-w-[160px] max-h-[120px] rounded-lg object-contain"
          />
        ) : (
          <span className="text-sm text-text-primary">{msg.content}</span>
        )}
      </div>
    );
  }

  // 메시지 액션(시간 + 답글[루트만] + 삭제/신고/차단/운영자삭제) — 루트/답글 공용.
  function renderMsgActions(msg: ChatMessage, opts: { canReply: boolean }) {
    const isMe = user?.id === msg.user_id;
    return (
      <div className="flex items-center gap-1 shrink-0 mt-0.5">
        <span className="text-[10px] text-text-tertiary opacity-0 group-hover:opacity-100 transition-opacity">
          {formatTime(msg.created_at)}
        </span>
        {opts.canReply && canWrite && (
          <button
            type="button"
            onClick={() => startReply(msg)}
            aria-label="답글"
            className="text-text-tertiary hover:text-accent opacity-50 hover:opacity-100 transition-colors p-1 -m-1"
          >
            <Reply size={12} />
          </button>
        )}
        {isMe ? (
          <button
            type="button"
            onClick={() => handleDelete(msg.id, true)}
            aria-label="메시지 삭제"
            className="text-text-tertiary hover:text-red-400 opacity-50 hover:opacity-100 transition-colors p-1 -m-1"
          >
            <Trash2 size={12} />
          </button>
        ) : user ? (
          <div className="relative">
            <button
              type="button"
              onClick={() => setMsgMenuId((prev) => (prev === msg.id ? null : msg.id))}
              aria-label="메시지 메뉴"
              className="text-text-tertiary hover:text-text-primary opacity-50 hover:opacity-100 transition-colors p-1 -m-1"
            >
              <MoreHorizontal size={12} />
            </button>
            {msgMenuId === msg.id && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setMsgMenuId(null)} />
                <div className="absolute right-0 top-5 z-20 min-w-[88px] rounded-lg border border-border bg-bg-primary shadow-lg overflow-hidden">
                  <button onClick={() => openReport(msg.id)} className="flex items-center gap-1.5 w-full px-3 py-2 text-left text-xs text-text-primary hover:bg-bg-tertiary">
                    <Flag size={12} /> 신고
                  </button>
                  <button onClick={() => handleBlock(msg.user_id, msg.id)} className="flex items-center gap-1.5 w-full px-3 py-2 text-left text-xs text-text-primary hover:bg-bg-tertiary">
                    <Ban size={12} /> 차단
                  </button>
                  {canModerateChat && (
                    <button onClick={() => handleDelete(msg.id, false)} className="block w-full px-3 py-2 text-left text-xs text-[#FF453A] hover:bg-bg-tertiary">삭제</button>
                  )}
                </div>
              </>
            )}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {/* Chat header — 전체 채팅 단일 방 (팀 팬방 제거) */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
        <div className="flex items-center gap-2">
          <Users className="w-4 h-4 text-text-tertiary" />
          <span className="text-sm font-semibold text-text-primary">전체 채팅</span>
        </div>
        {(() => {
          // 누적 총 메시지 수 + 홈/원정 최애유저 글 수 (서버 집계, 로드분과 무관).
          // 집계 전/실패 시에는 fail-closed "—" 표시 — 로드된 개수(messages.length)를
          // 총계처럼 보여주던 fallback은 오표시라 제거(삼순 라운드2 blocker).
          const home = getTeamById(homeTeamId);
          const away = getTeamById(awayTeamId);
          if (!chatCounts || !home || !away) {
            return <span className="text-xs text-text-tertiary">메시지 집계 중…</span>;
          }
          return (
            <span className="text-xs text-text-tertiary">
              총 {chatCounts.total}
              <span className="mx-1">·</span>
              <span style={{ color: away.colorLight }}>{away.shortName} {chatCounts.away}</span>
              <span className="mx-1">·</span>
              <span style={{ color: home.colorLight }}>{home.shortName} {chatCounts.home}</span>
            </span>
          );
        })()}
      </div>

      {/* Mood gauge */}
      <MoodGauge homeTeamId={homeTeamId} awayTeamId={awayTeamId} homePct={homePct} />

      {onHide && (
        <div className="flex justify-end border-b border-border px-4 py-2">
          <button
            type="button"
            onClick={onHide}
            disabled={toggleDisabled}
            className="flex items-center gap-1.5 rounded-lg border border-accent/50 px-3 py-1.5 text-xs font-medium text-accent disabled:opacity-50"
            aria-label="전체 채팅 끄기"
          >
            <EyeOff size={14} /> 채팅 끄기
          </button>
        </div>
      )}

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
        {replyTo && (
          <div className="max-w-[640px] mx-auto px-3 pt-2">
            <div className="flex items-center gap-1.5 rounded-lg bg-bg-tertiary/70 px-2.5 py-1.5 text-xs text-text-tertiary">
              <Reply size={12} className="shrink-0 text-accent" />
              <span className="min-w-0 truncate">
                <span className="font-medium text-accent">{replyTo.nickname}</span>님에게 답글
              </span>
              <button
                type="button"
                onClick={() => setReplyTo(null)}
                aria-label="답글 취소"
                className="ml-auto -m-0.5 p-0.5 hover:text-text-primary"
              >
                <X size={12} />
              </button>
            </div>
          </div>
        )}
        <div className="max-w-[640px] mx-auto px-3 py-2 flex items-center gap-2">
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              textareaRef.current?.blur();
              setShowGifPicker((open) => !open);
            }}
            disabled={!canWrite || cooldown}
            aria-label="GIF"
            className={clsx(
              "w-10 h-10 rounded-full flex items-center justify-center shrink-0 transition-colors",
              showGifPicker ? "bg-accent/20 text-accent" : "bg-bg-tertiary text-text-tertiary",
              (!canWrite || cooldown) && "opacity-50"
            )}
          >
            <ImagePlay className="w-5 h-5" />
          </button>
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
              onFocus={() => setShowGifPicker(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder={cooldown ? (cooldownReason || "잠시 후 다시 입력하세요...") : !canWrite ? writeBlockedReason : replyTo ? `${replyTo.nickname}님에게 답글...` : "메시지 입력..."}
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
                "block w-full min-h-[40px] max-h-[6rem] px-4 py-2 rounded-2xl text-base leading-6",
                "resize-none overflow-y-auto hide-scrollbar",
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
        {/* 매너 안내 — 모든 크관 입력창 바로 아래 상시 노출 (2026-08-21 하린아빠 지시, 문구 원문 고정) */}
        <p
          data-testid="kgwan-manner-notice"
          className="max-w-[640px] mx-auto px-3 pb-2 text-[11px] leading-4 text-text-tertiary"
        >
          크보팬 내 여러분들의 닉네임 옆에는 팀 명이 언제나 함께 붙어다닙니다. 매너 있는 글은 응원팀을 더 멋지게 만들고, 그렇지 않은 글은 응원팀을 부끄럽게 만듭니다. 매너를 꼭 지켜주세요.
        </p>
        <AnimatePresence initial={false}>
          {showGifPicker && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 280, opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="max-w-[640px] mx-auto overflow-hidden border-t border-border"
            >
              <GifPicker
                onSelect={handleGifSelect}
                onClose={() => setShowGifPicker(false)}
              />
            </motion.div>
          )}
        </AnimatePresence>
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
                {rootGroups.map(({ root, replies }) => (
                  <motion.div
                    key={root.id}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.15 }}
                  >
                    {/* 원글(루트) */}
                    <div data-chat-msg className="flex items-start gap-2 py-0.5 group">
                      {renderSideLabel(root.team_id)}
                      {root.team_id && <TeamBadge teamId={root.team_id} size="xs" className="shrink-0" />}
                      {renderMsgBody(root)}
                      {renderMsgActions(root, { canReply: true })}
                    </div>
                    {/* 1-depth 답글 — 원글 아래 묶어서 전부 노출(접기 없음) */}
                    {replies.length > 0 && (
                      <div className="ml-5 mt-0.5 space-y-0.5 border-l-2 border-border/50 pl-2.5">
                        {replies.map((reply) => (
                          <div key={reply.id} data-chat-msg className="flex items-start gap-2 py-0.5 group">
                            {renderSideLabel(reply.team_id)}
                            {reply.team_id && <TeamBadge teamId={reply.team_id} size="xs" className="shrink-0" />}
                            {renderMsgBody(reply)}
                            {renderMsgActions(reply, { canReply: false })}
                          </div>
                        ))}
                      </div>
                    )}
                  </motion.div>
                ))}
            </AnimatePresence>
            {hasMore ? (
              <div ref={sentinelRef} className="py-3 text-center text-[11px] text-text-tertiary">
                {loadingMore ? "이전 메시지 불러오는 중..." : ""}
              </div>
            ) : (
              <div className="py-3 text-center text-[11px] text-text-tertiary">처음 메시지입니다</div>
            )}
          </div>
        )}
      </div>

      <ReportSheet isOpen={showReport} onClose={() => setShowReport(false)} targetType="chat" targetId={reportTargetId ?? 0} />
    </div>
  );
}
