"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Send, X, MoreHorizontal, Check, Heart, CornerDownRight, ImagePlay, ImagePlus, Loader2, Flag } from "lucide-react";
import { createComment, updateComment, deleteComment, toggleCommentLike, uploadCommentImage } from "@/lib/supabase/usePosts";
import { useAuth } from "@/lib/supabase/AuthContext";
import LoginSheet from "@/components/auth/LoginSheet";
import { supabase } from "@/lib/supabase/client";
import type { Comment } from "@/lib/supabase/usePosts";
import { getTeamById, getTeamBgColor } from "@/lib/constants/teams";
import GifPicker from "@/components/community/GifPicker";
import CommentImageLightbox from "@/components/community/CommentImageLightbox";
import { isImageComment, prepareCommentImageForUpload } from "@/lib/community/comment-media";
import { normalizeForFloodKey } from "@/lib/utils/normalize-message";
import ReportSheet from "@/components/community/ReportSheet";
import CommunityAuthorHeader from "@/components/community/CommunityAuthorHeader";

interface CommentSheetProps {
  isOpen: boolean;
  onClose: () => void;
  postId: number | null;
  /** 팀 컬러 적용용 */
  teamId?: number | null;
  /** 댓글 작성 성공 시 부모에게 알림 (comment_count 동기화용) */
  onCommentAdded?: (postId: number) => void;
  /** 댓글 삭제 성공 시 부모에게 알림 (comment_count 동기화용) */
  onCommentDeleted?: (postId: number, removedCount?: number) => void;
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
  // 방어적 dedup: 같은 id가 두 번 들어오면(낙관적 append ↔ 재조회 레이스 등) 댓글이 2번 보일 수 있다.
  // 트리 빌더는 dup id에 멱등이어야 한다 — 중복 없으면 no-op.
  const seenIds = new Set<number>();
  const unique = comments.filter((c) => {
    if (seenIds.has(c.id)) return false;
    seenIds.add(c.id);
    return true;
  });

  const roots: Comment[] = [];
  const childMap = new Map<number, Comment[]>();

