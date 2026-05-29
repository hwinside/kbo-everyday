"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Send, X, MoreHorizontal, Check, Heart, CornerDownRight, ImagePlay } from "lucide-react";
import { getAvatarPath } from "@/lib/constants/avatars";
import { createComment, updateComment, deleteComment, toggleCommentLike } from "@/lib/supabase/usePosts";
import { useAuth } from "@/lib/supabase/AuthContext";
import LoginSheet from "@/components/auth/LoginSheet";
import { supabase } from "@/lib/supabase/client";
import type { Comment } from "@/lib/supabase/usePosts";
import { getTeamById, getTeamBgColor } from "@/lib/constants/teams";
import GifPicker, { isGifComment } from "@/components/community/GifPicker";

interface CommentSheetProps {
  isOpen: boolean;
  onClose: () => void;
  postId: number | null;
  /** 팀 컬러 적용용 */
  teamId?: number | null;
  /** 댓글 작성 성공 시 부모에게 알림 (comment_count 동기화용) */
  onCommentAdded?: (postId: number) => void;
  /** 댓글 삭제 성공 시 부모에게 알림 (comment_count 동기화용) */
  onCommentDeleted?: (postId: number) => void;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "방금";
  if (mins < 60) return `${mins}분 전`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}일 전`;
  return new Date(dateStr).toLocaleDateString("ko-KR");
}

/** flat 댓글 배열 → 트리 구조 (2depth 제한) */
function buildCommentTree(comments: Comment[]): Comment[] {
  const roots: Comment[] = [];
  const childMap = new Map<number, Comment[]>();

  for (const c of comments) {
    if (!c.parent_id) {
      roots.push({ ...c, replies: [] });
    } else {
      const arr = childMap.get(c.parent_id) || [];
      arr.push(c);
      childMap.set(c.parent_id, arr);
    }
  }

  for (const root of roots) {
    root.replies = childMap.get(root.id) || [];
  }

  return roots;
}

export default function CommentSheet({ isOpen, onClose, postId, teamId, onCommentAdded, onCommentDeleted }: CommentSheetProps) {
  const [input, setInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [comments, setComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(true);
  const [showLogin, setShowLogin] = useState(false);
  const [menuOpenId, setMenuOpenId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editInput, setEditInput] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [replyTo, setReplyTo] = useState<{ id: number; nickname: string } | null>(null);
  const [showGifPicker, setShowGifPicker] = useState(false);
  const [cooldown, setCooldown] = useState(false);
  const [cooldownReason, setCooldownReason] = useState("");
  const lastSentRef = useRef(0);
  const sentTimestampsRef = useRef<number[]>([]);
  const recentContentsRef = useRef<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dragStartX = useRef(0);
  const dragStartY = useRef(0);
  const dragShouldClose = useRef(false);
  const [viewportHeight, setViewportHeight] = useState<number | null>(null);
  const [vvTop, setVvTop] = useState(0);
  const [keyboardInset, setKeyboardInset] = useState(0);
  // 인스타 2단계: (b) 아이콘 클릭 → 부분 높이 오픈, (c) 입력창 포커스 → 화면 상단까지 확장.
  // 확장은 sticky (한 번 입력 시작하면 닫을 때까지 유지) — 인스타 동일.
  const [expanded, setExpanded] = useState(false);
  const { user, profile } = useAuth();
  const shouldRender = isOpen && postId !== null;

  // Fetch comments + liked_by_me
  useEffect(() => {
    if (!postId) return;
    setLoading(true);
    setComments([]);

    (async () => {
      const { data } = await supabase
        .from("comments")
        .select("*, profiles!comments_author_id_fkey(nickname, team_id, grade, avatar_url)")
        .eq("post_id", postId)
        .order("created_at", { ascending: true });

      let myLikedIds: Set<number> = new Set();
      if (user && data?.length) {
        const { data: cls } = await supabase
          .from("comment_likes")
          .select("comment_id")
          .eq("user_id", user.id)
          .in("comment_id", data.map((cm) => cm.id));
        if (cls) myLikedIds = new Set(cls.map((cl: { comment_id: number }) => cl.comment_id));
      }

      if (data) {
        setComments(
          data.map((cm: Comment & { profiles?: { nickname?: string; team_id?: number; grade?: string; avatar_url?: string } }) => ({
            ...cm,
            nickname: cm.profiles?.nickname,
            team_id: cm.profiles?.team_id,
            grade: cm.profiles?.grade,
            avatar_url: cm.profiles?.avatar_url,
            liked_by_me: myLikedIds.has(cm.id),
          }))
        );
      }
      setLoading(false);
    })();
  }, [postId, user]);

  // Lock body scroll when sheet is open
  useEffect(() => {
    if (shouldRender) {
      const scrollY = window.scrollY;
      document.body.style.position = "fixed";
      document.body.style.top = `-${scrollY}px`;
      document.body.style.left = "0";
      document.body.style.right = "0";
      document.body.style.overflow = "hidden";

      return () => {
        document.body.style.position = "";
        document.body.style.top = "";
        document.body.style.left = "";
        document.body.style.right = "";
        document.body.style.overflow = "";
        window.scrollTo(0, scrollY);
      };
    }
  }, [shouldRender]);

  // Reset input + replyTo + 확장 상태 when sheet closes
  useEffect(() => {
    if (!shouldRender) {
      setInput("");
      setReplyTo(null);
      setShowGifPicker(false);
      setExpanded(false);
    }
  }, [shouldRender]);

  // 키보드가 떠 있으면(=입력 중) 무조건 확장 상태 유지.
  // 포커스 onFocus만으로는 키보드 settle 전 시트가 짧게 보일 수 있어 키보드 inset도 트리거로.
  useEffect(() => {
    if (keyboardInset > 0 && !expanded) setExpanded(true);
  }, [keyboardInset, expanded]);

  // Track visualViewport for iOS keyboard-aware sheet height.
  // Important: do not drive the sheet with `bottom: keyboardInset`.
  // iOS Safari/WebView can leave a stale keyboard inset after focus/blur, which
  // compresses the sheet and exposes the photo feed behind the comment UI.
  // Instead, pin the sheet to the visual viewport with explicit top + height.
  useEffect(() => {
    if (!shouldRender) return;

    if (typeof window === "undefined" || !window.visualViewport) {
      setViewportHeight(window.innerHeight);
      setVvTop(0);
      setKeyboardInset(0);
      return;
    }

    const vv = window.visualViewport;
    let layoutHeight = Math.max(window.innerHeight, vv.height + Math.max(0, vv.offsetTop));
    const timers: number[] = [];

    const update = () => {
      const offsetTop = Math.max(0, vv.offsetTop);
      layoutHeight = Math.max(layoutHeight, window.innerHeight, vv.height + offsetTop);

      setViewportHeight(vv.height);
      setVvTop(offsetTop);
      setKeyboardInset(Math.max(0, layoutHeight - offsetTop - vv.height));
    };

    const scheduleUpdate = () => {
      update();
      [80, 180, 360].forEach((delay) => {
        timers.push(window.setTimeout(update, delay));
      });
    };

    scheduleUpdate();
    vv.addEventListener("resize", scheduleUpdate);
    vv.addEventListener("scroll", scheduleUpdate);
    window.addEventListener("orientationchange", scheduleUpdate);

    return () => {
      vv.removeEventListener("resize", scheduleUpdate);
      vv.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("orientationchange", scheduleUpdate);
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [shouldRender]);

  useEffect(() => {
    if (!shouldRender) return;
    const el = listRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (!nearBottom) return;
    const id = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(id);
  }, [shouldRender, viewportHeight, comments.length]);

  // 댓글 목록 DB 재조회
  const refetchComments = useCallback(async (pid: number) => {
    const { data } = await supabase
      .from("comments")
      .select("*, profiles!comments_author_id_fkey(nickname, team_id, grade, avatar_url)")
      .eq("post_id", pid)
      .order("created_at", { ascending: true });

    let myLikedIds: Set<number> = new Set();
    if (user && data?.length) {
      const { data: cls } = await supabase
        .from("comment_likes")
        .select("comment_id")
        .eq("user_id", user.id)
        .in("comment_id", data.map((cm) => cm.id));
      if (cls) myLikedIds = new Set(cls.map((cl: { comment_id: number }) => cl.comment_id));
    }

    if (data) {
      setComments(
        data.map((cm: Comment & { profiles?: { nickname?: string; team_id?: number; grade?: string; avatar_url?: string } }) => ({
          ...cm,
          nickname: cm.profiles?.nickname,
          team_id: cm.profiles?.team_id,
          grade: cm.profiles?.grade,
          avatar_url: cm.profiles?.avatar_url,
          liked_by_me: myLikedIds.has(cm.id),
        }))
      );
    }
  }, [user]);

  const handleSubmit = useCallback(async () => {
    if (!input.trim() || !postId || submitting || cooldown) return;
    const trimmed = input.trim();
    const now = Date.now();

    // 10초 쿨다운
    const COOLDOWN_MS = 10_000;
    if (now - lastSentRef.current < COOLDOWN_MS) return;

    // 슬라이딩 윈도우: 60초 내 3건 초과 시 1분 뮤트
    const WINDOW_MS = 60_000;
    const MAX_IN_WINDOW = 3;
    const MUTE_MS = 60_000;
    sentTimestampsRef.current = sentTimestampsRef.current.filter((t) => now - t < WINDOW_MS);
    if (sentTimestampsRef.current.length >= MAX_IN_WINDOW) {
      setCooldown(true);
      setCooldownReason("잠시 후 다시 입력해 주세요");
      setTimeout(() => { setCooldown(false); setCooldownReason(""); }, MUTE_MS);
      return;
    }

    // 동일 댓글 차단: 최근 5건 내 같은 내용
    if (recentContentsRef.current.includes(trimmed)) {
      setCooldown(true);
      setCooldownReason("같은 댓글은 반복해서 달 수 없어요");
      setTimeout(() => { setCooldown(false); setCooldownReason(""); }, COOLDOWN_MS);
      return;
    }

    lastSentRef.current = now;
    sentTimestampsRef.current.push(now);
    recentContentsRef.current = [...recentContentsRef.current.slice(-4), trimmed];
    setCooldown(true);
    setCooldownReason("");
    setTimeout(() => setCooldown(false), COOLDOWN_MS);

    setSubmitting(true);
    try {
      const result = await createComment(postId, trimmed, replyTo?.id);
      // optimistic update with real DB id
      setComments((prev) => [
        ...prev,
        {
          id: result.id,
          post_id: postId,
          author_id: user?.id ?? "",
          content: trimmed,
          created_at: new Date().toISOString(),
          parent_id: replyTo?.id ?? null,
          like_count: 0,
          liked_by_me: false,
          nickname: profile?.nickname ?? user?.user_metadata?.name ?? "나",
          team_id: profile?.team_id,
          grade: profile?.grade,
          avatar_url: profile?.avatar_url ?? undefined,
        },
      ]);
      setInput("");
      setReplyTo(null);
      if (postId) onCommentAdded?.(postId);
      refetchComments(postId);
    } catch (err) {
      console.error("[CommentSheet] createComment failed:", err);
      alert("댓글 저장에 실패했어요");
    } finally {
      setSubmitting(false);
    }
  }, [input, postId, submitting, cooldown, user, onCommentAdded, profile, refetchComments, replyTo]);

  const handleGifSelect = useCallback(async (gifUrl: string) => {
    if (!postId || submitting || cooldown) return;
    if (!user) { setShowLogin(true); return; }

    const now = Date.now();
    const COOLDOWN_MS = 10_000;
    if (now - lastSentRef.current < COOLDOWN_MS) return;

    // 슬라이딩 윈도우: 60초 내 3건 초과 시 1분 뮤트
    const WINDOW_MS = 60_000;
    const MAX_IN_WINDOW = 3;
    const MUTE_MS = 60_000;
    sentTimestampsRef.current = sentTimestampsRef.current.filter((t) => now - t < WINDOW_MS);
    if (sentTimestampsRef.current.length >= MAX_IN_WINDOW) {
      setCooldown(true);
      setCooldownReason("잠시 후 다시 입력해 주세요");
      setTimeout(() => { setCooldown(false); setCooldownReason(""); }, MUTE_MS);
      return;
    }

    // GIF는 이미지가 달라도 동일 댓글로 간주
    const GIF_MARKER = "[GIF]";
    if (recentContentsRef.current.includes(GIF_MARKER)) {
      setCooldown(true);
      setCooldownReason("GIF는 연속으로 보낼 수 없어요");
      setTimeout(() => { setCooldown(false); setCooldownReason(""); }, COOLDOWN_MS);
      return;
    }

    lastSentRef.current = now;
    sentTimestampsRef.current.push(now);
    recentContentsRef.current = [...recentContentsRef.current.slice(-4), GIF_MARKER];
    setCooldown(true);
    setCooldownReason("");
    setTimeout(() => setCooldown(false), COOLDOWN_MS);

    setShowGifPicker(false);
    setSubmitting(true);
    try {
      const result = await createComment(postId, gifUrl, replyTo?.id);
      setComments((prev) => [
        ...prev,
        {
          id: result.id,
          post_id: postId,
          author_id: user.id,
          content: gifUrl,
          created_at: new Date().toISOString(),
          parent_id: replyTo?.id ?? null,
          like_count: 0,
          liked_by_me: false,
          nickname: profile?.nickname ?? user?.user_metadata?.name ?? "나",
          team_id: profile?.team_id,
          grade: profile?.grade,
          avatar_url: profile?.avatar_url ?? undefined,
        },
      ]);
      setReplyTo(null);
      if (postId) onCommentAdded?.(postId);
      refetchComments(postId);
    } catch (err) {
      console.error("[CommentSheet] GIF comment failed:", err);
      alert("GIF 전송에 실패했어요");
    } finally {
      setSubmitting(false);
    }
  }, [postId, submitting, user, onCommentAdded, profile, refetchComments, replyTo]);

  const startEdit = useCallback((comment: Comment) => {
    setMenuOpenId(null);
    setEditingId(comment.id);
    setEditInput(comment.content);
    setTimeout(() => editInputRef.current?.focus(), 50);
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setEditInput("");
  }, []);

  const saveEdit = useCallback(async () => {
    if (editingId === null || savingEdit) return;
    const trimmed = editInput.trim();
    if (!trimmed) return;

    setSavingEdit(true);
    try {
      await updateComment(editingId, trimmed);
      setComments((prev) =>
        prev.map((c) =>
          c.id === editingId
            ? { ...c, content: trimmed, updated_at: new Date().toISOString() }
            : c
        )
      );
      setEditingId(null);
      setEditInput("");
      if (postId) refetchComments(postId);
    } catch {
      alert("댓글 수정에 실패했어요");
    } finally {
      setSavingEdit(false);
    }
  }, [editingId, editInput, savingEdit, postId, refetchComments]);

  const handleDelete = useCallback(async (commentId: number) => {
    setMenuOpenId(null);
    if (!confirm("이 댓글을 삭제할까요?")) return;

    try {
      await deleteComment(commentId);
      setComments((prev) => prev.filter((c) => c.id !== commentId && c.parent_id !== commentId));
      if (postId) onCommentDeleted?.(postId);
    } catch {
      alert("댓글 삭제에 실패했어요");
    }
  }, [postId, onCommentDeleted]);

  const handleLike = useCallback(async (commentId: number) => {
    if (!user) { setShowLogin(true); return; }
    // optimistic
    setComments((prev) =>
      prev.map((c) =>
        c.id === commentId
          ? { ...c, liked_by_me: !c.liked_by_me, like_count: (c.like_count ?? 0) + (c.liked_by_me ? -1 : 1) }
          : c
      )
    );
    try {
      await toggleCommentLike(commentId);
    } catch {
      // revert on error
      setComments((prev) =>
        prev.map((c) =>
          c.id === commentId
            ? { ...c, liked_by_me: !c.liked_by_me, like_count: (c.like_count ?? 0) + (c.liked_by_me ? -1 : 1) }
            : c
        )
      );
    }
  }, [user]);

  const handleReply = useCallback((comment: Comment) => {
    setReplyTo({ id: comment.parent_id ? comment.parent_id : comment.id, nickname: comment.nickname || "익명" });
    setTimeout(() => inputRef.current?.focus(), 50);
  }, []);

  const cancelReply = useCallback(() => {
    setReplyTo(null);
  }, []);

  // 외부 클릭 시 메뉴 닫기
  useEffect(() => {
    if (menuOpenId === null) return;
    const handler = () => setMenuOpenId(null);
    const t = setTimeout(() => document.addEventListener("click", handler), 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener("click", handler);
    };
  }, [menuOpenId]);

  const handleSheetTouchStart = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length !== 1) return;
    dragStartX.current = e.touches[0].clientX;
    dragStartY.current = e.touches[0].clientY;
    dragShouldClose.current = false;
  }, []);

  const handleSheetTouchMove = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length !== 1) return;

    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.closest("input, textarea")) return;

    const deltaX = Math.abs(e.touches[0].clientX - dragStartX.current);
    const deltaY = e.touches[0].clientY - dragStartY.current;
    if (deltaY < 18 || deltaY < deltaX * 1.2) return;

    const scrollEl = target.closest("[data-comment-scroll='true']") as HTMLElement | null;
    if (scrollEl && scrollEl.scrollTop > 2) return;

    dragShouldClose.current = true;
    if (e.cancelable) e.preventDefault();
  }, []);

  const handleSheetTouchEnd = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    const touch = e.changedTouches[0];
    if (!touch) return;

    const deltaX = Math.abs(touch.clientX - dragStartX.current);
    const deltaY = touch.clientY - dragStartY.current;
    const shouldClose = dragShouldClose.current && deltaY > 80 && deltaY > deltaX * 1.2;
    dragShouldClose.current = false;

    if (shouldClose) onClose();
  }, [onClose]);

  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  if (!mounted) return null;

  const commentTree = buildCommentTree(comments);

  const renderComment = (comment: Comment, isReply = false) => {
    const avatarPath = getAvatarPath((comment as Comment & { avatar_url?: string }).avatar_url ?? null);
    const commentTeam = comment.team_id ? getTeamById(comment.team_id) : undefined;
    const isMine = !!user && comment.author_id === user.id;
    const isEditing = editingId === comment.id;
    const isEdited = !!comment.updated_at;
    const likeCount = comment.like_count ?? 0;

    return (
      <div key={comment.id} className={`flex gap-2 ${isReply ? "pl-10" : ""}`}>
        {avatarPath ? (
          <div className={`${isReply ? "w-6 h-6" : "w-8 h-8"} rounded-full overflow-hidden flex-shrink-0 bg-bg-tertiary`}>
            <img src={avatarPath} alt="" className="w-full h-full" />
          </div>
        ) : (
          <div
            className={`${isReply ? "w-6 h-6 text-[10px]" : "w-8 h-8 text-xs"} rounded-full flex items-center justify-center font-bold text-white flex-shrink-0`}
            style={{ backgroundColor: commentTeam ? getTeamBgColor(commentTeam) : '#6B7280' }}
          >
            {(comment.nickname || "익")[0]}
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className={`${isReply ? "text-xs" : "text-sm"} font-semibold text-text-primary`}>
              {comment.nickname || "익명"}
            </span>
            {commentTeam && (
              <span
                className="text-[10px] font-bold px-1.5 py-0.5 rounded-md text-white"
                style={{ backgroundColor: getTeamBgColor(commentTeam) }}
              >
                {commentTeam.shortName}
              </span>
            )}
            <span className="text-[11px] text-text-tertiary ml-auto flex-shrink-0">
              {timeAgo(comment.created_at)}{isEdited ? " · 수정됨" : ""}
            </span>
            {isMine && !isEditing && (
              <div className="relative flex-shrink-0">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuOpenId((prev) => (prev === comment.id ? null : comment.id));
                  }}
                  className="p-1 text-text-tertiary hover:text-text-primary transition-colors"
                  aria-label="댓글 메뉴"
                >
                  <MoreHorizontal size={14} />
                </button>
                {menuOpenId === comment.id && (
                  <div
                    className="absolute right-0 top-6 z-10 min-w-[96px] rounded-lg border border-border bg-bg-primary shadow-lg overflow-hidden"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      onClick={() => startEdit(comment)}
                      className="block w-full px-3 py-2 text-left text-xs text-text-primary hover:bg-bg-tertiary"
                    >
                      수정
                    </button>
                    <button
                      onClick={() => handleDelete(comment.id)}
                      className="block w-full px-3 py-2 text-left text-xs text-[#FF453A] hover:bg-bg-tertiary"
                    >
                      삭제
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
          {isEditing ? (
            <div className="mt-1 flex items-center gap-1.5">
              <input
                ref={editInputRef}
                type="text"
                value={editInput}
                onChange={(e) => setEditInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    saveEdit();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    cancelEdit();
                  }
                }}
                className="flex-1 bg-bg-tertiary rounded-lg px-3 py-1.5 text-sm text-text-primary outline-none border border-border"
              />
              <button
                onClick={saveEdit}
                disabled={!editInput.trim() || savingEdit}
                className="flex items-center justify-center w-7 h-7 rounded-full text-white disabled:opacity-50 transition-opacity"
                style={{ backgroundColor: teamId ? (() => { const t = getTeamById(teamId); return t ? getTeamBgColor(t) : '#FF453A'; })() : '#FF453A' }}
                aria-label="저장"
              >
                <Check size={14} />
              </button>
              <button
                onClick={cancelEdit}
                className="text-[11px] text-text-tertiary px-1"
              >
                취소
              </button>
            </div>
          ) : (
            <>
              {isGifComment(comment.content) ? (
                <img
                  src={comment.content.trim()}
                  alt="GIF"
                  className="mt-1 rounded-lg max-w-[200px] h-auto"
                  loading="lazy"
                />
              ) : (
                <p className="readable-body mt-0.5 break-words">
                  {comment.content}
                </p>
              )}
              <div className="flex items-center gap-3 mt-1">
                <button
                  onClick={() => handleLike(comment.id)}
                  className="flex items-center gap-1 text-text-tertiary hover:text-[#FF453A] transition-colors"
                >
                  <Heart size={12} className={comment.liked_by_me ? "fill-[#FF453A] text-[#FF453A]" : ""} />
                  {likeCount > 0 && <span className="text-[11px]">{likeCount}</span>}
                </button>
                {!isReply && (
                  <button
                    onClick={() => handleReply(comment)}
                    className="flex items-center gap-1 text-text-tertiary hover:text-text-primary transition-colors"
                  >
                    <CornerDownRight size={12} />
                    <span className="text-[11px]">답글</span>
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    );
  };

  return (<>
    {createPortal(
    <AnimatePresence>
      {shouldRender && (
        <>
          {/* Backdrop */}
          <motion.div
            className="fixed inset-0 bg-black/60"
            style={{ zIndex: 9998 }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
          />

          {/* Sheet */}
          <motion.div
            ref={sheetRef}
            className="fixed inset-x-0 flex flex-col bg-bg-secondary rounded-t-2xl overflow-hidden"
            style={{
              zIndex: 9999,
              ...(() => {
                // (b) 오픈 시 부분 높이(~62%), (c) 입력창 포커스 후 화면 상단까지 확장(~94%).
                const ratio = expanded ? 0.06 : 0.38;
                const topOffset = viewportHeight ? Math.max(24, viewportHeight * ratio) : null;
                return viewportHeight && topOffset !== null
                  ? {
                      top: `${vvTop + topOffset}px`,
                      height: `${Math.max(320, viewportHeight - topOffset)}px`,
                    }
                  : {
                      top: expanded ? "6vh" : "38vh",
                      height: expanded ? "94dvh" : "62dvh",
                    };
              })(),
              transition: "height 160ms ease-out, top 160ms ease-out",
            }}
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", damping: 28, stiffness: 300 }}
            onTouchStart={handleSheetTouchStart}
            onTouchMove={handleSheetTouchMove}
            onTouchEnd={handleSheetTouchEnd}
          >
            {/* Drag handle */}
            <div
              className="flex justify-center pt-3 pb-2 cursor-grab"
            >
              <div className="w-10 h-1 rounded-full bg-text-tertiary/40" />
            </div>

            {/* Header */}
            <div className="relative px-4 pb-3 border-b border-border">
              <h3 className="text-base font-semibold text-text-primary text-center">댓글</h3>
              <button
                onClick={onClose}
                className="absolute right-4 top-0 p-1 text-text-tertiary hover:text-text-primary transition-colors"
              >
                <X size={20} />
              </button>
            </div>

            {/* Comment list */}
            <div ref={listRef} data-comment-scroll="true" className="flex-1 overflow-y-auto overscroll-contain px-4 py-3 space-y-4">
              {loading ? (
                <div className="space-y-4">
                  {[...Array(4)].map((_, i) => (
                    <div key={i} className="flex gap-2.5 animate-pulse">
                      <div className="w-8 h-8 rounded-full bg-bg-tertiary flex-shrink-0" />
                      <div className="flex-1 space-y-1.5">
                        <div className="h-3 bg-bg-tertiary rounded w-20" />
                        <div className="h-3.5 bg-bg-tertiary rounded w-3/4" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : commentTree.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-text-tertiary">
                  <p className="text-base">첫 댓글을 남겨보세요 💬</p>
                </div>
              ) : (
                commentTree.map((comment) => (
                  <div key={comment.id}>
                    {renderComment(comment)}
                    {comment.replies && comment.replies.length > 0 && (
                      <div className="mt-3 space-y-3">
                        {comment.replies.map((reply) => renderComment(reply, true))}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>

            {/* Reply indicator */}
            {replyTo && (
              <div className="flex-none border-t border-border px-4 py-2 flex items-center gap-2 bg-bg-tertiary/50">
                <CornerDownRight size={12} className="text-text-tertiary" />
                <span className="text-xs text-text-secondary">{replyTo.nickname}에게 답글</span>
                <button onClick={cancelReply} className="ml-auto text-text-tertiary hover:text-text-primary">
                  <X size={14} />
                </button>
              </div>
            )}

            {/* Input area + GIF Picker overlay */}
            <div className="flex-none relative border-t border-border px-4 py-3" style={{ paddingBottom: keyboardInset > 0 ? "0.75rem" : "calc(0.75rem + env(safe-area-inset-bottom))" }}>
              {/* GIF Picker — pure overlay above input, no layout shift */}
              <AnimatePresence>
                {showGifPicker && (
                  <motion.div
                    className="absolute left-0 right-0 border-t border-border bg-bg-secondary z-10"
                    style={{ height: 280, bottom: "100%" }}
                    initial={{ y: "100%" }}
                    animate={{ y: 0 }}
                    exit={{ y: "100%" }}
                    transition={{ type: "spring", damping: 28, stiffness: 300 }}
                  >
                    <GifPicker
                      onSelect={handleGifSelect}
                      onClose={() => setShowGifPicker(false)}
                    />
                  </motion.div>
                )}
              </AnimatePresence>
              <div className="flex items-center gap-2">
                {user ? (
                  <>
                    <button
                      onClick={() => { setExpanded(true); setShowGifPicker((v) => !v); }}
                      className={`flex items-center justify-center w-9 h-9 rounded-full transition-colors ${showGifPicker ? "bg-accent/20 text-accent" : "text-text-tertiary hover:text-text-primary"}`}
                      aria-label="GIF"
                    >
                      <ImagePlay size={20} />
                    </button>
                    <input
                      ref={inputRef}
                      type="text"
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      onFocus={() => {
                        setShowGifPicker(false);
                        setExpanded(true);
                        const scrollToBottom = () => {
                          if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
                        };
                        requestAnimationFrame(scrollToBottom);
                        [120, 300, 600].forEach((ms) => setTimeout(scrollToBottom, ms));
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                          e.preventDefault();
                          handleSubmit();
                        }
                      }}
                      placeholder={cooldown ? (cooldownReason || "잠시 후 다시 입력하세요...") : replyTo ? `${replyTo.nickname}에게 답글...` : "댓글을 입력하세요"}
                      className="flex-1 bg-bg-tertiary rounded-full px-4 py-2.5 text-sm text-text-primary placeholder:text-text-secondary outline-none border"
                      style={{ borderColor: teamId ? `${getTeamById(teamId)?.colorPrimary}80` : 'rgba(255,255,255,0.15)' }}
                    />
                  </>
                ) : (
                  <button
                    onClick={() => setShowLogin(true)}
                    className="flex-1 bg-bg-tertiary rounded-full px-4 py-2.5 text-sm text-text-tertiary text-left"
                  >
                    로그인하고 댓글 달기
                  </button>
                )}
                <button
                  onClick={handleSubmit}
                  disabled={!input.trim() || submitting || cooldown || !user}
                  className="flex items-center justify-center w-9 h-9 rounded-full text-white disabled:opacity-50 transition-opacity"
                  style={{ backgroundColor: teamId ? (() => { const t = getTeamById(teamId); return t ? getTeamBgColor(t) : '#FF453A'; })() : '#FF453A' }}
                >
                  <Send size={16} />
                </button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>,
    document.body
  )}
  {showLogin && <LoginSheet isOpen={showLogin} onClose={() => setShowLogin(false)} />}
  </>);
}
