"use client";

import { useState, useCallback } from "react";
import Image from "next/image";
import Link from "next/link";
import { motion } from "framer-motion";
import { MessageCircle, MoreHorizontal } from "lucide-react";
import { getTeamById, getTeamBySlug } from "@/lib/constants/teams";
import PLAYERS_ROSTER from "@/lib/constants/players-roster.json";
import { parsePlayerTag } from "@/lib/utils/player-tags";
import TeamBadge from "@/components/ui/TeamBadge";
import LevelBadge from "@/components/ui/LevelBadge";
import TeamLogo from "@/components/ui/TeamLogo";
import LinkPreview from "@/components/community/LinkPreview";
import type { Post } from "@/lib/supabase/usePosts";
import { deletePost } from "@/lib/supabase/usePosts";
import { useAuth } from "@/lib/supabase/AuthContext";
import type { CommunitySourceLabel } from "@/lib/utils/community-board";
import CommentSheet from "./CommentSheet";
import { timeAgo, PhotoCarousel, HeartOverlay, CaptionBlock } from "./PhotoFeedParts";
import { hasHeroImage } from "@/components/player/PlayerHero";

/* ── Types ── */

export type BoardContext =
  | { type: "team"; teamId: number }
  | { type: "player"; teamId: number; playerName: string; kboId: string }
  | { type: "free" }
  | { type: "global" };

interface UnifiedFeedProps {
  posts: Post[];
  loading: boolean;
  onLike: (postId: number) => void;
  boardContext: BoardContext;
  sourceLabels?: Record<number, CommunitySourceLabel>;
}

/* ── Helpers ── */

function stripUrls(text: string): string {
  return text
    .replace(/(?:https?:\/\/|www\.)[^\s<>"')\]]+/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function hasUrl(text: string): boolean {
  return /(?:https?:\/\/|www\.)[^\s<>"')\]]+/.test(text);
}

function isShortText(post: Post): boolean {
  if (post.content_type !== "general") return false;
  if (post.image_urls.length > 0) return false;
  if (post.video_urls && post.video_urls.length > 0) return false;
  if (hasUrl(post.content)) return false;
  const stripped = stripUrls(post.content);
  if (stripped.length > 80) return false;
  // Max 3 lines
  const lines = stripped.split("\n").length;
  if (lines > 3) return false;
  return true;
}

function findPlayerByKboId(kboId: string): { teamId: number } | null {
  for (const p of PLAYERS_ROSTER) {
    if (p.kboId === kboId) return { teamId: p.teamId };
  }
  return null;
}

function findPlayerByName(name: string): { kboId: string; teamId: number } | null {
  for (const p of PLAYERS_ROSTER) {
    if (p.name === name) return { kboId: p.kboId, teamId: p.teamId };
  }
  return null;
}

/* ── Stagger animation ── */

const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.03 } },
};

const item = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.2 } },
};

/* ── Main Component ── */