  for (const c of unique) {
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
  const [uploadingImage, setUploadingImage] = useState(false);
  const [cooldown, setCooldown] = useState(false);
  const [cooldownReason, setCooldownReason] = useState("");
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [reportCommentId, setReportCommentId] = useState<number | null>(null);
  const lastSentRef = useRef(0);
  const sentTimestampsRef = useRef<number[]>([]);
  const recentContentsRef = useRef<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dragStartX = useRef(0);
  const dragStartY = useRef(0);
  const dragShouldClose = useRef(false);
  const blurCollapseTimer = useRef<number | null>(null);
  // 인스타 2단계: (b) 아이콘 클릭 → 부분 높이 오픈, (c) 입력창 포커스 → 화면 상단까지 확장.
  // 확장은 sticky (한 번 입력 시작하면 닫을 때까지 유지) — 인스타 동일.
  const [expanded, setExpanded] = useState(false);
  // 닫힘 애니메이션: 부모가 CommentSheet를 조건부 마운트(commentPostId!==null)하므로 onClose를
  // 곧장 호출하면 컴포넌트(=AnimatePresence 포함)가 즉시 언마운트돼 exit 스프링이 재생되지 않고
  // "뚝 사라진다". → 스와이프/X/백드롭 모두 일단 closing=true로 시트를 아래로 애니메이션 시키고,
  // 애니메이션이 끝난 뒤(onAnimationComplete)에야 부모 onClose를 호출한다(올라온 속도와 대칭).
  const [closing, setClosing] = useState(false);
  // 키보드 회피용 visualViewport 수치(React state). imperative style 충돌 방지를 위해 단일 style에서만 사용.
  const [kbInset, setKbInset] = useState(0);
  const [vvHeight, setVvHeight] = useState<number | null>(null);
  const { user, profile } = useAuth();
  const canModerateComments = profile?.is_operator === true;
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
        .neq("is_hidden", true)
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

  // (b)/(c) 높이는 오직 "사용자 의도"로만 결정한다.
  //  - 열 때: 항상 (b)부분높이부터 (직전 세션의 (c)확장 상태가 남지 않도록 매 오픈마다 강제 리셋)
  //  - 입력창 onFocus / GIF 버튼 탭: (c)최상단 확장 (아래 input onFocus에서 setExpanded(true))
  //  - 닫을 때: 전체 리셋
  // ⚠️ 과거엔 keyboardInset(>=임계값)으로 키보드를 추론해 (c)확장을 트리거했는데, iOS Safari/인앱브라우저는
  //    주소창·툴바 때문에 키보드 없이도 phantom inset이 생기고 그 크기가 기기/브라우저마다 달라(임계값 가드가
  //    통하지 않음) "열자마자 맨 위 고정"이 됐다. viewport 수치 추론을 버리고 명시적 focus로만 확장한다.
  useEffect(() => {
    if (shouldRender) {
      setExpanded(false);
    } else {
      setInput("");
      setReplyTo(null);
      setShowGifPicker(false);
      setExpanded(false);
      if (blurCollapseTimer.current) {
        clearTimeout(blurCollapseTimer.current);
        blurCollapseTimer.current = null;
      }
    }
  }, [shouldRender]);

  // 키보드 회피 — visualViewport 수치를 React state로 끌어와 단일 style에서 적용한다.
  // iOS Safari/WKWebView는 interactive-widget=resizes-content를 *미지원* → 키보드가 떠도
  // 레이아웃 뷰포트(innerHeight/dvh)는 그대로다. 그 상태의 position:fixed; bottom:0 시트는
  // 키보드 높이만큼 화면 밖(위)으로 밀려 댓글 목록이 사라진다(입력창만 키보드 위에 남음).
  // → 시각 뷰포트(키보드 제외 영역)에 맞춰 (1) 시트 바닥을 키보드 위로 올리고(bottom=kbInset)
  //   (2) 확장 높이를 시각 뷰포트로 잡는다(height=vvHeight). 목록(flex-1 min-h-0)이 줄어
  //   컴포저는 키보드 바로 위, 목록은 그 위에 함께 보인다.
  // ⚠️ 과거 b22f72cd는 동일 계산을 imperative(sheet.style.x)로 박았는데 React 리렌더가 인라인
  //   style을 덮어써 무효화됐다 → 이번엔 state→단일 style로 적용해 충돌 자체를 제거한다.
  // resizes-content 지원 브라우저(Android)는 innerHeight도 축소 → kbInset≈0, vvHeight=축소분으로
  //   동일하게 안전 동작한다.
  useEffect(() => {
    if (!shouldRender) return;
    const vv = window.visualViewport;
    if (!vv) return;
    const apply = () => {
      setKbInset(Math.max(0, window.innerHeight - vv.height - vv.offsetTop));
      setVvHeight(vv.height);
    };
    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    return () => {
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
      setKbInset(0);
      setVvHeight(null);
    };
  }, [shouldRender]);

  // 시트가 (b)/(c)로 높이가 바뀐 직후, 목록이 바닥 근처면 자동으로 맨 아래로(최신 댓글) 스냅.
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
  }, [shouldRender, expanded, comments.length]);

  // 댓글 목록 DB 재조회
  const refetchComments = useCallback(async (pid: number) => {
    const { data } = await supabase
      .from("comments")
      .select("*, profiles!comments_author_id_fkey(nickname, team_id, grade, avatar_url)")
      .eq("post_id", pid)
      .neq("is_hidden", true)
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
    if (!input.trim() || !postId || submitting || uploadingImage || cooldown) return;
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

    // 동일/변형 도배 차단: 정규화 키 기준 최근 5건 내 같은 내용
    const floodKey = normalizeForFloodKey(trimmed);
    if (recentContentsRef.current.includes(floodKey)) {
      setCooldown(true);
      setCooldownReason("같은 댓글은 반복해서 달 수 없어요");
      setTimeout(() => { setCooldown(false); setCooldownReason(""); }, COOLDOWN_MS);
      return;
    }

    lastSentRef.current = now;
    sentTimestampsRef.current.push(now);
    recentContentsRef.current = [...recentContentsRef.current.slice(-4), floodKey];
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
  }, [input, postId, submitting, uploadingImage, cooldown, user, onCommentAdded, profile, refetchComments, replyTo]);

  // GIF·이미지 공용 도배 방지 가드. 통과 시 true(쿨다운 마커 소비), 차단 시 false.
  const startMediaCooldown = useCallback((marker: string, repeatReason: string) => {
    const now = Date.now();
    const COOLDOWN_MS = 10_000;
    if (now - lastSentRef.current < COOLDOWN_MS) return false;

    // 슬라이딩 윈도우: 60초 내 3건 초과 시 1분 뮤트
    const WINDOW_MS = 60_000;
    const MAX_IN_WINDOW = 3;
    const MUTE_MS = 60_000;
    sentTimestampsRef.current = sentTimestampsRef.current.filter((t) => now - t < WINDOW_MS);
    if (sentTimestampsRef.current.length >= MAX_IN_WINDOW) {
      setCooldown(true);
      setCooldownReason("잠시 후 다시 입력해 주세요");
      setTimeout(() => { setCooldown(false); setCooldownReason(""); }, MUTE_MS);
      return false;
    }

    if (recentContentsRef.current.includes(marker)) {
      setCooldown(true);
      setCooldownReason(repeatReason);
      setTimeout(() => { setCooldown(false); setCooldownReason(""); }, COOLDOWN_MS);
      return false;
    }

    lastSentRef.current = now;
    sentTimestampsRef.current.push(now);
    recentContentsRef.current = [...recentContentsRef.current.slice(-4), marker];
    setCooldown(true);
    setCooldownReason("");
    setTimeout(() => setCooldown(false), COOLDOWN_MS);
    return true;
  }, []);

  const handleGifSelect = useCallback(async (gifUrl: string) => {
    if (!postId || submitting || uploadingImage || cooldown) return;
    if (!user) { setShowLogin(true); return; }

    if (!startMediaCooldown("[GIF]", "GIF는 연속으로 보낼 수 없어요")) return;

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
  }, [postId, submitting, uploadingImage, cooldown, user, onCommentAdded, profile, refetchComments, replyTo, startMediaCooldown]);

  const openImagePicker = useCallback(() => {
    if (!user) { setShowLogin(true); return; }
    if (submitting || uploadingImage || cooldown) return;
    setShowGifPicker(false);
    fileInputRef.current?.click();
  }, [user, submitting, uploadingImage, cooldown]);

  const handleImageSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !postId || submitting || uploadingImage || cooldown) return;
    if (!user) { setShowLogin(true); return; }

    setShowGifPicker(false);
    setUploadingImage(true);
    try {
      const prepared = await prepareCommentImageForUpload(file);
      if (!startMediaCooldown("[IMAGE]", "이미지는 연속으로 올릴 수 없어요")) return;
      const imageUrl = await uploadCommentImage(prepared);
      const result = await createComment(postId, imageUrl, replyTo?.id);
      setComments((prev) => [
        ...prev,
        {
          id: result.id,
          post_id: postId,
          author_id: user.id,
          content: imageUrl,
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
      console.error("[CommentSheet] image comment failed:", err);
      alert(err instanceof Error ? err.message : "이미지 업로드에 실패했어요");
    } finally {
      setUploadingImage(false);
    }
  }, [postId, submitting, uploadingImage, cooldown, user, onCommentAdded, profile, refetchComments, replyTo, startMediaCooldown]);

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
      await deleteComment(commentId, { canDeleteAny: canModerateComments });
      const removedCount = comments.filter((c) => c.id === commentId || c.parent_id === commentId).length;
      setComments((prev) => prev.filter((c) => c.id !== commentId && c.parent_id !== commentId));
      if (postId) onCommentDeleted?.(postId, Math.max(1, removedCount));
    } catch {
      alert("댓글 삭제에 실패했어요");
    }
  }, [postId, onCommentDeleted, canModerateComments, comments]);

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

  // 닫기 요청 — 즉시 onClose 하지 않고 아래로 미끄러지는 애니메이션을 먼저 재생한다.
  const requestClose = useCallback(() => {
    setClosing(true);
  }, []);

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

    if (shouldClose) requestClose();
  }, [requestClose]);

  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  if (!mounted) return null;

  const commentTree = buildCommentTree(comments);

  const renderComment = (comment: Comment, isReply = false) => {
    const isMine = !!user && comment.author_id === user.id;
    const canDelete = isMine || canModerateComments;
    const canReport = !!user && !isMine;
    const isEditing = editingId === comment.id;
    const isEdited = !!comment.updated_at;
    const likeCount = comment.like_count ?? 0;
    return (
      <div key={comment.id} className={isReply ? "pl-10" : ""}>
        <CommunityAuthorHeader
          nickname={comment.nickname}
          teamId={comment.team_id}
          avatarUrl={(comment as Comment & { avatar_url?: string }).avatar_url}
          profileHref={comment.author_id ? `/profile/${comment.author_id}` : null}
          meta={
            <span className="shrink-0 text-[11px] text-text-tertiary">
              {timeAgo(comment.created_at)}{isEdited ? " · 수정됨" : ""}
            </span>
          }
          menu={(canDelete || canReport) && !isEditing ? (
            <div className="relative">
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
                  {isMine && (
                    <button onClick={() => startEdit(comment)} className="block w-full px-3 py-2 text-left text-xs text-text-primary hover:bg-bg-tertiary">수정</button>
                  )}
                  {canReport && (
                    <button onClick={() => { setMenuOpenId(null); setReportCommentId(comment.id); }} className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-xs text-text-primary hover:bg-bg-tertiary">
                      <Flag size={12} /> 신고
                    </button>
                  )}
                  {canDelete && (
                    <button onClick={() => handleDelete(comment.id)} className="block w-full px-3 py-2 text-left text-xs text-[#FF453A] hover:bg-bg-tertiary">삭제</button>
                  )}
                </div>
              )}
            </div>
          ) : null}
        />
        <div className="ml-[50px] min-w-0">
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
              {isImageComment(comment.content) ? (
                <button
                  type="button"
                  onClick={() => setLightboxSrc(comment.content.trim())}
                  className="block cursor-zoom-in"
                  aria-label="댓글 이미지 확대"
                >
                  <img
                    src={comment.content.trim()}
                    alt="댓글 이미지"
                    className="mt-1 rounded-lg max-w-[220px] max-h-[280px] h-auto object-contain"
                    loading="lazy"
                  />
                </button>
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
      {/* Backdrop — 뒤 피드 스크롤 전파 차단(터치/오버스크롤) */}
      {shouldRender && (
        <motion.div
          key="comment-backdrop"
          className="fixed inset-0 bg-black/60"
          style={{ zIndex: 9998, touchAction: "none", overscrollBehavior: "none" }}
          initial={{ opacity: 0 }}
          animate={{ opacity: closing ? 0 : 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          onClick={requestClose}
          onTouchMove={(e) => { if (e.cancelable) e.preventDefault(); }}
        />
      )}

      {/* Sheet — AnimatePresence 직속 keyed child. (과거: backdrop+sheet를 <>fragment로 묶어
          AnimatePresence 자식이 1개의 fragment가 됐고, fragment엔 exit 추적이 안 걸려
          닫힘(스와이프/X) 시 exit 스프링이 *발화하지 않고* 즉시 언마운트됐다. transition만
          몇 번 바꿔도 변화 없던 근본 원인. backdrop/sheet를 각각 keyed 직속 child로 분리.) */}
      {shouldRender && (
          <motion.div
            key="comment-sheet"
            ref={sheetRef}
            className="fixed inset-x-0 flex flex-col bg-bg-secondary rounded-t-2xl overflow-hidden"
            style={{
              zIndex: 9999,
              // 시트 바닥은 항상 키보드 위(bottom=kbInset). 키보드 없으면 kbInset=0 → 화면 바닥.
              // (c) 확장: 높이=시각 뷰포트(vvHeight) → 키보드 열려도 목록+컴포저가 키보드 위에 함께 보임.
              // (b) 부분: 60dvh(단 시각 뷰포트보다 크지 않게 캡) — 뒤 피드 보이는 중간 높이.
              // vvHeight는 visualViewport 리스너가 state로 공급(위 effect). imperative style 미사용.
              bottom: kbInset,
              ...(expanded
                ? { height: vvHeight != null ? `${vvHeight}px` : "100dvh" }
                : { height: vvHeight != null ? `min(60dvh, ${vvHeight}px)` : "60dvh" }),
            }}
            initial={{ y: "100%" }}
            // 닫힘(closing)이면 아래로 슬라이드. 부모가 컴포넌트를 통째로 언마운트하므로
            // AnimatePresence exit가 안 먹는다 → animate 타깃을 직접 내리고, 내려간 뒤
            // onAnimationComplete에서 진짜 onClose를 호출(=그제서야 언마운트).
            animate={{ y: closing ? "100%" : 0 }}
            // ③ 닫힘 = 열릴 때 올라오는 것과 동일한 스프링으로 내려가게(속도/감속 대칭).
            //    이전 0.28s ease-in 트윈은 시작이 느려 "가만있다 뚝 사라지는" 느낌이라 폐기.
            exit={{ y: "100%" }}
            transition={{ type: "spring", damping: 28, stiffness: 300 }}
            onAnimationComplete={() => { if (closing) onClose(); }}
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
                onClick={requestClose}
                className="absolute right-4 top-0 p-1 text-text-tertiary hover:text-text-primary transition-colors"
              >
                <X size={20} />
              </button>
            </div>

            {/* Comment list */}
            <div ref={listRef} data-comment-scroll="true" className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 py-3 space-y-4">
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
            <div className="flex-none relative border-t border-border px-4 py-3" style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}>
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
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/jpeg,image/png,image/webp,image/gif"
                      className="hidden"
                      onChange={handleImageSelect}
                    />
                    <button
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={openImagePicker}
                      disabled={submitting || uploadingImage || cooldown}
                      className="flex items-center justify-center w-9 h-9 rounded-full text-text-tertiary hover:text-text-primary disabled:opacity-50 transition-colors"
                      aria-label="이미지 업로드"
                    >
                      {uploadingImage ? <Loader2 size={20} className="animate-spin" /> : <ImagePlus size={20} />}
                    </button>
                    <button
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        if (blurCollapseTimer.current) { clearTimeout(blurCollapseTimer.current); blurCollapseTimer.current = null; }
                        setExpanded(true);
                        setShowGifPicker((v) => !v);
                      }}
                      disabled={submitting || uploadingImage || cooldown}
                      className={`flex items-center justify-center w-9 h-9 rounded-full disabled:opacity-50 transition-colors ${showGifPicker ? "bg-accent/20 text-accent" : "text-text-tertiary hover:text-text-primary"}`}
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
                        if (blurCollapseTimer.current) {
                          clearTimeout(blurCollapseTimer.current);
                          blurCollapseTimer.current = null;
                        }
                        setShowGifPicker(false);
                        setExpanded(true);
                        const scrollToBottom = () => {
                          if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
                        };
                        requestAnimationFrame(scrollToBottom);
                        [120, 300, 600].forEach((ms) => setTimeout(scrollToBottom, ms));
                      }}
                      onBlur={() => {
                        // 키보드가 내려가면 (c)확장 → (b)중간 높이로 복귀. 전송/GIF 버튼 탭으로 잠깐
                        // 포커스를 잃는 경우는 곧 다시 포커스가 돌아오므로, 짧게 지연 후에도 여전히
                        // input이 비포커스일 때만 접는다.
                        if (blurCollapseTimer.current) clearTimeout(blurCollapseTimer.current);
                        blurCollapseTimer.current = window.setTimeout(() => {
                          if (document.activeElement !== inputRef.current) setExpanded(false);
                          blurCollapseTimer.current = null;
                        }, 120);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                          e.preventDefault();
                          handleSubmit();
                        }
                      }}
                      placeholder={uploadingImage ? "이미지 업로드 중..." : cooldown ? (cooldownReason || "잠시 후 다시 입력하세요...") : replyTo ? `${replyTo.nickname}에게 답글...` : "댓글을 입력하세요"}
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
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={handleSubmit}
                  disabled={!input.trim() || submitting || uploadingImage || cooldown || !user}
                  className="flex items-center justify-center w-9 h-9 rounded-full text-white disabled:opacity-50 transition-opacity"
                  style={{ backgroundColor: teamId ? (() => { const t = getTeamById(teamId); return t ? getTeamBgColor(t) : '#FF453A'; })() : '#FF453A' }}
                >
                  <Send size={16} />
                </button>
              </div>
            </div>
          </motion.div>
      )}
    </AnimatePresence>,
    document.body
  )}
  {showLogin && <LoginSheet isOpen={showLogin} onClose={() => setShowLogin(false)} />}
  {reportCommentId !== null && (
    <ReportSheet
      isOpen
      onClose={() => setReportCommentId(null)}
      targetType="comment"
      targetId={reportCommentId}
      onReported={({ hidden }) => {
        if (!hidden) return;
        const removedCount = comments.filter(
          (comment) => comment.id === reportCommentId || comment.parent_id === reportCommentId,
        ).length;
        setComments((prev) => prev.filter(
          (comment) => comment.id !== reportCommentId && comment.parent_id !== reportCommentId,
        ));
        if (postId) onCommentDeleted?.(postId, Math.max(1, removedCount));
      }}
    />
  )}
  <CommentImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />
  </>);
}
