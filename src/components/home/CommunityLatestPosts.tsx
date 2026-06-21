"use client";

import { useState } from "react";
import Link from "next/link";
import { MessageCircle, Heart, ChevronRight, MessagesSquare } from "lucide-react";
import { useUnifiedFeed } from "@/lib/supabase/useUnifiedFeed";
import { getPostDetailPath } from "@/lib/utils/post-share";
import { getTeamBySlug } from "@/lib/constants/teams";
import { getTeamColor } from "@/lib/utils/team";
import { getPlayerPhotoByKboId } from "@/lib/constants/player-photos";
import { teamIdForKboId, resolveRosterPlayer } from "@/lib/utils/player-roster";
import TeamBadge from "@/components/ui/TeamBadge";
import heroApprovedList from "@/lib/constants/hero-approved-kboids.json";
import type { Post } from "@/lib/supabase/usePosts";

const HERO_APPROVED = new Set<string>(heroApprovedList as string[]);

const HOME_LATEST_COUNT = 10;

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

type Label =
  | { kind: "player"; teamId: number; name: string }
  | { kind: "team"; teamId: number }
  | { kind: "kbo" };

/**
 * 글 소속 라벨 (하린아빠 스펙) — 작성자(닉네임) 대신 태그 기반으로 표기.
 *   · 선수 태그 1명          → 팀명 + 선수이름 (예: "LG 김현수")
 *   · 선수 태그 2명 이상(동팀) → 팀명
 *   · 팀이 둘 이상            → 크보팬 로고
 * player_tags("kboId:name")와 team_tags(슬러그)에서 관여 팀 집합을 만들어 분기한다.
 */
function resolveLabel(post: Post): Label {
  const players = (post.player_tags ?? [])
    .map((tag) => {
      const parts = String(tag).split(":");
      return { kboId: parts[0], name: parts.slice(1).join(":").trim() };
    })
    .filter((p) => p.kboId);

  const teamIds = new Set<number>();
  for (const p of players) {
    const tid = teamIdForKboId(p.kboId);
    if (tid != null) teamIds.add(tid);
  }
  for (const slug of post.team_tags ?? []) {
    const tid = getTeamBySlug(String(slug))?.id;
    if (tid != null) teamIds.add(tid);
  }

  // 관여 팀이 둘 이상이면 특정 팀으로 묶을 수 없음 → 크보팬 로고.
  if (teamIds.size >= 2) return { kind: "kbo" };

  if (players.length === 1) {
    const teamId = teamIdForKboId(players[0].kboId) ?? [...teamIds][0];
    if (teamId != null && players[0].name) return { kind: "player", teamId, name: players[0].name };
    if (teamId != null) return { kind: "team", teamId };
  }

  if (teamIds.size === 1) return { kind: "team", teamId: [...teamIds][0] };

  // 폴백: player_tags가 없거나 못 풀린 글(gif-collector 큐레이션 등)은 board/작성자 기준으로.
  // (피드 deriveBrandContext와 동일 원칙 — 태그 없는 선수/팀 보드 글이 크보팬으로 떨어지던 회귀 수정)
  if (post.board_type === "player") {
    const rp = resolveRosterPlayer({ name: null, kboId: post.board_id });
    if (rp?.teamId != null && rp.name) return { kind: "player", teamId: rp.teamId, name: rp.name };
    if (rp?.teamId != null) return { kind: "team", teamId: rp.teamId };
  }
  if (post.board_type === "team") {
    const teamId = getTeamBySlug(post.board_id)?.id;
    if (teamId != null) return { kind: "team", teamId };
  }
  if (post.team_id != null) return { kind: "team", teamId: post.team_id };

  return { kind: "kbo" };
}

function PostLabel({ post }: { post: Post }) {
  const label = resolveLabel(post);
  if (label.kind === "player") {
    return <TeamBadge teamId={label.teamId} playerName={label.name} size="xs" />;
  }
  if (label.kind === "team") {
    return <TeamBadge teamId={label.teamId} size="xs" />;
  }
  // 크보팬 로고 배지 (팀 다수/태그 없음).
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-bg-tertiary py-0.5 pl-0.5 pr-2 text-[10px] font-semibold text-text-secondary whitespace-nowrap shrink-0">
      <span className="inline-flex shrink-0 items-center justify-center w-4 h-4 rounded-full overflow-hidden">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/icon-192.png" alt="크보팬" className="w-full h-full object-cover" />
      </span>
      크보팬
    </span>
  );
}

type Thumb =
  | { kind: "image"; src: string }
  | { kind: "player"; src: string; teamId: number | null }
  | { kind: "logo"; src: string; teamId: number }
  | { kind: "none" };

/**
 * 썸네일 우선순위 (하린아빠 스펙):
 *   사진글 사진 썸네일 > 선수글 히어로샷 > 팀글 팀 로고 > 기본(아이콘 타일).
 * 선수 히어로샷·팀 로고는 팀컬러 그라데이션 배경 위에 얹는다(선수페이지 동일).
 * 이미지 로드 실패 시 onError로 아이콘 타일 fallback (320px·깨진 에셋 대비).
 */
function resolveThumb(post: Post): Thumb {
  const img = post.image_urls?.[0];
  if (img) return { kind: "image", src: img };

  if (post.board_type === "player" && post.board_id) {
    const hero = HERO_APPROVED.has(post.board_id)
      ? `/players-hero/${post.board_id}.webp`
      : getPlayerPhotoByKboId(post.board_id);
    if (hero) return { kind: "player", src: hero, teamId: teamIdForKboId(post.board_id) };
  }

  if (post.board_type === "team" && post.board_id) {
    const team = getTeamBySlug(post.board_id);
    if (team) return { kind: "logo", src: team.logoPath, teamId: team.id };
  }

  return { kind: "none" };
}

/** 선수페이지(PlayerHero) 동일 팀컬러 그라데이션. teamId 없으면 undefined(중성 배경). */
function teamGradient(teamId: number | null): string | undefined {
  if (teamId == null) return undefined;
  const c = getTeamColor(teamId);
  return `linear-gradient(180deg, ${c}40 0%, ${c}1A 40%, #0F0F12 78%, #0A0A0B 100%)`;
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
      {/* 썸네일 56x56 — 선수 히어로샷/팀 로고는 팀컬러 그라데이션 배경(선수페이지 동일) */}
      <div className="w-14 h-14 shrink-0 rounded-xl overflow-hidden bg-bg-tertiary">
        {thumb.kind === "none" || imgFailed ? (
          <IconTile />
        ) : thumb.kind === "logo" ? (
          <div
            className="w-full h-full flex items-center justify-center p-2.5 bg-bg-tertiary"
            style={{ background: teamGradient(thumb.teamId) }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={thumb.src}
              alt=""
              className="w-full h-full object-contain"
              onError={() => setImgFailed(true)}
            />
          </div>
        ) : thumb.kind === "player" ? (
          <div
            className="relative w-full h-full bg-bg-tertiary"
            style={{ background: teamGradient(thumb.teamId) }}
          >
            {/* 히어로샷(752×944, 인물 상단 ~27%, 눈 ~58.8% 실측)을 눈이 박스 중앙에 오도록 확대 정렬.
                w-[135%] + top -50% 로 모자~턱이 56px 박스에 적당히 차고 눈높이가 가운데. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={thumb.src}
              alt=""
              className="absolute left-1/2 w-[135%] max-w-none -translate-x-1/2"
              style={{ top: "-50%" }}
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
          <PostLabel post={post} />
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
        <h2 className="text-lg font-semibold leading-[26px] text-text-primary">💬 커뮤니티 최신글</h2>
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