export default function UnifiedFeed({ posts, loading, onLike, boardContext, sourceLabels }: UnifiedFeedProps) {
  const { user } = useAuth();
  const [likedPosts, setLikedPosts] = useState<Set<number>>(new Set());
  const [heartPostId, setHeartPostId] = useState<number | null>(null);
  const [commentPostId, setCommentPostId] = useState<number | null>(null);
  const [commentTeamId, setCommentTeamId] = useState<number | null>(null);
  const [commentDeltas, setCommentDeltas] = useState<Record<number, number>>({});
  const [menuOpenId, setMenuOpenId] = useState<number | null>(null);
  const [deletedIds, setDeletedIds] = useState<Set<number>>(new Set());
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  // Inline comment expand state
  const [inlineCommentIds, setInlineCommentIds] = useState<Set<number>>(new Set());

  const handleDelete = useCallback(async (postId: number) => {
    setMenuOpenId(null);
    if (!confirm("이 게시글을 삭제할까요? 댓글/좋아요도 함께 삭제됩니다.")) return;
    try {
      await deletePost(postId);
      setDeletedIds(prev => { const n = new Set(prev); n.add(postId); return n; });
    } catch {
      alert("게시글 삭제에 실패했어요");
    }
  }, []);

  const handleLike = (postId: number) => {
    setLikedPosts((prev) => {
      const next = new Set(prev);
      if (next.has(postId)) next.delete(postId);
      else next.add(postId);
      return next;
    });
    onLike(postId);
  };

  const handleDoubleTap = (postId: number) => {
    if (!likedPosts.has(postId)) {
      handleLike(postId);
    }
    setHeartPostId(postId);
    setTimeout(() => setHeartPostId(null), 800);
  };

  const openComments = (postId: number, teamId?: number | null) => {
    setCommentPostId(postId);
    setCommentTeamId(teamId ?? null);
  };

  if (loading) {
    return (
      <div className="divide-y divide-white/[0.02]">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="p-4 animate-pulse">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-8 h-8 rounded-full bg-bg-tertiary" />
              <div className="h-4 bg-bg-tertiary rounded w-24" />
            </div>
            <div className="h-20 bg-bg-tertiary rounded-xl" />
          </div>
        ))}
      </div>
    );
  }

  if (posts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-text-tertiary">
        <p className="text-base">아직 글이 없어요.</p>
        <p className="mt-1 text-sm">첫 번째 글을 작성해보세요!</p>
      </div>
    );
  }

  return (
    <div>
      <motion.div variants={container} initial="hidden" animate="show">
        {posts.map((post, index) => {
          if (deletedIds.has(post.id)) return null;

          const isLiked = likedPosts.has(post.id);
          const isMine = !!user && post.author_id === user.id;

          // Determine card type
          if (post.content_type === "photo") {
            // Photo/media card
            return (
              <motion.div key={post.id} variants={item}>
                {index > 0 && <div className="h-2 bg-white/[0.02]" />}
                <PhotoCardBlock
                  post={post}
                  isLiked={isLiked}
                  isMine={isMine}
                  boardContext={boardContext}
                  sourceLabel={sourceLabels?.[post.id]}
                  menuOpenId={menuOpenId}
                  heartPostId={heartPostId}
                  commentDelta={commentDeltas[post.id] ?? 0}
                  onLike={() => handleLike(post.id)}
                  onDoubleTap={() => handleDoubleTap(post.id)}
                  onMenuToggle={(id) => setMenuOpenId(prev => prev === id ? null : id)}
                  onMenuClose={() => setMenuOpenId(null)}
                  onDelete={() => handleDelete(post.id)}
                  onOpenComments={() => openComments(post.id, post.team_id)}
                />
              </motion.div>
            );
          } else if (isShortText(post)) {
            // Short text card (Facebook-style)
            return (
              <motion.div key={post.id} variants={item}>
                {index > 0 && <div className="h-2 bg-white/[0.02]" />}
                <ShortTextCard
                  post={post}
                  isLiked={isLiked}
                  isMine={isMine}
                  boardContext={boardContext}
                  sourceLabel={sourceLabels?.[post.id]}
                  menuOpenId={menuOpenId}
                  commentDelta={commentDeltas[post.id] ?? 0}
                  onLike={() => handleLike(post.id)}
                  onMenuToggle={(id) => setMenuOpenId(prev => prev === id ? null : id)}
                  onMenuClose={() => setMenuOpenId(null)}
                  onDelete={() => handleDelete(post.id)}
                  onOpenComments={() => openComments(post.id, post.team_id)}
                />
              </motion.div>
            );
          } else {
            // Long text card (expandable)
            return (
              <motion.div key={post.id} variants={item}>
                {index > 0 && <div className="h-2 bg-white/[0.02]" />}
                <LongTextCard
                  post={post}
                  isLiked={isLiked}
                  isMine={isMine}
                  boardContext={boardContext}
                  sourceLabel={sourceLabels?.[post.id]}
                  menuOpenId={menuOpenId}
                  expanded={expandedIds.has(post.id)}
                  commentDelta={commentDeltas[post.id] ?? 0}
                  onExpand={() => setExpandedIds(prev => { const n = new Set(prev); n.add(post.id); return n; })}
                  onCollapse={() => setExpandedIds(prev => { const n = new Set(prev); n.delete(post.id); return n; })}
                  onLike={() => handleLike(post.id)}
                  onMenuToggle={(id) => setMenuOpenId(prev => prev === id ? null : id)}
                  onMenuClose={() => setMenuOpenId(null)}
                  onDelete={() => handleDelete(post.id)}
                  onOpenComments={() => openComments(post.id, post.team_id)}
                />
              </motion.div>
            );
          }
        })}
      </motion.div>

      {commentPostId !== null && (
        <CommentSheet
          isOpen={true}
          onClose={() => { setCommentPostId(null); setCommentTeamId(null); }}
          postId={commentPostId}
          teamId={commentTeamId}
          onCommentAdded={(postId) => {
            setCommentDeltas((prev) => ({ ...prev, [postId]: (prev[postId] ?? 0) + 1 }));
          }}
          onCommentDeleted={(postId) => {
            setCommentDeltas((prev) => ({ ...prev, [postId]: (prev[postId] ?? 0) - 1 }));
          }}
        />
      )}
    </div>
  );
}

