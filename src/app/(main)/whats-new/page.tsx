"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useSafeBack } from "@/lib/hooks/useSafeBack";
import { ArrowLeft, Sparkles, ChevronRight, MessageCircle, Heart } from "lucide-react";
import HeaderProfileLink from "@/components/ui/HeaderProfileLink";
import GlassCard from "@/components/ui/GlassCard";
import CommentSheet from "@/components/community/CommentSheet";
import LoginSheet from "@/components/auth/LoginSheet";
import { supabase } from "@/lib/supabase/client";
import { toggleLike } from "@/lib/supabase/usePosts";
import { isAnnouncementVisible } from "@/lib/announcements/visibility";

interface Announcement {
  id: string;
  title: string;
  summary: string;
  body: string;
  cta_label: string | null;
  cta_path: string | null;
  published_at: string;
  post_id: number | null;
  target_platform?: string;
}

/** HTML-escape to prevent XSS from admin-authored content */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 본문 한 줄짜리 이미지 마커: ![alt](url) */
const IMG_LINE = /^!\[([^\]]*)\]\(([^\s)]+)\)\s*$/;

/** 우리 Supabase Storage 공개 photos 경로만 이미지로 렌더 (외부 tracking 이미지 차단) */
const ALLOWED_IMG_PREFIX = process.env.NEXT_PUBLIC_SUPABASE_URL
  ? `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/photos/`
  : "";

function isAllowedImageUrl(url: string): boolean {
  return ALLOWED_IMG_PREFIX !== "" && url.startsWith(ALLOWED_IMG_PREFIX);
}

/**
 * 본문을 텍스트/이미지 세그먼트로 파싱해 렌더.
 * 이미지 마커 줄은 <img>로, 나머지 텍스트는 기존처럼 줄바꿈 보존 렌더.
 * URL/텍스트는 React가 자동 이스케이프하므로 dangerouslySetInnerHTML 미사용.
 */
function renderBody(body: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let textBuf: string[] = [];

  const flushText = () => {
    if (textBuf.length === 0) return;
    const block = textBuf.join("\n").replace(/^\n+|\n+$/g, "");
    if (block) {
      nodes.push(
        <p
          key={`t-${nodes.length}`}
          className="text-sm text-text-secondary whitespace-pre-line leading-relaxed"
        >
          {block}
        </p>,
      );
    }
    textBuf = [];
  };

  for (const line of body.split("\n")) {
    const m = line.match(IMG_LINE);
    if (m && isAllowedImageUrl(m[2])) {
      flushText();
      const alt = m[1] || "";
      const src = m[2];
      nodes.push(
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={`i-${nodes.length}`}
          src={src}
          alt={alt}
          loading="lazy"
          className="my-3 w-full rounded-lg border border-[var(--color-border)]"
        />,
      );
    } else {
      textBuf.push(line);
    }
  }
  flushText();
  return nodes;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
}

