"use client";

import { useState, useRef, useEffect, useLayoutEffect, useCallback, type ChangeEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import { ChevronLeft, Send, EllipsisVertical, AlertTriangle, ShieldBan, Flag, X, ImagePlus, Loader2 } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useDMChat } from "@/lib/supabase/useDM";
import { useAuth } from "@/lib/supabase/AuthContext";
import { useBlockUser } from "@/lib/supabase/useBlock";
import { submitDMReport } from "@/lib/supabase/useBlock";
import { supabase } from "@/lib/supabase/client";
import { OPERATOR_USER_ID } from "@/lib/constants/operator";
import { NEWS_CLIPPER_IDS } from "@/lib/constants/news-clippers";
import { isNoReplySender, noReplyBannerLabel } from "@/lib/constants/no-reply-senders";
import TeamBadge from "@/components/ui/TeamBadge";
import { linkifyText } from "@/lib/linkify";
import NewsClippingCard from "@/components/dm/NewsClippingCard";
import GeniusTypingIndicator from "@/components/dm/GeniusTypingIndicator";
import { isNewsClippingPayload } from "@/types/news-clipping";
import {
  BASEBALL_GENIUS_NAME,
  BASEBALL_GENIUS_MAX_QUESTION_LENGTH,
  BASEBALL_GENIUS_MIN_QUESTION_LENGTH,
  BASEBALL_GENIUS_PINNED_ROOM_LEAVABLE,
  BASEBALL_GENIUS_USER_ID,
} from "@/lib/constants/baseball-genius";

const REPORT_CATEGORIES = [
  { id: "spam", label: "스팸" },
  { id: "abuse", label: "욕설/비방" },
  { id: "scam", label: "사기/피싱" },
  { id: "inappropriate", label: "불쾌한 내용" },
  { id: "other", label: "기타" },
] as const;

const MAX_DM_IMAGES = 3;
const SEND_ERROR = "현재 이 대화에서는 쪽지를 보낼 수 없어요.";