/* ── Shared sub-components ── */

interface CardMenuProps {
  postId: number;
  isMine: boolean;
  menuOpenId: number | null;
  onMenuToggle: (id: number) => void;
  onMenuClose: () => void;
  onDelete: () => void;
}

function CardMenu({ postId, isMine, menuOpenId, onMenuToggle, onMenuClose, onDelete }: CardMenuProps) {
  if (!isMine) return null;
  return (
    <div className="relative flex-shrink-0">
      <button
        onClick={(e) => { e.stopPropagation(); onMenuToggle(postId); }}
        className="p-1 text-text-tertiary hover:text-text-primary"
        aria-label="게시글 메뉴"
      >
        <MoreHorizontal size={20} />
      </button>
      {menuOpenId === postId && (
        <>
          <div className="fixed inset-0 z-10" onClick={onMenuClose} />
          <div className="absolute right-0 top-8 z-20 min-w-[112px] rounded-lg border border-border bg-bg-primary shadow-lg overflow-hidden">
            <button
              onClick={onDelete}
              className="block w-full px-3 py-2 text-left text-sm text-[#FF453A] hover:bg-bg-tertiary"
            >
              삭제
            </button>
          </div>
        </>
      )}
    </div>
  );
}

interface AuthorRowProps {
  post: Post;
  boardContext: BoardContext;
  sourceLabel?: CommunitySourceLabel | null;
  isMine: boolean;
  menuOpenId: number | null;
  onMenuToggle: (id: number) => void;
  onMenuClose: () => void;
  onDelete: () => void;
}

function AuthorRow({ post, boardContext, sourceLabel, isMine, menuOpenId, onMenuToggle, onMenuClose, onDelete }: AuthorRowProps) {
  return (
    <>
      <div className="flex items-center gap-3 px-4 py-3">
        {post.team_id ? <TeamBadge teamId={post.team_id} /> : null}
        <span className="text-base font-medium text-text-primary truncate">
          {post.nickname || "익명"}
        </span>
        <LevelBadge points={post.points ?? 0} />
        {post.grade === "staff" && (
          <span className="ml-1 px-1.5 py-0.5 text-[10px] font-bold bg-accent/20 text-accent rounded-full">
            운영팀
          </span>
        )}
        <span className="ml-auto text-base text-text-tertiary flex-shrink-0">
          {timeAgo(post.created_at)}{post.updated_at ? " · 수정됨" : ""}
        </span>
        <CardMenu
          postId={post.id}
          isMine={isMine}
          menuOpenId={menuOpenId}
          onMenuToggle={onMenuToggle}
          onMenuClose={onMenuClose}
          onDelete={onDelete}
        />
      </div>
      {sourceLabel && (
        <div className="px-4 pb-2">
          {sourceLabel.teamId ? (
            <TeamBadge teamId={sourceLabel.teamId} playerName={sourceLabel.playerName} size="xs" />
          ) : (
            <span className="inline-flex items-center rounded-full bg-bg-tertiary px-2 py-0.5 text-xs font-medium text-text-secondary">
              {sourceLabel.text}
            </span>
          )}
        </div>
      )}
    </>
  );
}

