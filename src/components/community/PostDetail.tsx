"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronLeft, Heart, MessageCircle, Share2, Send, Flag, Ban, MoreHorizontal, Check, CornerDownRight, X, ImagePlay, ImagePlus, Loader2 } from "lucide-react";
import TeamBadge from "@/components/ui/TeamBadge";
import { getAvatarPath } from "@/lib/constants/avatars";
import { usePostDetail, createComment, toggleLike, toggleCommentLike, updatePost, deletePost, updateComment, deleteComment, uploadCommentImage } from "@/lib/supabase/usePosts";
import { editPollPost } from "@/lib/community/poll-client";
import { canEditOwnPost } from "@/lib/community/post-permissions";
import PostActionsMenu from "@/components/community/PostActionsMenu";
import ReportSheet from "@/components/community/ReportSheet";
import LinkPreview from "@/components/community/LinkPreview";
import { isShortText, BrandedTextCard, getPostScopeLabel } from "@/components/community/FeedTextCards";
import { PhotoCarousel, HeartOverlay } from "@/components/community/PhotoFeed";
import { parseAttribution } from "@/lib/gif-collector/attribution";
import { useAuth } from "@/lib/supabase/AuthContext";
import { getTeamById, getTeamBgColor } from "@/lib/constants/teams";
import { getTeamBorderColorById } from "@/lib/utils/team-border-color";
import DMButton from "@/components/ui/DMButton";
import GifPicker from "@/components/community/GifPicker";
import CommentImageLightbox from "@/components/community/CommentImageLightbox";
import { isImageComment, prepareCommentImageForUpload } from "@/lib/community/comment-media";
import LoginSheet from "@/components/auth/LoginSheet";
import ShareSheet, { type ShareSheetPost } from "@/components/community/ShareSheet";
import PostViewBadge from "@/components/community/PostViewBadge";
import PollBlock from "@/components/community/PollBlock";
import { trackPostClick } from "@/lib/community/view-tracker";
import { useBlockedIds, blockUserById } from "@/lib/supabase/useBlock";
import { supabase } from "@/lib/supabase/client";

interface PostDetailProps {
  postId: number;
}

