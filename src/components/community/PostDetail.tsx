"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, Heart, MessageCircle, Share2, Send, Flag, MoreHorizontal, Check } from "lucide-react";
import TeamBadge from "@/components/ui/TeamBadge";
import { GRADES } from "@/lib/constants/grades";
import { getAvatarPath } from "@/lib/constants/avatars";
import { usePostDetail, createComment, toggleLike, updatePost, deletePost, updateComment, deleteComment } from "@/lib/supabase/usePosts";
import ReportSheet from "@/components/community/ReportSheet";
import LinkPreview from "@/components/community/LinkPreview";
import { useAuth } from "@/lib/supabase/AuthContext";
import { getTeamById, getTeamBgColor } from "@/lib/constants/teams";
import { getTeamBorderColorById } from "@/lib/utils/team-border-color";
import DMButton from "@/components/ui/DMButton";

interface PostDetailProps {
  postId: number;
  headerTitle: string;
}

export default function PostDetail({ postId, headerTitle }: PostDetailProps) {
  const router = useRouter();
  const { user, profile } = useAuth();
  const [showReport, setShowReport] = useState(false);
  const [reportTarget, setReportTarget] = useState<{type: "post"|"comment"; id: number}>({type: "post", id: 0});
  const { post, comments, loading, liked, setLiked, setComments } = usePostDetail(postId);
  const [comment, setComment] = useState("");
  const [likeCount, setLikeCount] = useState(0);

  // Chat-layout keyboard handling:
  // 1) Toggle body.kbd-open based on composer focus (TabBar hidden via CSS).
  // 2) Track visualViewport to place composer precisely above the iOS accessory
  //    bar (⌃⌄✓). vv.height bottom = top of accessory bar, so setting composer
  //    `bottom: hiddenPx` snaps it flush.
  // 3) On keyboard open, scroll the anchor (last comment or post end) flush to
  //    the composer top so the user sees context while typing.
  //
  // focusLockRef: while composer is focused, block update() from calling close().
  // iOS fires the 50ms timer before the keyboard animation starts, which would
  // otherwise reset TabBar visibility mid-focus.
  const [keyboardInset, setKeyboardInset] = useState(0);
  const focusLockRef = useRef(false);
  const scrolledForFocusRef = useRef(false);
  const postBodyEndRef = useRef<HTMLDivElement | null>(null);
  const commentsListEndRef = useRef<HTMLDivElement | null>(null);
  const commentsCountRef = useRef(0);
  commentsCountRef.current = comments.length;

  // Scroll anchor into view so it sits just above the composer.
  // Called once per focus session when the keyboard is fully up.
  const scrollAnchorIntoView = () => {
    const target = commentsCountRef.current > 0
      ? commentsListEndRef.current
      : postBodyEndRef.current;
    if (target) {
      // block:"end" aligns target's bottom edge with scroll container's bottom
      // (which is padded by composerHeight + keyboardInset), so the anchor
      // ends up just above the composer.
      target.scrollIntoView({ block: "end", behavior: "auto" });
    }
  };

  useEffect(() => {
    if (typeof window === "undefined" || !window.visualViewport) return;
    const vv = window.visualViewport;
    const open = () => document.body.classList.add("kbd-open");
    const close = () => document.body.classList.remove("kbd-open");
    const update = () => {
      // hidden = keyboard height + accessory bar height (everything below vv).
      // window.innerHeight is layout viewport; vv.height is visible viewport.
      const hidden = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      // <40px → treat as closed (browser chrome flicker).
      if (hidden > 40) {
        setKeyboardInset(hidden);
        open();
        // First time keyboard is fully up for this focus session → scroll anchor.
        if (focusLockRef.current && !scrolledForFocusRef.current) {
          scrolledForFocusRef.current = true;
          // Let composer `bottom: hidden` settle, then scroll.
          requestAnimationFrame(() => scrollAnchorIntoView());
        }
      } else {
        // Block close() while focused — prevents premature TabBar reappear
        // when the 50ms poll fires before iOS keyboard animation starts.
        if (focusLockRef.current) return;
        setKeyboardInset(0);
        close();
      }
    };
    // CRITICAL: always reset on mount. SPA navigation may leave stale kbd-open
    // from a previous page (e.g. community list → PostDetail transitions where
    // the unmount cleanup of the previous instance is racy).
    close();
    setKeyboardInset(0);
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    // iOS Safari: first focus often fires before vv.resize reports keyboard.
    // The "first tap shows nothing, second tap works" symptom is caused by this.
    // We poll update() at multiple offsets after every focusin to catch the
    // keyboard animation regardless of vv event timing.
    const onFocusIn = (e: FocusEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t || (t.tagName !== "INPUT" && t.tagName !== "TEXTAREA")) return;
      // Only composer input should trigger keyboard layout. Post-edit inputs
      // live in the scroll area and don't need the fixed composer treatment.
      if (!t.closest("[data-composer]")) return;
      focusLockRef.current = true;
      scrolledForFocusRef.current = false;
      // Optimistic: assume keyboard will open. Mark open immediately so the
      // TabBar hides before first paint, even if vv hasn't fired yet.
      open();
      [50, 150, 300, 600, 1000].forEach((ms) => setTimeout(update, ms));
    };
    const onFocusOut = (e: FocusEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t || (t.tagName !== "INPUT" && t.tagName !== "TEXTAREA")) return;
      if (!t.closest("[data-composer]")) return;
      focusLockRef.current = false;
      scrolledForFocusRef.current = false;
      // When composer loses focus, keyboard will dismiss. Force reset so the
      // TabBar reappears and container reclaims original height.
      setTimeout(update, 50);
      setTimeout(update, 300);
    };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      focusLockRef.current = false;
      close();
    };
  }, []);

  // 게시글 메뉴/편집 상태
  const [postMenuOpen, setPostMenuOpen] = useState(false);
  const [postEditing, setPostEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editContent, setEditContent] = useState("");
  const [savingPost, setSavingPost] = useState(false);
  const [deletingPost, setDeletingPost] = useState(false);
  const [postPatch, setPostPatch] = useState<{ title?: string; content?: string; updated_at?: string }>({});

  // 댓글 메뉴/편집 상태
  const [cmtMenuOpenId, setCmtMenuOpenId] = useState<number | null>(null);
  const [cmtEditingId, setCmtEditingId] = useState<number | null>(null);
  const [cmtEditInput, setCmtEditInput] = useState("");
  const [cmtSaving, setCmtSaving] = useState(false);

  if (loading) return <div className="flex items-center justify-center h-screen text-text-secondary">로딩 중...</div>;
  if (!post) return <div className="flex items-center justify-center h-screen text-text-secondary">게시글을 찾을 수 없습니다</div>;

  const isPostMine = !!user && post.author_id === user.id;

  function startPostEdit() {
    setPostMenuOpen(false);
    setEditTitle(post!.title);
    setEditContent(post!.content);
    setPostEditing(true);
  }

  function cancelPostEdit() {
    setPostEditing(false);
  }

  async function savePostEdit() {
    if (savingPost) return;
    const t = editTitle.trim();
    if (!t) { alert("제목을 입력해주세요"); return; }
    setSavingPost(true);
    try {
      await updatePost(post!.id, { title: t, content: editContent });
      setPostPatch({ title: t, content: editContent, updated_at: new Date().toISOString() });
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
      await deletePost(post!.id);
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
      await deleteComment(id);
      setComments(prev => prev.filter(c => c.id !== id));
    } catch {
      alert("댓글 삭제에 실패했어요");
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

  async function handleComment() {
    if (!user) { alert("로그인이 필요합니다"); return; }
    if (!comment.trim()) return;
    try {
      await createComment(post!.id, comment.trim());
      setComment("");
      setComments(prev => [...prev, {
        id: Date.now(),
        post_id: post!.id,
        author_id: user.id,
        content: comment.trim(),
        created_at: new Date().toISOString(),
        nickname: profile?.nickname ?? user?.user_metadata?.name ?? "나",
        team_id: profile?.team_id,
        grade: profile?.grade,
        avatar_url: profile?.avatar_url ?? undefined,
      }]);
    } catch {}
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
  // Composer is position:fixed and placed at `bottom: keyboardInset` so it docks
  // flush above the iOS accessory bar (or the TabBar when keyboard is closed).
  // TabBar is hidden via body.kbd-open (see globals.css).
  //
  // Reserve bottom padding on the scroll area = composer height (~64px) + inset,
  // so post/comments never hide beneath the composer.
  const composerHeight = 64; // approximate; matches py-3 + input height
  const scrollPaddingBottom = keyboardInset > 0
    ? `${composerHeight + keyboardInset}px`
    : `calc(${composerHeight}px + 4rem + env(safe-area-inset-bottom, 0px))`; // + TabBar when idle
  return (
    <div className="postdetail-chat-container flex flex-col bg-bg-primary">
      {/* Header (flex-none, stays at top) */}
      <div className="flex-none border-b border-border bg-bg-primary" style={{ borderColor: post.team_id ? getTeamBorderColorById(post.team_id) : undefined }}>
        <div className="flex items-center gap-3 px-4 py-3">
          <button onClick={() => router.back()}>
            <ChevronLeft size={24} className="text-text-secondary" />
          </button>
          <span className="text-lg font-semibold text-text-primary flex-1">{headerTitle}</span>
          <button onClick={async () => {
            if (navigator.share) await navigator.share({ title: post.title, url: window.location.href });
            else { await navigator.clipboard.writeText(window.location.href); alert("링크 복사됨!"); }
          }}>
            <Share2 size={20} className="text-text-tertiary" />
          </button>
        </div>
      </div>

      {/* Scrollable body: post + comments. Bottom padding reserves composer height + kbd inset. */}
      <div className="flex-1 overflow-y-auto overscroll-contain" style={{ paddingBottom: scrollPaddingBottom }}>

      {/* Post */}
      <div className="px-5 py-4">
        <div className="flex items-center gap-2 mb-3">
          {post.team_id ? <TeamBadge teamId={post.team_id} size="xs" /> : null}
          <span className="text-sm font-semibold text-text-primary cursor-pointer hover:text-accent" onClick={() => post.author_id && router.push(`/profile/${post.author_id}`)}>{post.nickname || "익명"}</span>
          {post.grade === 'staff' && (
            <span className='ml-1 px-1.5 py-0.5 text-[10px] font-bold bg-accent/20 text-accent rounded-full'>운영팀</span>
          )}
          {post.author_id && user && post.author_id !== user.id && (
            <DMButton targetUserId={post.author_id} size="sm" />
          )}
          <span className="text-xs text-text-tertiary ml-auto">
            {timeAgo(post.created_at)}{(postPatch.updated_at || post.updated_at) ? " · 수정됨" : ""}
          </span>
          {isPostMine && !postEditing && (
            <div className="relative">
              <button
                onClick={(e) => { e.stopPropagation(); setPostMenuOpen(v => !v); }}
                className="p-1 text-text-tertiary hover:text-text-primary"
                aria-label="게시글 메뉴"
                disabled={deletingPost}
              >
                <MoreHorizontal size={18} />
              </button>
              {postMenuOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setPostMenuOpen(false)} />
                  <div className="absolute right-0 top-8 z-20 min-w-[112px] rounded-lg border border-border bg-bg-primary shadow-lg overflow-hidden">
                    <button onClick={startPostEdit} className="block w-full px-3 py-2 text-left text-sm text-text-primary hover:bg-bg-tertiary">수정</button>
                    <button onClick={handleDeletePost} className="block w-full px-3 py-2 text-left text-sm text-[#FF453A] hover:bg-bg-tertiary">삭제</button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {postEditing ? (
          <div className="space-y-2 mb-3">
            <input
              type="text"
              value={editTitle}
              onChange={e => setEditTitle(e.target.value)}
              placeholder="제목"
              className="w-full bg-bg-secondary rounded-lg px-3 py-2 text-base text-text-primary outline-none border border-border"
            />
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
                disabled={savingPost || !editTitle.trim()}
                className="px-4 py-2 rounded-lg text-sm font-semibold text-white disabled:opacity-50"
                style={{ backgroundColor: post.team_id ? (() => { const t = getTeamById(post.team_id); return t ? getTeamBgColor(t) : '#FF453A'; })() : '#FF453A' }}
              >
                {savingPost ? "저장 중..." : "저장"}
              </button>
              <button onClick={cancelPostEdit} className="px-4 py-2 rounded-lg text-sm text-text-secondary hover:bg-bg-tertiary">취소</button>
            </div>
          </div>
        ) : (
          <>
            <h1 className="text-lg font-bold text-text-primary mb-3">{postPatch.title ?? post.title}</h1>
            <p className="readable-body whitespace-pre-line">{stripUrls(postPatch.content ?? post.content)}</p>
          </>
        )}

        {/* Link previews (수정된 content 반영) */}
        <LinkPreview text={postPatch.content ?? post.content} maxPreviews={3} />

        {/* Images */}
        {post.image_urls.length > 0 && (
          <div className="mt-4 space-y-2">
            {post.image_urls.map((url: string, i: number) => (
              <img key={i} src={url} alt="" className="rounded-xl w-full" />
            ))}
          </div>
        )}

        {/* Videos */}
        {post.video_urls && post.video_urls.length > 0 && (
          <div className="mt-4 space-y-2">
            {post.video_urls.map((url: string, i: number) => (
              <video
                key={i}
                src={url}
                controls
                playsInline
                className="rounded-xl w-full"
                style={{ backgroundColor: "#000" }}
              />
            ))}
          </div>
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
        {/* Scroll anchor: end of post body. Used when there are no comments. */}
        <div ref={postBodyEndRef} aria-hidden="true" />
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
            comments.map(c => {
              const grade = GRADES.find((g) => g.id === c.grade) ?? GRADES[0];
              const avatarPath = getAvatarPath(c.avatar_url ?? null);
              const isCmtMine = !!user && c.author_id === user.id;
              const isCmtEditing = cmtEditingId === c.id;
              const isCmtEdited = !!c.updated_at;
              return (
                <div key={c.id} className="flex gap-2.5">
                  {avatarPath ? (
                    <div className="w-8 h-8 rounded-full overflow-hidden flex-shrink-0 bg-bg-tertiary cursor-pointer" onClick={() => c.author_id && router.push(`/profile/${c.author_id}`)}>
                      <img src={avatarPath} alt="" className="w-full h-full" />
                    </div>
                  ) : (
                    <div
                      className="w-8 h-8 rounded-full flex items-center justify-center text-sm flex-shrink-0 cursor-pointer"
                      style={{ backgroundColor: grade.bgColor }}
                      onClick={() => c.author_id && router.push(`/profile/${c.author_id}`)}
                    >
                      {grade.emoji}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-semibold text-text-primary cursor-pointer hover:text-accent" onClick={() => c.author_id && router.push(`/profile/${c.author_id}`)}>{c.nickname || "익명"}</span>
                      <span
                        className="text-[10px] font-bold px-1.5 py-0.5 rounded-md"
                        style={{ color: grade.color, backgroundColor: grade.bgColor }}
                      >
                        {grade.name}
                      </span>
                      <span className="text-xs text-text-tertiary ml-auto flex-shrink-0">
                        {timeAgo(c.created_at)}{isCmtEdited ? " · 수정됨" : ""}
                      </span>
                      {isCmtMine && !isCmtEditing && (
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
                                <button onClick={() => startCmtEdit(c)} className="block w-full px-3 py-2 text-left text-xs text-text-primary hover:bg-bg-tertiary">수정</button>
                                <button onClick={() => handleDeleteComment(c.id)} className="block w-full px-3 py-2 text-left text-xs text-[#FF453A] hover:bg-bg-tertiary">삭제</button>
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
                      <p className="readable-body mt-0.5 break-words">{c.content}</p>
                    )}
                  </div>
                </div>
              );
            })
          )}
          {/* Scroll anchor: end of comments list. Used when there is >=1 comment. */}
          <div ref={commentsListEndRef} aria-hidden="true" />
        </div>
      </div>

      </div> {/* end scrollable body */}

      {/*
        Comment Input — fixed to viewport bottom, offset by visualViewport to
        sit flush above iOS keyboard + accessory bar. When keyboard is closed,
        bottom=0 means "above TabBar" since TabBar is visible and has its own
        z-index (composer z-40 stays under TabBar z-50 visually because the
        layout container is shorter than 100svh in idle state).
      */}
      <div
        data-composer="postdetail"
        className="fixed left-0 right-0 bg-bg-primary border-t border-border px-4 py-3 flex items-center gap-3 z-40"
        style={{
          bottom: keyboardInset > 0
            ? `${keyboardInset}px`
            : `calc(4rem + env(safe-area-inset-bottom, 0px))`,
          paddingBottom: keyboardInset > 0
            ? undefined
            : "0.75rem",
          transition: "bottom 80ms ease-out",
        }}
      >
        {(() => {
          const teamColor = post.team_id ? getTeamById(post.team_id)?.colorPrimary : undefined;
          return (
            <>
              <input
                type="text"
                value={comment}
                onChange={e => setComment(e.target.value)}
                placeholder={user ? "댓글을 입력하세요" : "로그인 후 댓글 작성 가능"}
                disabled={!user}
                className="flex-1 bg-bg-secondary rounded-xl px-4 py-2.5 text-sm text-text-primary placeholder:text-text-secondary focus:outline-none border"
                style={{ borderColor: teamColor ? `${teamColor}80` : 'rgba(255,255,255,0.15)' }}
                onFocus={() => document.body.classList.add("kbd-open")}
                onBlur={() => document.body.classList.remove("kbd-open")}
                onKeyDown={e => e.key === "Enter" && handleComment()}
              />
              <button onClick={handleComment} disabled={!comment.trim() || !user} className="w-9 h-9 rounded-full flex items-center justify-center text-white disabled:opacity-50 transition-opacity" style={{ backgroundColor: post.team_id ? (() => { const t = getTeamById(post.team_id); return t ? getTeamBgColor(t) : '#FF453A'; })() : '#FF453A' }}>
                <Send size={16} />
              </button>
            </>
          );
        })()}
      </div>
      <ReportSheet isOpen={showReport} onClose={() => setShowReport(false)} targetType={reportTarget.type} targetId={reportTarget.id} />
    </div>
  );
}

/** Strip URLs from text (OG cards handle link display). Trims leftover blank lines. */
function stripUrls(text: string): string {
  return text
    .replace(/(?:https?:\/\/|www\.)[^\s<>"')\]]+/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