interface ActionBarProps {
  post: Post;
  isLiked: boolean;
  commentDelta: number;
  onLike: () => void;
  onOpenComments: () => void;
}

function ActionBar({ post, isLiked, commentDelta, onLike, onOpenComments }: ActionBarProps) {
  return (
    <div className="flex items-center gap-4 px-4 py-2.5">
      <button
        onClick={(e) => { e.stopPropagation(); onLike(); }}
        className="flex items-center gap-1 text-base transition-colors"
      >
        <span className="text-xl leading-none">{isLiked ? "❤️" : "♡"}</span>
        <span className={isLiked ? "text-red-500 font-medium" : "text-text-secondary"}>
          {post.like_count + (isLiked ? 1 : 0)}
        </span>
      </button>
      <button
        onClick={onOpenComments}
        className="flex items-center gap-1 text-base text-text-secondary"
      >
        <MessageCircle size={20} />
        <span>{post.comment_count + commentDelta}</span>
      </button>
    </div>
  );
}

/* ── Player tags + Hashtags (shared by PhotoCard and LongTextCard) ── */

function PostTags({ post }: { post: Post }) {
  return (
    <>
      {post.player_tags && Array.isArray(post.player_tags) && post.player_tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-4 pb-1">
          {(post.player_tags as string[]).map((tag: string) => {
            const { kboId, displayName } = parsePlayerTag(tag);
            let href: string | undefined;
            let team: ReturnType<typeof getTeamById> = undefined;
            if (kboId) {
              href = `/community/players/${kboId}`;
              const rosterEntry = findPlayerByKboId(kboId);
              team = rosterEntry ? getTeamById(rosterEntry.teamId) : undefined;
            } else {
              const player = findPlayerByName(displayName);
              if (player) {
                href = `/community/players/${player.kboId}`;
                team = getTeamById(player.teamId);
              }
            }
            const label = team ? `@${team.shortName} ${displayName}` : `@${displayName}`;
            return href ? (
              <Link key={tag} href={href} className="text-xs font-medium text-text-secondary bg-bg-tertiary px-2 py-0.5 rounded-full active:bg-bg-quaternary transition-colors">
                {label}
              </Link>
            ) : (
              <span key={tag} className="text-xs font-medium text-text-secondary bg-bg-tertiary px-2 py-0.5 rounded-full">
                {label}
              </span>
            );
          })}
        </div>
      )}
      {post.hashtags && Array.isArray(post.hashtags) && post.hashtags.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-4 pb-1">
          {(post.hashtags as string[]).map((tag: string) => (
            <span key={tag} className="text-xs text-accent font-medium">{tag}</span>
          ))}
        </div>
      )}
    </>
  );
}

/* ── Short Text Card ── */

interface ShortTextCardProps {
  post: Post;
  isLiked: boolean;
  isMine: boolean;
  boardContext: BoardContext;
  sourceLabel?: CommunitySourceLabel | null;
  menuOpenId: number | null;
  commentDelta: number;
  onLike: () => void;
  onMenuToggle: (id: number) => void;
  onMenuClose: () => void;
  onDelete: () => void;
  onOpenComments: () => void;
}