export default function PostDetail({ postId }: PostDetailProps) {
  const router = useRouter();
  const { user, profile } = useAuth();
  const [showReport, setShowReport] = useState(false);
  const [reportTarget, setReportTarget] = useState<{type: "post"|"comment"; id: number}>({type: "post", id: 0});
  const { post, comments, loading, liked, setLiked, setComments } = usePostDetail(postId);
  // 조회수(클릭) 집계 — 상세 진입마다 +1(dedup 없음, 하린아빠 스펙). postId당 1회(StrictMode
  // 이중발화 방지) — 같은 글 재진입(별도 네비게이션)은 새 마운트라서 정상 집계된다.
  const clickTrackedRef = useRef<number | null>(null);
  useEffect(() => {
    if (!Number.isInteger(postId) || postId <= 0) return;
    if (clickTrackedRef.current === postId) return;
    clickTrackedRef.current = postId;
    trackPostClick(postId);
  }, [postId]);
  const { blockedIds } = useBlockedIds();
  const [comment, setComment] = useState("");
  const [likeCount, setLikeCount] = useState(0);
  const [heartShow, setHeartShow] = useState(false);
  const [replyTo, setReplyTo] = useState<{ id: number; nickname: string } | null>(null);
  const [showGifPicker, setShowGifPicker] = useState(false);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [showLogin, setShowLogin] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Keyboard handling — delegated to the global `interactive-widget=
  // resizes-content` viewport (layout.tsx), exactly like GameChat. On focus iOS
  // shrinks the layout viewport by the keyboard height and the native form-
  // assistant pushes the accessory bar (⌃⌄✓) above the input, so the fixed
  // composer (bottom:0 via body.kbd-open, see globals.css) docks flush above the
  // keyboard with NO JS viewport math. We only toggle body.kbd-open (hides the
  // TabBar + snaps the composer/overlays to the bottom).
  //
  // The previous visualViewport/keyboardInset scheme was written for keyboard
  // OVERLAY mode; under resizes-content its `innerHeight - vv.height` collapsed
  // to ~0, floating the composer mid-screen and dragging the header up.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const isComposer = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      if (!el || (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA")) return false;
      return Boolean(el.closest('[data-composer="postdetail"]'));
    };
    const onFocusIn = (e: FocusEvent) => {
      if (!isComposer(e.target)) return;
      document.body.classList.add("kbd-open");
    };
    const onFocusOut = (e: FocusEvent) => {
      if (!isComposer(e.target)) return;
      // settle: absorb brief blur→refocus from Korean IME toggles.
      setTimeout(() => {
        if (!isComposer(document.activeElement)) document.body.classList.remove("kbd-open");
      }, 100);
    };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      document.body.classList.remove("kbd-open");
    };
  }, []);

  // Lock the document scroll while PostDetail is mounted so the document-flow
  // header can't be dragged under the notch/Dynamic Island by scrollIntoView or
  // a stray tap on iOS WKWebView. All scrolling stays in the inner container.
  useEffect(() => {
    const html = document.documentElement;
    html.classList.add("postdetail-open");
    return () => html.classList.remove("postdetail-open");
  }, []);

  // 게시글 메뉴/편집 상태
  const [postMenuOpen, setPostMenuOpen] = useState(false);
  const [postEditing, setPostEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [editTitle, setEditTitle] = useState(""); // 투표글 전용 질문 필드(설명=editContent 재사용)
  // 투표글 설명 textarea 자동 세로 확장(WritePoll 과 동일 UX). ~10줄 cap 후 내부 스크롤.
  const editPollContentRef = useRef<HTMLTextAreaElement>(null);
  const [savingPost, setSavingPost] = useState(false);
  const [deletingPost, setDeletingPost] = useState(false);
  const [postPatch, setPostPatch] = useState<{ title?: string; content?: string; updated_at?: string }>({});

  // 댓글 메뉴/편집 상태
  const [cmtMenuOpenId, setCmtMenuOpenId] = useState<number | null>(null);
  const [cmtEditingId, setCmtEditingId] = useState<number | null>(null);
  const [cmtLightboxSrc, setCmtLightboxSrc] = useState<string | null>(null);
  const [cmtEditInput, setCmtEditInput] = useState("");
  const [cmtSaving, setCmtSaving] = useState(false);

  // 투표글 설명 textarea auto-grow: editContent 변경·편집 진입 시 height 재계산(생성 화면과 동일).
  // ref 가 마운트된 때(=투표글 편집 블록 렌더링)만 동작 → early-return 앞에 무조건 호출(hooks 규칙).
  useEffect(() => {
    if (!postEditing) return;
    const el = editPollContentRef.current;
    if (!el) return;
    const CONTENT_MAX_PX = 240; // 약 10줄
    el.style.height = "auto";
    const next = el.scrollHeight;
    if (next > CONTENT_MAX_PX) {
      el.style.height = `${CONTENT_MAX_PX}px`;
      el.style.overflowY = "auto";
    } else {
      el.style.height = `${next}px`;
      el.style.overflowY = "hidden";
    }
  }, [editContent, postEditing]);

  if (loading) return <div className="flex items-center justify-center h-screen text-text-secondary">로딩 중...</div>;
  if (!post) return <div className="flex items-center justify-center h-screen text-text-secondary">게시글을 찾을 수 없습니다</div>;

  const isPostMine = canEditOwnPost(post.author_id, user?.id);
  const canModerateComments = profile?.is_operator === true;
  const canDeleteAnyPost = profile?.is_operator === true;

  const isPoll = post.board_type === "poll";

  function startPostEdit() {
    setPostMenuOpen(false);
    if (isPoll) {
      // 투표글: 질문(title)·설명(content)을 별도 필드로 편집(선지·마감은 이 화면에서 고정).
      setEditTitle(postPatch.title ?? post!.title);
      setEditContent(postPatch.content ?? post!.content ?? "");
    } else {
      // 일반글: 제목 필드 제거(⑥) — 기존 제목은 본문 앞에 합쳐 한 본문으로 편집. 저장 시 title은 비움.
      setEditContent(mergeTitleBody(post!.title, post!.content));
    }
    setPostEditing(true);
  }

  function cancelPostEdit() {
    setPostEditing(false);
  }

  async function savePostEdit() {
    if (savingPost) return;
    if (isPoll) {
      const t = editTitle.trim();
      if (!t) { alert("질문을 입력해주세요"); return; }
      if (t.length > 200) { alert("질문은 200자 이하여야 해요"); return; }
      if (editContent.length > 2000) { alert("설명은 2000자 이하여야 해요"); return; }
      setSavingPost(true);
      try {
        // 투표글: 질문(title)·설명(content)만 서버 route(PATCH)로 저장.
        // 인증·작성자·검증·모더레이션은 서버, 비텍스트 필드 불변은 DB 트리거가 backstop.
        await editPollPost(post!.id, { title: t, content: editContent });
        setPostPatch({ title: t, content: editContent, updated_at: new Date().toISOString() });
        setPostEditing(false);
      } catch (e) {
        alert(e instanceof Error ? e.message : "투표 수정에 실패했어요");
      } finally {
        setSavingPost(false);
      }
      return;
    }
    const c = editContent.trim();
    if (!c) { alert("내용을 입력해주세요"); return; }
    setSavingPost(true);
    try {
      await updatePost(post!.id, { title: "", content: editContent });
      setPostPatch({ title: "", content: editContent, updated_at: new Date().toISOString() });
      setPostEditing(false);
    } catch {
      alert("게시글 수정에 실패했어요");
    } finally {
      setSavingPost(false);
    }
  }

  async function handleDeletePost() {
    setPostMenuOpen(false);
    if (!confirm("이 게시글을 삭제할까요? 댓글/좋아요도 함께 삭제됩니다.")) return;
    setDeletingPost(true);
    try {
      await deletePost(post!.id, { canDeleteAny: canDeleteAnyPost });
      router.back();
    } catch {
      alert("게시글 삭제에 실패했어요");
      setDeletingPost(false);
    }
  }

  function startCmtEdit(c: { id: number; content: string }) {
    setCmtMenuOpenId(null);
    setCmtEditingId(c.id);
    setCmtEditInput(c.content);
  }

  async function saveCmtEdit() {
    if (cmtEditingId === null || cmtSaving) return;
    const t = cmtEditInput.trim();
    if (!t) return;
    setCmtSaving(true);
    try {
      await updateComment(cmtEditingId, t);
      setComments(prev => prev.map(c =>
        c.id === cmtEditingId ? { ...c, content: t, updated_at: new Date().toISOString() } : c
      ));
      setCmtEditingId(null);
      setCmtEditInput("");
    } catch {
      alert("댓글 수정에 실패했어요");
    } finally {
      setCmtSaving(false);
    }
  }

  async function handleDeleteComment(id: number) {
    setCmtMenuOpenId(null);
    if (!confirm("이 댓글을 삭제할까요?")) return;
    try {
      await deleteComment(id, { canDeleteAny: canModerateComments });
      setComments(prev => prev.filter(c => c.id !== id));
    } catch {
      alert("댓글 삭제에 실패했어요");
    }
  }

  // 신고 — ReportSheet 오픈(글/댓글 공통).
  function openReport(target: { type: "post" | "comment"; id: number }) {
    setPostMenuOpen(false);
    setCmtMenuOpenId(null);
    if (!user) { setShowLogin(true); return; }
    setReportTarget(target);
    setShowReport(true);
  }

  // 차단 — ①user_blocks 등록(피드/목록 즉시 반영) ②운영팀에 해당 콘텐츠 자동 신고(개발자 알림)
  // ③현재 화면에서 즉시 제거. Apple 1.2 "block should notify the developer & remove from feed instantly".
  async function handleBlockUser(authorId: string | null | undefined, ctx?: { type: "post" | "comment"; id: number }) {
    setPostMenuOpen(false);
    setCmtMenuOpenId(null);
    if (!user) { setShowLogin(true); return; }
    if (!authorId || authorId === user.id) return;
    if (!confirm("이 사용자를 차단할까요?\n차단하면 이 사용자의 글과 댓글이 더 이상 보이지 않으며, 운영팀에 자동으로 신고됩니다.")) return;
    const ok = await blockUserById(user.id, authorId);
    if (!ok) { alert("차단에 실패했어요. 잠시 후 다시 시도해주세요."); return; }
    // 개발자(운영팀)에게 해당 콘텐츠 자동 신고 — 실패해도 차단 자체는 유지.
    if (ctx) {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (session?.access_token) {
          await fetch("/api/report", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
            body: JSON.stringify({ targetType: ctx.type, targetId: ctx.id, reason: "block", detail: "사용자 차단에 따른 자동 신고" }),
          });
        }
      } catch { /* 신고 실패는 차단을 막지 않음 */ }
    }
    // 즉시 화면에서 제거: 글이면 뒤로(피드는 useBlockedIds 브로드캐스트로 필터), 댓글이면 목록에서 제거.
    if (ctx?.type === "post") {
      router.back();
    } else {
      setComments(prev => prev.filter(c => c.author_id !== authorId));
    }
  }

  async function handleLike() {
    if (!user) { alert("로그인이 필요합니다"); return; }
    try {
      const newLiked = await toggleLike(post!.id);
      setLiked(newLiked);
      setLikeCount(prev => newLiked ? prev + 1 : prev - 1);
    } catch {}
  }

  // 캐러셀 더블탭 → 인스타식 좋아요(이미 좋아요면 취소하지 않고 하트 애니메이션만). 피드(PhotoFeed)와 동일.
  function handleMediaDoubleTap() {
    if (user && !liked) void handleLike();
    setHeartShow(true);
    setTimeout(() => setHeartShow(false), 800);
  }

  async function handleComment() {
    if (!user) { setShowLogin(true); return; }
    if (uploadingImage) return;
    if (!comment.trim()) return;
    try {
      const result = await createComment(post!.id, comment.trim(), replyTo?.id);
      setComment("");
      setComments(prev => [...prev, {
        id: result.id,
        post_id: post!.id,
        author_id: user.id,
        content: comment.trim(),
        created_at: new Date().toISOString(),
        parent_id: replyTo?.id ?? null,
        like_count: 0,
        liked_by_me: false,
        nickname: profile?.nickname ?? user?.user_metadata?.name ?? "나",
        team_id: profile?.team_id,
        grade: profile?.grade,
        avatar_url: profile?.avatar_url ?? undefined,
      }]);
      setReplyTo(null);
    } catch (err) {
      console.error("[PostDetail] createComment failed:", err);
      alert("댓글 저장에 실패했어요");
    }
  }

  async function handleGifSelect(gifUrl: string) {
    if (!user) { setShowLogin(true); return; }
    if (uploadingImage) return;
    setShowGifPicker(false);
    try {
      const result = await createComment(post!.id, gifUrl, replyTo?.id);
      setComments(prev => [...prev, {
        id: result.id,
        post_id: post!.id,
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
      }]);
      setReplyTo(null);
    } catch (err) {
      console.error("[PostDetail] GIF comment failed:", err);
      alert("GIF 전송에 실패했어요");
    }
  }

  function openImagePicker() {
    if (!user) { setShowLogin(true); return; }
    if (uploadingImage) return;
    setShowGifPicker(false);
    fileInputRef.current?.click();
  }

  async function handleImageSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!user) { setShowLogin(true); return; }
    if (uploadingImage) return;

    setShowGifPicker(false);
    setUploadingImage(true);
    try {
      const prepared = await prepareCommentImageForUpload(file);
      const imageUrl = await uploadCommentImage(prepared);
      const result = await createComment(post!.id, imageUrl, replyTo?.id);
      setComments(prev => [...prev, {
        id: result.id,
        post_id: post!.id,
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
      }]);
      setReplyTo(null);
    } catch (err) {
      console.error("[PostDetail] image comment failed:", err);
      alert(err instanceof Error ? err.message : "이미지 업로드에 실패했어요");
    } finally {
      setUploadingImage(false);
    }
  }

  async function handleCommentLike(commentId: number) {
    if (!user) { alert("로그인이 필요합니다"); return; }
    // optimistic
    setComments(prev =>
      prev.map(c =>
        c.id === commentId
          ? { ...c, liked_by_me: !c.liked_by_me, like_count: (c.like_count ?? 0) + (c.liked_by_me ? -1 : 1) }
          : c
      )
    );
    try {
      await toggleCommentLike(commentId);
    } catch {
      // revert
      setComments(prev =>
        prev.map(c =>
          c.id === commentId
            ? { ...c, liked_by_me: !c.liked_by_me, like_count: (c.like_count ?? 0) + (c.liked_by_me ? -1 : 1) }
            : c
        )
      );
    }
  }

  function handleReply(c: { id: number; parent_id?: number | null; nickname?: string }) {
    setReplyTo({ id: c.parent_id ? c.parent_id : c.id, nickname: c.nickname || "익명" });
  }

  const timeAgo = (date: string) => {
    // eslint-disable-next-line react-hooks/purity
    const diff = Date.now() - new Date(date).getTime();
    const min = Math.floor(diff / 60000);
    if (min < 1) return "방금 전";
    if (min < 60) return `${min}분 전`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}시간 전`;
    return `${Math.floor(hr / 24)}일 전`;
  };

  // Chat-style layout: container matches viewport, inner scroll holds post+comments.
  // Composer is position:fixed; its bottom offset + the scroll area's reserved
  // padding are driven by CSS off body.kbd-open (see globals.css) — no JS math.
  return (
    <div className="postdetail-chat-container flex flex-col bg-bg-primary">
      {/* Header (flex-none, stays at top) */}
      <div className="flex-none border-b border-border bg-bg-primary" style={{ borderColor: post.team_id ? getTeamBorderColorById(post.team_id) : undefined }}>
        <div className="flex items-center gap-3 px-4 py-3">
          <button onClick={() => router.back()}>
            <ChevronLeft size={24} className="text-text-secondary" />
          </button>
          <span className="text-lg font-semibold text-text-primary flex-1">{(() => {
            // 헤더 = 태그 기반 브레드크럼(홈 최신글 라벨과 동일 원칙).
            // 선수1명→"커뮤니티 > 팀 선수" / 선수2+·팀단일→"커뮤니티 > 팀" / 다팀·없음→"커뮤니티".
            const scope = getPostScopeLabel(post);
            return scope ? `커뮤니티 > ${scope}` : "커뮤니티";
          })()}</span>
          <button onClick={() => setShareOpen(true)} aria-label="게시글 공유">
            <Share2 size={20} className="text-text-tertiary" />
          </button>
        </div>
      </div>

      {/* Scrollable body: post + comments. Bottom padding (CSS) reserves composer height. */}
      <div data-postdetail-scroll className="flex-1 overflow-y-auto overscroll-contain">

      {/* Post */}
      <div className="px-5 py-4">
        <div className="flex items-center gap-2 mb-3 whitespace-nowrap">
          {post.team_id ? <div className="shrink-0"><TeamBadge teamId={post.team_id} size="xs" /></div> : null}
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary cursor-pointer hover:text-accent" onClick={() => post.author_id && router.push(`/profile/${post.author_id}`)}>{post.nickname || "익명"}</span>
          {post.grade === 'staff' && (
            <span className='ml-1 px-1.5 py-0.5 text-[10px] font-bold bg-accent/20 text-accent rounded-full'>운영팀</span>
          )}
          {post.author_id && user && post.author_id !== user.id && (
            <DMButton targetUserId={post.author_id} size="sm" className="shrink-0" />
          )}
          <span className="shrink-0 text-sm text-text-tertiary">
            {timeAgo(post.created_at)}{(postPatch.updated_at || post.updated_at) ? " · 수정됨" : ""}
          </span>
          <PostViewBadge
            clickCount={post.click_view_count}
            impressionCount={post.impression_view_count}
            className="shrink-0"
          />
          <div className="shrink-0">
            <PostActionsMenu
              user={user}
              postEditing={postEditing}
              authorId={post.author_id}
              userId={user?.id}
              canDeleteAny={canDeleteAnyPost}
              open={postMenuOpen}
              disabled={deletingPost}
              onToggle={() => setPostMenuOpen((v) => !v)}
              onClose={() => setPostMenuOpen(false)}
              onEdit={startPostEdit}
              onReport={() => openReport({ type: "post", id: post.id })}
              onBlock={() => handleBlockUser(post.author_id, { type: "post", id: post.id })}
              onDelete={handleDeletePost}
            />
          </div>
        </div>

        {/* 미디어 — 사진 → 글 순서(피드 PhotoFeed와 동일). 인스타식 캐러셀(스와이프+점+더블탭 좋아요).
            본문 px-5 패딩 밖으로 -mx-5 full-bleed. mb-4로 아래 본문과 간격(위 간격은 작성자행 mb-3). */}
        {(post.image_urls.length > 0 || (post.video_urls?.length ?? 0) > 0) && (
          <div className="relative mb-4 -mx-5">
            <PhotoCarousel
              slides={[
                ...post.image_urls.map((url: string) => ({ url, isVideo: false })),
                ...(post.video_urls ?? []).map((url: string) => ({ url, isVideo: true })),
              ]}
              onDoubleTap={handleMediaDoubleTap}
            />
            <HeartOverlay show={heartShow} />
          </div>
        )}

        {postEditing && isPoll ? (
          <div className="space-y-2 mb-3">
            {/* 투표글: 질문(title)·설명(content)만 수정. 선지·마감은 이 화면에서 변경 불가. */}
            <input
              value={editTitle}
              onChange={e => setEditTitle(e.target.value)}
              placeholder="질문"
              maxLength={200}
              className="w-full bg-bg-secondary rounded-lg px-3 py-2 text-sm font-semibold text-text-primary outline-none border border-border"
            />
            <textarea
              ref={editPollContentRef}
              value={editContent}
              onChange={e => setEditContent(e.target.value)}
              placeholder="설명 (선택)"
              rows={2}
              maxLength={2000}
              className="w-full bg-bg-secondary rounded-lg px-3 py-2 text-sm text-text-primary outline-none border border-border resize-none"
            />
            <p className="text-xs text-text-tertiary">질문·설명만 수정할 수 있어요. 투표가 시작되면 선지와 마감 시간은 변경할 수 없습니다.</p>
            <div className="flex items-center gap-2">
              <button
                onClick={savePostEdit}
                disabled={savingPost || !editTitle.trim()}
                className="px-4 py-2 rounded-lg text-sm font-semibold text-white disabled:opacity-50"
                style={{ backgroundColor: post.team_id ? (() => { const t = getTeamById(post.team_id); return t ? getTeamBgColor(t) : '#FF453A'; })() : '#FF453A' }}
              >
                {savingPost ? "저장 중..." : "저장"}
              </button>
              <button onClick={cancelPostEdit} className="px-4 py-2 rounded-lg text-sm text-text-secondary hover:bg-bg-tertiary">취소</button>
            </div>
          </div>
        ) : postEditing ? (
          <div className="space-y-2 mb-3">
            <textarea
              value={editContent}
              onChange={e => setEditContent(e.target.value)}
              placeholder="내용"
              rows={6}
              className="w-full bg-bg-secondary rounded-lg px-3 py-2 text-sm text-text-primary outline-none border border-border resize-y"
            />
            <div className="flex items-center gap-2">
              <button
                onClick={savePostEdit}
                disabled={savingPost || !editContent.trim()}
                className="px-4 py-2 rounded-lg text-sm font-semibold text-white disabled:opacity-50"
                style={{ backgroundColor: post.team_id ? (() => { const t = getTeamById(post.team_id); return t ? getTeamBgColor(t) : '#FF453A'; })() : '#FF453A' }}
              >
                {savingPost ? "저장 중..." : "저장"}
              </button>
              <button onClick={cancelPostEdit} className="px-4 py-2 rounded-lg text-sm text-text-secondary hover:bg-bg-tertiary">취소</button>
            </div>
          </div>
        ) : (
          // 제목 필드 제거(⑥) → 기존 글의 title은 본문 앞에 합쳐 렌더(피드 mergedBody와 동일 형식, 데이터 보존).
          // 움짤콜렉터 자동 출처 "(출처: …)\n{url}"는 분리해 원문 하이퍼링크로 렌더.
          (() => {
            const merged = mergeTitleBody(postPatch.title ?? post.title, postPatch.content ?? post.content);
            const hasMedia = post.image_urls.length > 0 || (post.video_urls?.length ?? 0) > 0;
            // 미디어 없는 짧은 글은 피드(PhotoFeed)의 BrandedTextCard와 동일하게 렌더.
            // BrandedTextCard가 내부적으로 LinkPreview를 처리하므로 아래 별도 LinkPreview는 생략(중복 방지).
            if (!hasMedia && merged.trim() && isShortText(merged)) {
              return <BrandedTextCard post={post} body={merged} />;
            }
            const attr = parseAttribution(merged);
            const body = stripUrls(attr ? attr.body : merged);
            // 사진 → 글 순서로 미디어가 위에 오므로, 캡션 없는 사진 글은 빈 문단을 렌더하지 않음.
            if (hasMedia && !body && !attr) return null;
            return (
              <p className="readable-body whitespace-pre-line">
                {body}
                {attr && (
                  <>
                    {`${attr.body ? "\n\n" : ""}(출처: ${attr.handle ? attr.label + " " : ""}`}
                    <a href={attr.url} target="_blank" rel="noopener noreferrer" className="text-accent">
                      {attr.handle ? `@${attr.handle}` : attr.label}
                    </a>
                    {")"}
                  </>
                )}
              </p>
            );
          })()
        )}

        {/* Link previews (수정된 content 반영) — 자동 출처 URL은 위 하이퍼링크로 대체되므로 제외.
            미디어 없는 짧은 글(BrandedTextCard 분기)은 카드가 LinkPreview를 내부 처리하므로 여기선 생략. */}
        {(() => {
          const merged = mergeTitleBody(postPatch.title ?? post.title, postPatch.content ?? post.content);
          const hasMedia = post.image_urls.length > 0 || (post.video_urls?.length ?? 0) > 0;
          if (!postEditing && !hasMedia && merged.trim() && isShortText(merged)) return null;
          return (
            <LinkPreview
              text={parseAttribution(merged)?.body ?? (postPatch.content ?? post.content)}
              maxPreviews={3}
            />
          );
        })()}

        {/* 투표 블록 (board_type='poll' 전용, 선지·집계·상태만 렌더) */}
        {post.board_type === "poll" && (
          <PollBlock postId={post.id} onRequireLogin={() => setShowLogin(true)} />
        )}

        {/* Actions */}
        <div className="flex items-center gap-4 mt-4 pt-3 border-t border-border">
          <button onClick={handleLike} className="flex items-center gap-1.5 min-h-[44px] min-w-[44px] px-2 -ml-2 rounded-lg active:bg-bg-tertiary transition-colors">
            <Heart size={20} className={liked ? "text-red-500" : "text-text-tertiary"} fill={liked ? "currentColor" : "none"} />
            <span className="text-sm text-text-secondary">{post.like_count + likeCount}</span>
          </button>
          <div className="flex items-center gap-1.5 min-h-[44px] min-w-[44px] px-2">
            <MessageCircle size={20} className="text-text-tertiary" />
            <span className="text-sm text-text-secondary">{comments.length}</span>
          </div>
        </div>
      </div>

      {/* Comments */}
      <div className="border-t border-border">
        <div className="px-5 py-3">
          <h3 className="text-sm font-bold text-text-primary">댓글 {comments.length}개</h3>
        </div>
        <div className="px-5 space-y-4 pb-4">
          {comments.length === 0 ? (
            <p className="text-sm text-text-tertiary text-center py-6">첫 댓글을 남겨보세요 💬</p>
          ) : (
            (() => {
              // Build comment tree (2-depth). 차단한 유저의 댓글은 제외.
              const visibleComments = blockedIds.size
                ? comments.filter(c => !c.author_id || !blockedIds.has(c.author_id))
                : comments;
              const roots: (typeof comments[0] & { replies: typeof comments })[] = [];
              const childMap = new Map<number, typeof comments>();
              for (const c of visibleComments) {
                if (!c.parent_id) {
                  roots.push({ ...c, replies: [] });
                } else {
                  const arr = childMap.get(c.parent_id) || [];
                  arr.push(c);
                  childMap.set(c.parent_id, arr);
                }
              }
              for (const root of roots) root.replies = childMap.get(root.id) || [];

              const renderCmt = (c: typeof comments[0], isReply = false) => {
                const avatarPath = getAvatarPath(c.avatar_url ?? null);
                const cmtTeam = c.team_id ? getTeamById(c.team_id) : undefined;
                const isCmtMine = !!user && c.author_id === user.id;
                const canDeleteCmt = isCmtMine || canModerateComments;
                const isCmtEditing = cmtEditingId === c.id;
                const isCmtEdited = !!c.updated_at;
                const cmtLikeCount = c.like_count ?? 0;
                return (
                  <div key={c.id} className={`flex gap-2 ${isReply ? "pl-10" : ""}`}>
                    {avatarPath ? (
                      <div className={`${isReply ? "w-6 h-6" : "w-8 h-8"} rounded-full overflow-hidden flex-shrink-0 bg-bg-tertiary cursor-pointer`} onClick={() => c.author_id && router.push(`/profile/${c.author_id}`)}>
                        <img src={avatarPath} alt="" className="w-full h-full" />
                      </div>
                    ) : (
                      <div
                        className={`${isReply ? "w-6 h-6 text-[10px]" : "w-8 h-8 text-xs"} rounded-full flex items-center justify-center font-bold text-white flex-shrink-0 cursor-pointer`}
                        style={{ backgroundColor: cmtTeam ? getTeamBgColor(cmtTeam) : '#6B7280' }}
                        onClick={() => c.author_id && router.push(`/profile/${c.author_id}`)}
                      >
                        {(c.nickname || "익")[0]}
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className={`${isReply ? "text-xs" : "text-sm"} font-semibold text-text-primary cursor-pointer hover:text-accent`} onClick={() => c.author_id && router.push(`/profile/${c.author_id}`)}>{c.nickname || "익명"}</span>
                        {cmtTeam && (
                          <span
                            className="text-[10px] font-bold px-1.5 py-0.5 rounded-md text-white"
                            style={{ backgroundColor: getTeamBgColor(cmtTeam) }}
                          >
                            {cmtTeam.shortName}
                          </span>
                        )}
                        <span className="text-xs text-text-tertiary ml-auto flex-shrink-0">
                          {timeAgo(c.created_at)}{isCmtEdited ? " · 수정됨" : ""}
                        </span>
                        {user && !isCmtEditing && (
                          <div className="relative flex-shrink-0">
                            <button
                              onClick={(e) => { e.stopPropagation(); setCmtMenuOpenId(prev => prev === c.id ? null : c.id); }}
                              className="p-1 text-text-tertiary hover:text-text-primary"
                              aria-label="댓글 메뉴"
                            >
                              <MoreHorizontal size={14} />
                            </button>
                            {cmtMenuOpenId === c.id && (
                              <>
                                <div className="fixed inset-0 z-10" onClick={() => setCmtMenuOpenId(null)} />
                                <div className="absolute right-0 top-6 z-20 min-w-[96px] rounded-lg border border-border bg-bg-primary shadow-lg overflow-hidden">
                                  {isCmtMine && (
                                    <button onClick={() => startCmtEdit(c)} className="block w-full px-3 py-2 text-left text-xs text-text-primary hover:bg-bg-tertiary">수정</button>
                                  )}
                                  {!isCmtMine && (
                                    <button onClick={() => openReport({ type: "comment", id: c.id })} className="flex items-center gap-1.5 w-full px-3 py-2 text-left text-xs text-text-primary hover:bg-bg-tertiary">
                                      <Flag size={12} /> 신고
                                    </button>
                                  )}
                                  {!isCmtMine && (
                                    <button onClick={() => handleBlockUser(c.author_id, { type: "comment", id: c.id })} className="flex items-center gap-1.5 w-full px-3 py-2 text-left text-xs text-text-primary hover:bg-bg-tertiary">
                                      <Ban size={12} /> 차단
                                    </button>
                                  )}
                                  {canDeleteCmt && (
                                    <button onClick={() => handleDeleteComment(c.id)} className="block w-full px-3 py-2 text-left text-xs text-[#FF453A] hover:bg-bg-tertiary">삭제</button>
                                  )}
                                </div>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                      {isCmtEditing ? (
                        <div className="mt-1 flex items-center gap-1.5">
                          <input
                            autoFocus
                            type="text"
                            value={cmtEditInput}
                            onChange={e => setCmtEditInput(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); saveCmtEdit(); }
                              else if (e.key === "Escape") { e.preventDefault(); setCmtEditingId(null); }
                            }}
                            className="flex-1 bg-bg-tertiary rounded-lg px-3 py-1.5 text-sm text-text-primary outline-none border border-border"
                          />
                          <button
                            onClick={saveCmtEdit}
                            disabled={!cmtEditInput.trim() || cmtSaving}
                            className="flex items-center justify-center w-7 h-7 rounded-full text-white disabled:opacity-50"
                            style={{ backgroundColor: post.team_id ? (() => { const t = getTeamById(post.team_id); return t ? getTeamBgColor(t) : '#FF453A'; })() : '#FF453A' }}
                            aria-label="저장"
                          >
                            <Check size={14} />
                          </button>
                          <button onClick={() => setCmtEditingId(null)} className="text-[11px] text-text-tertiary px-1">취소</button>
                        </div>
                      ) : (
                        <>
                          {isImageComment(c.content) ? (
                            <button
                              type="button"
                              onClick={() => setCmtLightboxSrc(c.content.trim())}
                              className="block cursor-zoom-in"
                              aria-label="댓글 이미지 확대"
                            >
                              <img
                                src={c.content.trim()}
                                alt="댓글 이미지"
                                className="mt-1 rounded-lg max-w-[220px] max-h-[280px] h-auto object-contain"
                                loading="lazy"
                              />
                            </button>
                          ) : (
                            <p className="readable-body mt-0.5 break-words">{c.content}</p>
                          )}
                          <div className="flex items-center gap-3 mt-1">
                            <button
                              onClick={() => handleCommentLike(c.id)}
                              className="flex items-center gap-1 text-text-tertiary hover:text-[#FF453A] transition-colors"
                            >
                              <Heart size={12} className={c.liked_by_me ? "fill-[#FF453A] text-[#FF453A]" : ""} />
                              {cmtLikeCount > 0 && <span className="text-[11px]">{cmtLikeCount}</span>}
                            </button>
                            {!isReply && (
                              <button
                                onClick={() => handleReply(c)}
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

              return roots.map(root => (
                <div key={root.id}>
                  {renderCmt(root)}
                  {root.replies.length > 0 && (
                    <div className="mt-3 space-y-3">
                      {root.replies.map(reply => renderCmt(reply, true))}
                    </div>
                  )}
                </div>
              ));
            })()
          )}
        </div>
      </div>

      </div> {/* end scrollable body */}

      {/*
        Comment Input — fixed to viewport bottom. Bottom offset is CSS-driven off
        body.kbd-open (see globals.css): idle it clears the TabBar (4rem+safe),
        focused it snaps to bottom:0 which — under interactive-widget=resizes-
        content — sits flush above the keyboard. Reply chip + GIF picker ride
        just above it. No JS viewport math.
      */}
      {/* Reply indicator */}
      {replyTo && (
        <div data-postdetail-reply className="fixed left-0 right-0 bg-bg-tertiary/80 border-t border-border px-4 py-2 flex items-center gap-2 z-40">
          <CornerDownRight size={12} className="text-text-tertiary" />
          <span className="text-xs text-text-secondary">{replyTo.nickname}에게 답글</span>
          <button onClick={() => setReplyTo(null)} className="ml-auto text-text-tertiary hover:text-text-primary">
            <X size={14} />
          </button>
        </div>
      )}
      {/* GIF Picker — pure overlay, no layout shift */}
      <AnimatePresence>
        {showGifPicker && (
          <motion.div
            data-postdetail-gif
            className="fixed left-0 right-0 bg-bg-secondary border-t border-border z-40"
            style={{ height: 280 }}
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
      <div
        data-composer="postdetail"
        className="fixed left-0 right-0 bg-bg-primary border-t border-border px-4 py-3 flex items-center gap-3 z-40"
      >
        {(() => {
          const teamColor = post.team_id ? getTeamById(post.team_id)?.colorPrimary : undefined;
          return (
            <>
              {user && (
                <>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/gif"
                    className="hidden"
                    onChange={handleImageSelect}
                  />
                  <button
                    onClick={openImagePicker}
                    disabled={uploadingImage}
                    className="flex items-center justify-center w-9 h-9 shrink-0 rounded-full text-text-tertiary hover:text-text-primary disabled:opacity-50 transition-colors"
                    aria-label="이미지 업로드"
                  >
                    {uploadingImage ? <Loader2 size={20} className="animate-spin" /> : <ImagePlus size={20} />}
                  </button>
                  <button
                    onClick={() => {
                      if (uploadingImage) return;
                      setShowGifPicker((v) => !v);
                    }}
                    disabled={uploadingImage}
                    className={`flex items-center justify-center w-9 h-9 shrink-0 rounded-full disabled:opacity-50 transition-colors ${showGifPicker ? "bg-accent/20 text-accent" : "text-text-tertiary hover:text-text-primary"}`}
                    aria-label="GIF"
                  >
                    <ImagePlay size={20} />
                  </button>
                </>
              )}
              {user ? (
                <input
                  type="text"
                  value={comment}
                  onChange={e => setComment(e.target.value)}
                  placeholder={replyTo ? `${replyTo.nickname}에게 답글...` : "댓글을 입력하세요"}
                  className="flex-1 min-w-0 bg-bg-secondary rounded-xl px-4 py-2.5 text-sm text-text-primary placeholder:text-text-secondary focus:outline-none border"
                  style={{ borderColor: teamColor ? `${teamColor}80` : 'rgba(255,255,255,0.15)' }}
                  onFocus={() => setShowGifPicker(false)}
                  onKeyDown={e => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); handleComment(); } }}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setShowLogin(true)}
                  className="flex-1 min-w-0 bg-bg-secondary rounded-xl px-4 py-2.5 text-left text-sm text-text-secondary border"
                  style={{ borderColor: teamColor ? `${teamColor}80` : 'rgba(255,255,255,0.15)' }}
                >
                  로그인 후 댓글 작성 가능
                </button>
              )}
              <button onClick={handleComment} disabled={!comment.trim() || !user} className="w-9 h-9 shrink-0 rounded-full flex items-center justify-center text-white disabled:opacity-50 transition-opacity" style={{ backgroundColor: post.team_id ? (() => { const t = getTeamById(post.team_id); return t ? getTeamBgColor(t) : '#FF453A'; })() : '#FF453A' }}>
                <Send size={16} />
              </button>
            </>
          );
        })()}
      </div>
      <ReportSheet isOpen={showReport} onClose={() => setShowReport(false)} targetType={reportTarget.type} targetId={reportTarget.id} />
      {showLogin && <LoginSheet isOpen={showLogin} onClose={() => setShowLogin(false)} />}
      <ShareSheet
        isOpen={shareOpen}
        post={
          shareOpen
            ? ({
                id: post.id,
                title: post.title,
                content: post.content,
                videoUrl: post.video_urls?.[0] ?? null,
                board_type: post.board_type,
                board_id: post.board_id,
              } satisfies ShareSheetPost)
            : null
        }
        onClose={() => setShareOpen(false)}
      />
      <CommentImageLightbox src={cmtLightboxSrc} onClose={() => setCmtLightboxSrc(null)} />
    </div>
  );
}

/** 기존 글 title을 본문 앞에 합침(피드 mergedBody와 동일). 신규 글은 title="" → content만.
 *  움짤콜렉터 등 title===content(또는 본문이 제목으로 시작)인 글은 중복 방지(③). */
function mergeTitleBody(title: string | null | undefined, content: string | null | undefined): string {
  const t = (title ?? "").trim();
  const c = (content ?? "").trim();
  if (!t) return c;
  if (!c) return t;
  if (c === t || c.startsWith(t)) return c;
  return `${t}\n${c}`;
}

/** Strip URLs from text (OG cards handle link display). Trims leftover blank lines. */
function stripUrls(text: string): string {
  return text
    .replace(/(?:https?:\/\/|www\.)[^\s<>"')\]]+/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