export default function WhatsNewPage() {
  const router = useRouter();
  const goBack = useSafeBack("/");
  const pathname = usePathname();
  const [items, setItems] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [openPostId, setOpenPostId] = useState<number | null>(null);
  const [commentCounts, setCommentCounts] = useState<Record<number, number>>({});
  const [likeCounts, setLikeCounts] = useState<Record<number, number>>({});
  const [likedSet, setLikedSet] = useState<Set<number>>(new Set());
  const [showLogin, setShowLogin] = useState(false);

  useEffect(() => {
    fetch("/api/whats-new")
      .then((r) => r.json())
      .then(async (raw: Announcement[]) => {
        // 현재 플랫폼에 노출 가능한 공지만 (android_web 공지는 안드 모바일웹에서만)
        const data = raw.filter((a) => isAnnouncementVisible(a.target_platform));
        setItems(data);
        if (data.length > 0) {
          localStorage.setItem("whats-new-seen-id", data[0].id);
        }
        // 브리지 포스트들의 댓글 수·좋아요 수 일괄 조회
        const postIds = data.map((d) => d.post_id).filter((v): v is number => typeof v === "number");
        if (postIds.length === 0) return;

        const { data: posts } = await supabase
          .from("posts")
          .select("id, comment_count, like_count")
          .in("id", postIds);
        if (posts) {
          setCommentCounts(Object.fromEntries(posts.map((p) => [p.id as number, (p.comment_count as number) ?? 0])));
          setLikeCounts(Object.fromEntries(posts.map((p) => [p.id as number, (p.like_count as number) ?? 0])));
        }

        // 현재 유저가 좋아요한 새소식 조회
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
          const { data: likes } = await supabase
            .from("likes")
            .select("post_id")
            .eq("user_id", user.id)
            .in("post_id", postIds);
          if (likes) setLikedSet(new Set(likes.map((l) => l.post_id as number)));
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleToggleLike = async (postId: number) => {
    const wasLiked = likedSet.has(postId);
    // optimistic
    setLikedSet((prev) => {
      const next = new Set(prev);
      if (wasLiked) next.delete(postId); else next.add(postId);
      return next;
    });
    setLikeCounts((prev) => ({ ...prev, [postId]: Math.max(0, (prev[postId] ?? 0) + (wasLiked ? -1 : 1)) }));
    try {
      await toggleLike(postId);
    } catch (e) {
      // 롤백 + 로그인 필요 시 로그인 시트
      setLikedSet((prev) => {
        const next = new Set(prev);
        if (wasLiked) next.add(postId); else next.delete(postId);
        return next;
      });
      setLikeCounts((prev) => ({ ...prev, [postId]: Math.max(0, (prev[postId] ?? 0) + (wasLiked ? 1 : -1)) }));
      if (e instanceof Error && e.message.includes("로그인")) setShowLogin(true);
    }
  };

  return (
    <div className="min-h-screen px-5 pb-24">
      {/* Header */}
      <div className="sticky top-0 z-30 -mx-5 border-b border-border bg-bg-primary px-5" style={{ paddingTop: "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))", marginTop: "calc(var(--safe-area-inset-top, env(safe-area-inset-top, 0px)) * -1)" }}>
      <div className="min-h-[44px] flex items-center gap-3">
        <button onClick={goBack} aria-label="뒤로가기" className="flex h-11 w-11 items-center justify-center -ml-2.5 text-text-secondary">
          <ArrowLeft size={22} />
        </button>
        <h1 className="flex items-center gap-2 text-lg font-bold text-text-primary flex-1">
          <Sparkles size={18} className="text-amber-400" />
          새 소식
        </h1>
        <HeaderProfileLink />
      </div>
      </div>

      {loading ? (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="glass-card p-5 animate-pulse">
              <div className="h-4 w-2/3 rounded bg-white/10 mb-2" />
              <div className="h-3 w-full rounded bg-white/10 mb-1" />
              <div className="h-3 w-4/5 rounded bg-white/10" />
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="mt-20 text-center text-text-tertiary text-sm">
          아직 새 소식이 없어요
        </div>
      ) : (
        <div className="space-y-4">
          {items.map((item) => (
            <GlassCard key={item.id}>
              <div className="mb-1 text-xs text-text-tertiary">
                {formatDate(item.published_at)}
              </div>
              <h2 className="text-base font-semibold text-text-primary mb-2">
                {escapeHtml(item.title)}
              </h2>
              <div className="space-y-1">{renderBody(item.body)}</div>
              {item.cta_label && item.cta_path && item.cta_path !== pathname && (
                item.cta_path.startsWith("https://") ? (
                  // 외부 링크(앱스토어 등)는 새 탭 앵커로
                  <a
                    href={item.cta_path}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-4 inline-flex items-center gap-1 rounded-lg bg-white/10 px-4 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-white/15"
                  >
                    {escapeHtml(item.cta_label)}
                    <ChevronRight size={16} />
                  </a>
                ) : (
                  <button
                    onClick={() => router.push(item.cta_path!)}
                    className="mt-4 flex items-center gap-1 rounded-lg bg-white/10 px-4 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-white/15"
                  >
                    {escapeHtml(item.cta_label)}
                    <ChevronRight size={16} />
                  </button>
                )
              )}
              {item.post_id !== null && (
                <div className="mt-4 flex items-center gap-4">
                  <button
                    onClick={() => handleToggleLike(item.post_id!)}
                    className={`flex items-center gap-1.5 text-sm transition-colors ${
                      likedSet.has(item.post_id)
                        ? "text-red-400"
                        : "text-text-secondary hover:text-text-primary"
                    }`}
                  >
                    <Heart size={16} fill={likedSet.has(item.post_id) ? "currentColor" : "none"} />
                    {likeCounts[item.post_id] ?? 0}
                  </button>
                  <button
                    onClick={() => setOpenPostId(item.post_id)}
                    className="flex items-center gap-1.5 text-sm text-text-secondary transition-colors hover:text-text-primary"
                  >
                    <MessageCircle size={16} />
                    댓글 {commentCounts[item.post_id] ?? 0}
                  </button>
                </div>
              )}
            </GlassCard>
          ))}
        </div>
      )}

      <CommentSheet
        isOpen={openPostId !== null}
        onClose={() => setOpenPostId(null)}
        postId={openPostId}
        onCommentAdded={(postId) =>
          setCommentCounts((prev) => ({ ...prev, [postId]: (prev[postId] ?? 0) + 1 }))
        }
        onCommentDeleted={(postId, removedCount = 1) =>
          setCommentCounts((prev) => ({
            ...prev,
            [postId]: Math.max(0, (prev[postId] ?? 0) - removedCount),
          }))
        }
      />

      <LoginSheet isOpen={showLogin} onClose={() => setShowLogin(false)} />
    </div>
  );
}