function ShortTextCard({
  post, isLiked, isMine, boardContext, sourceLabel,
  menuOpenId, commentDelta,
  onLike, onMenuToggle, onMenuClose, onDelete, onOpenComments,
}: ShortTextCardProps) {
  // Determine background based on board context
  let bgStyle: React.CSSProperties = {};
  let watermark: React.ReactNode = null;

  if (boardContext.type === "team") {
    const team = getTeamById(boardContext.teamId);
    if (team) {
      bgStyle = { background: `linear-gradient(135deg, ${team.colorPrimary}22, ${team.colorPrimary}08)` };
      watermark = (
        <div className="absolute bottom-2 right-2 opacity-[0.07] pointer-events-none select-none">
          <TeamLogo team={team} size={64} className="bg-transparent" />
        </div>
      );
    }
  } else if (boardContext.type === "player") {
    const team = getTeamById(boardContext.teamId);
    if (team) {
      bgStyle = { background: `linear-gradient(135deg, ${team.colorPrimary}22, ${team.colorPrimary}08)` };
      if (hasHeroImage(boardContext.kboId)) {
        watermark = (
          <div className="absolute bottom-0 right-0 opacity-[0.08] pointer-events-none select-none overflow-hidden" style={{ width: 80, height: 100 }}>
            <Image
              src={`/players/hero/${boardContext.kboId}.png`}
              alt=""
              width={80}
              height={100}
              className="object-contain object-bottom"
              unoptimized
            />
          </div>
        );
      } else {
        watermark = (
          <div className="absolute bottom-1 right-3 pointer-events-none select-none opacity-[0.06]">
            <span className="text-[64px] font-black leading-none" style={{ color: team.colorPrimary }}>
              {boardContext.playerName.charAt(0)}
            </span>
          </div>
        );
      }
    }
  } else if (boardContext.type === "free") {
    // Neutral dark background with subtle accent if author has a team
    const authorTeam = post.team_id ? getTeamById(post.team_id) : undefined;
    bgStyle = {
      background: "var(--color-bg-secondary)",
      borderLeft: authorTeam ? `2px solid ${authorTeam.colorPrimary}40` : undefined,
    };
  } else if (boardContext.type === "global") {
    // Global feed — derive context from post's board_type
    if (post.board_type === "team" && post.board_id) {
      const team = getTeamBySlug(post.board_id);
      if (team) {
        bgStyle = { background: `linear-gradient(135deg, ${team.colorPrimary}22, ${team.colorPrimary}08)` };
      }
    } else {
      const authorTeam = post.team_id ? getTeamById(post.team_id) : undefined;
      bgStyle = {
        background: "var(--color-bg-secondary)",
        borderLeft: authorTeam ? `2px solid ${authorTeam.colorPrimary}40` : undefined,
      };
    }
  }

  return (
    <div className="overflow-hidden">
      <AuthorRow
        post={post} boardContext={boardContext} sourceLabel={sourceLabel}
        isMine={isMine} menuOpenId={menuOpenId}
        onMenuToggle={onMenuToggle} onMenuClose={onMenuClose} onDelete={onDelete}
      />
      {/* Short text content with themed background */}
      <div className="relative mx-4 mb-2 rounded-2xl overflow-hidden" style={bgStyle}>
        {watermark}
        <div className="relative z-[1] px-5 py-6 flex items-center justify-center min-h-[120px]">
          <p className="text-lg font-semibold text-text-primary text-center leading-relaxed whitespace-pre-line">
            {post.title ? `${post.title}\n` : ""}{post.content}
          </p>
        </div>
      </div>
      <ActionBar post={post} isLiked={isLiked} commentDelta={commentDelta} onLike={onLike} onOpenComments={onOpenComments} />
    </div>
  );
}

/* ── Long Text Card ── */

interface LongTextCardProps {
  post: Post;
  isLiked: boolean;
  isMine: boolean;
  boardContext: BoardContext;
  sourceLabel?: CommunitySourceLabel | null;
  menuOpenId: number | null;
  expanded: boolean;
  commentDelta: number;
  onExpand: () => void;
  onCollapse: () => void;
  onLike: () => void;
  onMenuToggle: (id: number) => void;
  onMenuClose: () => void;
  onDelete: () => void;
  onOpenComments: () => void;
}