export default function DMChatPage() {
  const params = useParams();
  const router = useRouter();
  const conversationId = params.conversationId as string;
  const draftTargetId = conversationId.startsWith("new-") ? conversationId.slice(4) : null;
  const { user, loading: authLoading } = useAuth();
  const {
    messages,
    loading,
    sendMessage,
    geniusReplyStates,
    retryBaseballQa,
  } = useDMChat(draftTargetId ? "" : conversationId);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const [images, setImages] = useState<{ url: string; name: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastMsgRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 상대방 프로필 직접 fetch
  const [otherName, setOtherName] = useState("상대방");
  const [otherTeamId, setOtherTeamId] = useState<number | null>(null);
  const [otherId, setOtherId] = useState<string | null>(null);
  const [otherResolved, setOtherResolved] = useState(false);

  // 대화 전환(A→B) 즉시 헤더·composer 판정을 다시 pending 으로 되돌린다 —
  // A 상대 프로필이 잔존한 채 B 전송 closure 가 묶이는 오발송 창 차단.
  const [profileConversationId, setProfileConversationId] = useState(conversationId);
  if (profileConversationId !== conversationId) {
    setProfileConversationId(conversationId);
    setOtherName("상대방");
    setOtherTeamId(null);
    setOtherId(null);
    setOtherResolved(false);
    // composer 상태도 대화별로 격리 — A draft/전송중 표시가 B 로 이어지면 오발송·잠김 창이 생긴다.
    setInput("");
    setImages([]);
    setSending(false);
    setSendError("");
  }

  // late handleSend 결과 fence 용 대화 세대(epoch) — id 비교는 A→B→A(ABA) 복귀를 통과시켜
  // late 결과가 새 draft 를 지우므로, 전환/진입마다 단조 증가하는 세대 번호의 정확 일치로 판정한다
  // (렌더 중 ref 쓰기는 react-hooks/refs 위반이라 layout effect 로 commit 직후 동기 증가).
  const sendEpochRef = useRef(0);
  useLayoutEffect(() => {
    sendEpochRef.current += 1;
  }, [conversationId]);

  useEffect(() => {
    if (!user || !conversationId) return;
    // 전환 후 도착하는 이전 대화의 late 응답은 폐기(cleanup fence).
    let cancelled = false;

    async function fetchOther() {
      let oid = draftTargetId;
      if (!oid) {
        const { data: conv } = await supabase
          .from("dm_conversations")
          .select("user1_id, user2_id")
          .eq("id", conversationId)
          .maybeSingle();

        if (cancelled) return;
        if (!conv) {
          setOtherName("탈퇴한 사용자");
          setOtherTeamId(null);
          setOtherResolved(true);
          return;
        }
        oid = conv.user1_id === user!.id ? conv.user2_id : conv.user1_id;
      }
      setOtherId(oid);
      setOtherResolved(true);

      if (!oid) {
        setOtherName("탈퇴한 사용자");
        setOtherTeamId(null);
        return;
      }
      if (oid === BASEBALL_GENIUS_USER_ID) {
        setOtherName(BASEBALL_GENIUS_NAME);
        setOtherTeamId(null);
        return;
      }

      const { data: prof } = await supabase
        .from("profiles")
        .select("nickname, team_id")
        .eq("id", oid)
        .maybeSingle();

      if (cancelled) return;
      if (prof) {
        setOtherName(prof.nickname ?? "상대방");
        setOtherTeamId(prof.team_id);
      }
    }
    fetchOther();
    return () => { cancelled = true; };
  }, [user, conversationId, draftTargetId]);

  // Block hook
  const { block, isBlocked } = useBlockUser(otherId ?? "");

  // 사진 첨부는 운영팀과의 대화에서만 허용 (유저↔유저 DM은 범위 외).
  // 닉네임 위조 방지를 위해 운영팀 user_id로 판정.
  const isOperatorConv = otherId === OPERATOR_USER_ID;
  const isBaseballGeniusConv = otherId === BASEBALL_GENIUS_USER_ID;
  const showGeniusMascot = isBaseballGeniusConv;
  // 뉴스클리퍼 대화 — 자동 발송 전용, 답장 시 자동응답만 옴 (안내 배너 노출)
  const isClipperConv = otherId != null && NEWS_CLIPPER_IDS.has(otherId);
  // 회신 불가(자동 발송 전용) 계정 — 클리퍼 + 긴급공지. 입력창 비활성 + 안내 배너.
  const isNoReplyConv = isNoReplySender(otherId);

  // UI states
  const [showMenu, setShowMenu] = useState(false);
  const [showBlockConfirm, setShowBlockConfirm] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [reportCategory, setReportCategory] = useState("");
  const [reportDetail, setReportDetail] = useState("");
  const [reportSubmitting, setReportSubmitting] = useState(false);
  const [reportDone, setReportDone] = useState(false);

  useEffect(() => {
    // 클리퍼 대화방은 최신 클리핑 카드가 세로로 길어 하단 착지 시 다시 올려 봐야 함
    // → 최신 메시지의 '상단'(인트로/헤더)에 포커스 (하린아빠 제보 7/12)
    if (isClipperConv && lastMsgRef.current) {
      lastMsgRef.current.scrollIntoView({ block: "start" });
    } else {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages.length, isClipperConv]);

  // 입력창 내용 길이에 맞춰 세로 자동 확장 (최대 max-h-32 = 128px)
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
  }, [input]);

  const handleImageSelect = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (!isOperatorConv || files.length === 0 || images.length >= MAX_DM_IMAGES) return;

    setUploading(true);
    const remaining = MAX_DM_IMAGES - images.length;
    const next: { url: string; name: string }[] = [];
    // 클라 직접 업로드는 photos/dm/* Storage RLS에 막히므로 서버 route 경유(쿠키 인증 + service role).
    for (const file of files.slice(0, remaining)) {
      const formData = new FormData();
      formData.append("file", file);
      if (draftTargetId) formData.append("targetUserId", draftTargetId);
      else formData.append("conversationId", conversationId);
      try {
        const res = await fetch("/api/dm/upload", {
          method: "POST",
          credentials: "include",
          body: formData,
        });
        if (!res.ok) continue;
        const json = await res.json();
        if (typeof json.url === "string") next.push({ url: json.url, name: file.name });
      } catch {
        /* ignore */
      }
    }
    if (next.length > 0) {
      setImages((prev) => [...prev, ...next].slice(0, MAX_DM_IMAGES));
    }
    setUploading(false);
  };

  const removeImage = (index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSend = async () => {
    // 상대 미확정(프로필 로드 전/실패)·클리퍼 대화방은 전송 금지 — 초기 렌더 레이스에
    // 입력창이 잠깐 떠도 실제 전송은 막는다 (PR #622 삼순 가드)
    if (!otherId || isNoReplyConv) return;
    if (
      isBaseballGeniusConv &&
      (input.trim().length < BASEBALL_GENIUS_MIN_QUESTION_LENGTH ||
        input.trim().length > BASEBALL_GENIUS_MAX_QUESTION_LENGTH)
    ) {
      setSendError(
        `질문은 ${BASEBALL_GENIUS_MIN_QUESTION_LENGTH}~${BASEBALL_GENIUS_MAX_QUESTION_LENGTH}자로 입력해 주세요`,
      );
      return;
    }
    // 사진은 운영팀 대화에서만 전송 (유저↔유저는 텍스트만)
    const sendImages = isOperatorConv ? images : [];
    if ((!input.trim() && sendImages.length === 0) || sending || uploading) return;
    setSendError("");
    setSending(true);
    const sendEpoch = sendEpochRef.current;
    const result = await sendMessage(input.trim(), sendImages.map((img) => img.url), draftTargetId ?? undefined);
    // 전송 중 다른 대화로 전환(같은 대화로 복귀한 ABA 포함)되었으면 composer 상태를 건드리지 않는다
    // (전환 시점 render reset 이 composer 를 이미 초기화함 — late 결과는 세대 불일치로 폐기).
    if (sendEpochRef.current !== sendEpoch) return;
    if (result.ok && result.conversationId) {
      setInput("");
      setImages([]);
      if (draftTargetId) router.replace(`/messages/${result.conversationId}`);
    } else {
      setSendError(SEND_ERROR);
    }
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

  useEffect(() => {
    if (!authLoading && !user) router.replace("/messages");
  }, [authLoading, user, router]);

  if (authLoading || !user) return null;

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-bg-primary">
      {/* Header — 기본 디자인 가이드(마이/명전) 앱바 정렬. fixed 오버레이라 탭바/푸터를 덮어 이중 스크롤 제거 */}
      <header className="flex items-center gap-3 px-5 pt-safe pb-3 border-b border-border bg-bg-primary">
        <button
          onClick={() => router.back()}
          className="rounded-full p-1 text-text-secondary hover:bg-bg-tertiary transition-colors"
          aria-label="뒤로"
        >
          <ChevronLeft size={24} />
        </button>
        {/* 마스코트는 제목 줄 안이 아니라 2줄 텍스트블록 '옆'에 둔다.
            제목 줄(gap-1.5) 안에 넣으면 그 줄 자체가 커져 두 줄 간격까지 밀린다.
            형제로 빼면 헤더 높이는 max(뒤로 32, 슬롯 96, 텍스트 41) 로 예측 가능하다.
            96px 슬롯은 삼순 확정 규격(목록 64 / 대화방 96, 헤더 108~112px). */}
        {showGeniusMascot && (
          <img src="/mascot/yajalal-avatar.png" alt="야잘알봇"
               className="h-24 w-auto max-w-none object-contain flex-shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            {isBaseballGeniusConv ? (
              showGeniusMascot ? null : <span className="text-lg" aria-hidden>⚾</span>
            ) : otherName === "크보팬 운영팀" ? (
              <img src="/apple-touch-icon.png" alt="크보팬" className="w-5 h-5 rounded-full object-cover" />
            ) : otherTeamId ? (
              <TeamBadge teamId={otherTeamId} size="xs" />
            ) : null}
            <h1 className="text-lg font-semibold leading-[26px] text-text-primary truncate">{otherName}</h1>
          </div>
          <p className="text-[10px] text-text-tertiary">
            {!otherId && otherResolved
              ? "읽기 전용"
              : isBaseballGeniusConv
                ? "야구 밖에 모르는 바보 AI봇"
              : isNoReplyConv
                ? "자동 발송 전용"
                : "1:1 쪽지"}
          </p>
        </div>
        <div className={otherId && (BASEBALL_GENIUS_PINNED_ROOM_LEAVABLE || !isBaseballGeniusConv) ? "relative" : "hidden"}>
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
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {/* Safety Banner — 클리퍼 대화는 자동 발송 전용 안내로 대체 */}
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-yellow-500/10 text-yellow-500 text-xs">
          <AlertTriangle size={14} className="flex-shrink-0" />
          <span>
            {isBaseballGeniusConv
              ? "야구와 관련된 질문에만 답해요. 그리고 야잘알봇도 실수를 하거나 잘못된 정보를 제공하는 경우가 있어요."
              : isNoReplyConv
              ? noReplyBannerLabel(otherId)
              : "쪽지는 개인 간 대화입니다. 금전 거래 시 사기에 주의하세요."}
          </span>
        </div>

        {loading ? (
          <div className="text-center text-sm text-text-tertiary py-10">불러오는 중...</div>
        ) : messages.length === 0 ? (
          <div className="text-center text-sm text-text-tertiary py-10">
            첫 쪽지를 보내보세요!
          </div>
        ) : (
          messages.map((msg, i) => {
            const isMe = msg.sender_id === user?.id;
            // 클리핑 카드는 클리퍼/운영팀 발신만 신뢰 — 일반 유저가 payload를 흉내내도 텍스트로 렌더 (PR #619 리뷰 blocker 2)
            const trustedSender =
              msg.sender_id !== null &&
              (NEWS_CLIPPER_IDS.has(msg.sender_id) || msg.sender_id === OPERATOR_USER_ID);
            const clipping = trustedSender && isNewsClippingPayload(msg.payload) ? msg.payload : null;
            return (
              <motion.div
                key={msg.id}
                ref={i === messages.length - 1 ? lastMsgRef : undefined}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                className={`flex ${isMe ? "justify-end" : "justify-start"}`}
              >
                <div className={`${clipping ? "max-w-[88%] min-w-[70%]" : "max-w-[75%]"} ${isMe ? "order-2" : ""}`}>
                  {!isMe && (
                    <div className="flex items-center gap-1.5 mb-1">
                      {msg.sender_team_id && <TeamBadge teamId={msg.sender_team_id} size="xs" />}
                      <span className="text-xs font-semibold text-text-secondary">{msg.sender_nickname}</span>
                    </div>
                  )}
                  {clipping ? (
                    <NewsClippingCard payload={clipping} />
                  ) : (
                  <div
                    className={`px-3.5 py-2.5 rounded-2xl text-sm leading-relaxed ${
                      isMe
                        ? "bg-accent text-white rounded-br-md"
                        : "bg-bg-tertiary text-text-primary rounded-bl-md"
                    }`}
                  >
                    {msg.content ? (
                      <p className="whitespace-pre-wrap break-words">{linkifyText(msg.content)}</p>
                    ) : null}
                    {Array.isArray(msg.image_urls) && msg.image_urls.length > 0 && (
                      <div className={`grid gap-2 ${msg.content ? "mt-2" : ""}`}>
                        {msg.image_urls.map((url, i) => (
                          <a
                            key={`${msg.id}-${url}`}
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="block overflow-hidden rounded-xl bg-black/10"
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element -- DM 첨부는 임의의 Supabase 공개 URL */}
                            <img
                              src={url}
                              alt={`첨부 이미지 ${i + 1}`}
                              className="max-h-64 w-full object-cover"
                            />
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                  )}
                  <div className={`text-[10px] text-text-tertiary mt-1 ${isMe ? "text-right" : ""}`}>
                    {new Date(msg.created_at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}
                    {isMe && msg.is_read && " ✓"}
                  </div>
                </div>
              </motion.div>
            );
          })
        )}
        {isBaseballGeniusConv && (
          Object.entries(geniusReplyStates).map(([messageId, state]) => (
            <GeniusTypingIndicator
              key={messageId}
              state={state}
              onRetry={() => retryBaseballQa(Number(messageId))}
            />
          ))
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input — 회신 불가 계정(클리퍼/긴급공지)은 입력창 비활성화 (자동 발송 전용, 하린아빠 확정).
          상대 확정 전에는 composer 미렌더 — 회신불가 판정 전 일반 입력창이 잠깐 뜨는 레이스 차단 */}
      {!otherResolved ? null : !otherId ? (
        <div className="px-5 py-3 border-t border-border bg-bg-secondary pb-safe text-center text-sm text-text-tertiary">
          탈퇴한 사용자와의 대화는 읽기만 가능합니다.
        </div>
      ) : isNoReplyConv ? (
        <div className="px-5 py-3 border-t border-border bg-bg-secondary pb-safe text-center text-sm text-text-tertiary">
          {noReplyBannerLabel(otherId)}
        </div>
      ) : isBlocked ? (
        <div className="px-5 py-3 border-t border-border bg-bg-secondary pb-safe text-center text-sm text-text-tertiary">
          차단된 사용자에게 쪽지를 보낼 수 없습니다.
        </div>
      ) : (
        <div className="px-5 py-3 border-t border-border bg-bg-secondary pb-safe">
          {sendError && (
            <p role="alert" className="mb-2 text-center text-xs text-red-500">{sendError}</p>
          )}
          {isOperatorConv && images.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2">
              {images.map((image, index) => (
                <div key={image.url} className="relative h-16 w-16 overflow-hidden rounded-lg bg-bg-tertiary">
                  {/* eslint-disable-next-line @next/next/no-img-element -- 첨부 미리보기는 업로드된 Supabase URL */}
                  <img src={image.url} alt={image.name} className="h-full w-full object-cover" />
                  <button
                    type="button"
                    onClick={() => removeImage(index)}
                    className="absolute right-1 top-1 rounded-full bg-black/70 p-1 text-white"
                    aria-label="첨부 이미지 제거"
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-end gap-2">
            {isOperatorConv && (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={handleImageSelect}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={images.length >= MAX_DM_IMAGES || uploading || sending}
                  className="w-10 h-10 rounded-full bg-bg-tertiary flex items-center justify-center disabled:opacity-30 transition-opacity flex-shrink-0"
                  aria-label="사진 첨부"
                  title="사진 첨부"
                >
                  {uploading ? (
                    <Loader2 size={18} className="text-text-secondary animate-spin" />
                  ) : (
                    <ImagePlus size={18} className="text-text-secondary" />
                  )}
                </button>
              </>
            )}
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => { setInput(e.target.value); setSendError(""); }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder="쪽지를 입력하세요..."
              maxLength={isBaseballGeniusConv ? BASEBALL_GENIUS_MAX_QUESTION_LENGTH : undefined}
              rows={1}
              className="flex-1 px-4 py-2.5 rounded-2xl bg-bg-tertiary text-sm text-text-primary placeholder:text-text-tertiary outline-none resize-none max-h-32 overflow-y-auto"
            />
            <button
              onClick={handleSend}
              disabled={(!input.trim() && images.length === 0) || sending || uploading}
              aria-label="쪽지 보내기"
              className="w-10 h-10 rounded-full bg-accent flex items-center justify-center disabled:opacity-30 transition-opacity flex-shrink-0"
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
