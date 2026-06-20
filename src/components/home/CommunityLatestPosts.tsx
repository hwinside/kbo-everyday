"use client";

import { useState } from "react";
import Link from "next/link";
import { MessageCircle, Heart, ChevronRight, MessagesSquare } from "lucide-react";
import { useUnifiedFeed } from "@/lib/supabase/useUnifiedFeed";
import { getPostDetailPath } from "@/lib/utils/post-share";
import { getTeamBySlug } from "@/lib/constants/teams";
import { getPlayerPhotoByKboId } from "@/lib/constants/player-photos";
import TeamBadge from "@/components/ui/TeamBadge";
import heroApprovedList from "@/lib/constants/hero-approved-kboids.json";
import type { Post } from "@/lib/supabase/usePosts";

const HERO_APPROVED = new Set<string>(heroApprovedList as string[]);

const HOME_LATEST_COUNT = 5;

function timeAgo(dateStr: string): string {
  const mins = Math.floor((Date.now() - new Date(dateStr).getTime()) / 60000);
  if (mins < 1) return "방금";
  if (mins < 60) return `${mins}분 전`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}일 전`;
  return `${Math.floor(days / 30)}개월 전`;
}

/** 본문 요약 1줄 — 제목 우선, 없으면 본문 첫 줄. */
function summaryLine(post: Post): string {
  const title = post.title?.trim();
  if (title) return title;
  const firstLine = post.content?.trim().split(/\r?\n/).find((l) => l.trim());
  return firstLine?.trim() ?? "";
}

type Thumb =
  | { kind: "image"; src: string }
  | { kind: "logo"; src: string }
  | { kind: "none" };

/**
 * 썸네일 우선순위 (하린아빠 스펙):
 *   사진글 사진 썸네일 > 선수글 히어로샷 > 팀글 팀 로고 > 기본(아이콘 타일).
 * 이미지 로드 실패 시 onError로 아이콘 타일 fallback (320px·깨진 에셋 대비).
 */
function resolveThumb(post: Post): Thumb {
  const img = post.image_urls?.[0];
  if (img) return { kind: "image", src: img };

  if (post.board_type === "player" && post.board_id) {
    const hero = HERO_APPROVED.has(post.board_id)
      ? `/players-hero/${post.board_id}.webp`
      : getPlayerPhotoByKboId(post.board_id);
    if (hero) return { kind: "image", src: hero };
  }

  if (post.board_type === "team" && post.board_id) {
    const team = getTeamBySlug(post.board_id);
    if (team) return { kind: "logo", src: team.logoPath };
  }

  return { kind: "none" };
}

function IconTile() {
  return (
    <div className="w-full h-full flex items-center justify-center bg-bg-tertiary">
      <MessagesSquare size={22} className="text-text-tertiary" />
    </div>
  );
}

function PostRow({ post }: { post: Post }) {
  const [imgFailed, setImgFailed] = useState(false);
  const thumb = resolveThumb(post);
  const summary = summaryLine(post);

  return (
    <Link
      href={getPostDetailPath(post)}
      className="flex items-center gap-3 py-2.5 active:opacity-70 transition-opacity"
    >
      {/* 썸네일 56x56 */}
      <div className="w-14 h-14 shrink-0 rounded-xl overflow-hidden bg-bg-tertiary">
        {thumb.kind === "none" || imgFailed ? (
          <IconTile />
        ) : thumb.kind === "logo" ? (
          <div className="w-full h-full flex items-center justify-center bg-bg-tertiary p-2.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={thumb.src}
              alt=""
              className="w-full h-full object-contain"
              onError={() => setImgFailed(true)}
            />
          </div>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={thumb.src}
            alt=""
            className="w-full h-full object-cover"
            onError={() => setImgFailed(true)}
          />
        )}
      </div>

      {/* 본문 요약 + 메타 */}
      <div className="flex-1 min-w-0">
        <p className="text-[14px] leading-[20px] font-medium text-text-primary line-clamp-1">
          {summary || "(내용 없음)"}
        </p>
        <div className="flex items-center gap-1.5 mt-1 text-[11px] leading-[16px] text-text-tertiary">
          {post.team_id ? <TeamBadge teamId={post.team_id} size="xs" /> : null}
          <span className="truncate min-w-0">{post.nickname ?? "익명"}</span>
          <span className="shrink-0">·</span>
          <span className="shrink-0">{timeAgo(post.created_at)}</span>
          <span className="shrink-0 flex items-center gap-0.5 ml-auto pl-1">
            <MessageCircle size={12} />
            {post.comment_count ?? 0}
          </span>
          <span className="shrink-0 flex items-center gap-0.5">
            <Heart size={12} />
            {post.like_count ?? 0}
          </span>
        </div>
      </div>
    </Link>
  );
}

/**
 * 홈 '커뮤니티 최신글' 섹션 — 커뮤니티 유입 레버.
 * 전체 통합피드(자유+팀+선수) 최신 5개를 세로 compact 리스트로 노출.
 * 신규 API·테이블 없이 useUnifiedFeed를 재사용한다.
 */
export default function CommunityLatestPosts() {
  const { posts, loading } = useUnifiedFeed({ kind: "all" }, HOME_LATEST_COUNT);

  // 로딩 중이거나 글이 없으면 섹션 자체를 숨김(빈 박스 방지) — 뉴스 섹션과 동일 패턴.
  if (loading || posts.length === 0) return null;

  const latest = posts.slice(0, HOME_LATEST_COUNT);

  return (
    <section>
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-[15px] font-bold text-text-primary">커뮤니티 최신글</h2>
        <Link
          href="/community/all-posts"
          className="flex items-center text-xs text-text-tertiary active:opacity-70 transition-opacity"
        >
          더보기 <ChevronRight size={14} />
        </Link>
      </div>

      <div className="divide-y divide-black/5 dark:divide-white/5">
        {latest.map((post) => (
          <PostRow key={post.id} post={post} />
        ))}
      </div>

      <Link
        href="/community/all-posts"
        className="mt-2 flex items-center justify-center gap-1 w-full py-2.5 rounded-xl bg-bg-secondary text-[13px] font-medium text-text-secondary active:scale-[0.99] transition-transform"
      >
        커뮤니티 더보기 <ChevronRight size={15} />
      </Link>
    </section>
  );
}