function LongTextCard({
  post, isLiked, isMine, boardContext, sourceLabel,
  menuOpenId, expanded, commentDelta,
  onExpand, onCollapse, onLike, onMenuToggle, onMenuClose, onDelete, onOpenComments,
}: LongTextCardProps) {
  const strippedContent = stripUrls(post.content);

  return (
    <div className="overflow-hidden">
      <AuthorRow
        post={post} boardContext={boardContext} sourceLabel={sourceLabel}
        isMine={isMine} menuOpenId={menuOpenId}
        onMenuToggle={onMenuToggle} onMenuClose={onMenuClose} onDelete={onDelete}
      />
      <div className="px-4 pb-2">
        {/* Title */}
        {post.title && (
          <h3 className="text-base font-semibold text-text-primary mb-1">
            {post.title}
          </h3>
        )}
        {/* Content */}
        {expanded ? (
          <>
            <p className="text-base text-text-secondary whitespace-pre-line">{strippedContent}</p>
            <button onClick={onCollapse} className="text-sm text-text-tertiary mt-1">접기</button>
          </>
        ) : (
          <>
            <p className="text-base text-text-secondary line-clamp-3 whitespace-pre-line">{strippedContent}</p>
            {strippedContent.length > 80 && (
              <button onClick={onExpand} className="text-sm text-text-tertiary mt-1">더 보기</button>
            )}
          </>
        )}
        {/* Link previews */}
        <LinkPreview text={post.content} maxPreviews={2} stopPropagation />
      </div>
      {/* Image thumbnails for general posts with images */}
      {post.image_urls.length > 0 && (
        <div className="px-4 pb-2 flex gap-2 overflow-hidden">
          {post.image_urls.slice(0, 3).map((url, i) => (
            <div key={i} className="h-20 w-20 flex-shrink-0 rounded-lg bg-bg-tertiary overflow-hidden">
              <Image src={url} alt="" width={80} height={80} className="w-full h-full object-cover" unoptimized />
            </div>
          ))}
          {post.image_urls.length > 3 && (
            <div className="h-20 w-20 flex-shrink-0 rounded-lg bg-bg-tertiary flex items-center justify-center text-text-tertiary text-sm">
              +{post.image_urls.length - 3}
            </div>
          )}
        </div>
      )}
      <ActionBar post={post} isLiked={isLiked} commentDelta={commentDelta} onLike={onLike} onOpenComments={onOpenComments} />
      <PostTags post={post} />
    </div>
  );
}

/* ── Photo Card ── */

interface PhotoCardBlockProps {
  post: Post;
  isLiked: boolean;
  isMine: boolean;
  boardContext: BoardContext;
  sourceLabel?: CommunitySourceLabel | null;
  menuOpenId: number | null;
  heartPostId: number | null;
  commentDelta: number;
  onLike: () => void;
  onDoubleTap: () => void;
  onMenuToggle: (id: number) => void;
  onMenuClose: () => void;
  onDelete: () => void;
  onOpenComments: () => void;
}

function PhotoCardBlock({
  post, isLiked, isMine, boardContext, sourceLabel,
  menuOpenId, heartPostId, commentDelta,
  onLike, onDoubleTap, onMenuToggle, onMenuClose, onDelete, onOpenComments,
}: PhotoCardBlockProps) {
  return (
    <div className="overflow-hidden">
      <AuthorRow
        post={post} boardContext={boardContext} sourceLabel={sourceLabel}
        isMine={isMine} menuOpenId={menuOpenId}
        onMenuToggle={onMenuToggle} onMenuClose={onMenuClose} onDelete={onDelete}
      />
      {/* Media carousel */}
      {(post.image_urls.length > 0 || (post.video_urls && post.video_urls.length > 0)) && (
        <div className="relative">
          <PhotoCarousel
            slides={[
              ...post.image_urls.map((url) => ({ url, isVideo: false })),
              ...(post.video_urls ?? []).map((url) => ({ url, isVideo: true })),
            ]}
            onDoubleTap={onDoubleTap}
          />
          <HeartOverlay show={heartPostId === post.id} />
        </div>
      )}
      <ActionBar post={post} isLiked={isLiked} commentDelta={commentDelta} onLike={onLike} onOpenComments={onOpenComments} />
      {/* Caption */}
      {post.content && (
        <CaptionBlock
          nickname={post.nickname || "익명"}
          content={post.content}
          onPress={onOpenComments}
        />
      )}
      <PostTags post={post} />
    </div>
  );
}
