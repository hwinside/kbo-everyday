"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { MessageCircle, Heart, ChevronRight, PenSquare } from "lucide-react";
import { useUnifiedFeed } from "@/lib/supabase/useUnifiedFeed";
import { useAuth } from "@/lib/supabase/AuthContext";
import { getPostDetailPath } from "@/lib/utils/post-share";
import { getTeamBySlug, getTeamById } from "@/lib/constants/teams";
import { getTeamColor, getTeamBgColorById } from "@/lib/utils/team";
import { getPlayerPhotoByKboId } from "@/lib/constants/player-photos";
import { teamIdForKboId, resolveRosterPlayer } from "@/lib/utils/player-roster";
import TeamBadge from "@/components/ui/TeamBadge";
import CommunityWriteFlow, { type WriteFlowMode } from "@/components/community/CommunityWriteFlow";
import heroApprovedList from "@/lib/constants/hero-approved-kboids.json";
import type { Post } from "@/lib/supabase/usePosts";

const HERO_APPROVED = new Set<string>(heroApprovedList as string[]);

const HOME_LATEST_COUNT = 15;

// 홈 최신글에서 글을 열었다는 표식(sessionStorage). 뒤로가기로 홈에 돌아왔을 때
// 홈 최상단이 아니라 이 섹션으로 다시 포커스하기 위한 1회용 플래그(하린아빠 스펙).
const HOME_FOCUS_KEY = "kbo:home-focus-community";

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
  | { kind: "player"; teamId: number; name: string; kboId: string }
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
    if (teamId != null && players[0].name)
      return { kind: "player", teamId, name: players[0].name, kboId: players[0].kboId };
    if (teamId != null) return { kind: "team", teamId };
  }

  if (teamIds.size === 1) return { kind: "team", teamId: [...teamIds][0] };

  // 폴백: player_tags가 없거나 못 풀린 글(gif-collector 큐레이션 등)은 board/작성자 기준으로.
  // (피드 deriveBrandContext와 동일 원칙 — 태그 없는 선수/팀 보드 글이 크보팬으로 떨어지던 회귀 수정)
  if (post.board_type === "player") {
    const rp = resolveRosterPlayer({ name: null, kboId: post.board_id });
    if (rp?.teamId != null && rp.name)
      return { kind: "player", teamId: rp.teamId, name: rp.name, kboId: String(post.board_id) };
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
  | { kind: "kbo" }
  | { kind: "none" };

/**
 * 썸네일 우선순위 (하린아빠 스펙):
 *   사진글 사진 썸네일 > 라벨 분기(선수 히어로샷 / 팀 로고 / 크보팬 로고).
 * 라벨(resolveLabel)과 동일한 분기를 따라야 한다 — 라벨이 "크보팬"(다팀/무팀)인데
 * 썸네일만 작성 보드 팀 로고가 뜨던 불일치 수정(하린아빠 #cs 제보). board_id가
 * 아니라 태그 기반 라벨을 SSOT로 삼는다.
 * 선수 히어로샷·팀 로고는 팀컬러 그라데이션 배경 위에 얹는다(선수페이지 동일).
 * 이미지 로드 실패 시 onError로 아이콘 타일 fallback (320px·깨진 에셋 대비).
 */
function resolveThumb(post: Post): Thumb {
  const img = post.image_urls?.[0];
  if (img) return { kind: "image", src: img };

  const label = resolveLabel(post);
  if (label.kind === "player") {
    const hero = HERO_APPROVED.has(label.kboId)
      ? `/players-hero/${label.kboId}.webp`
      : getPlayerPhotoByKboId(label.kboId);
    if (hero) return { kind: "player", src: hero, teamId: label.teamId };
  }

  if (label.kind === "team") {
    const team = getTeamById(label.teamId);
    if (team) return { kind: "logo", src: team.logoPath, teamId: team.id };
  }

  // label.kind === "kbo" (다팀/무팀) → 크보팬 로고 (라벨과 정합)
  return { kind: "kbo" };
}

/** 선수페이지(PlayerHero) 동일 팀컬러 그라데이션. teamId 없으면 undefined(중성 배경). */
function teamGradient(teamId: number | null): string | undefined {
  if (teamId == null) return undefined;
  const c = getTeamColor(teamId);
  // 팀컬러 → 투명 페이드. 하단은 타일의 bg-bg-tertiary(테마 토큰: 라이트 #E5E5EA / 다크 #1C1C1F)가
  // 채워 라이트·다크 모두 자연스럽게 처리한다. 다크용 #0F0F12/#0A0A0B 하드코딩 제거로
  // 화이트 테마에서 썸네일 하단이 시커멓게 겉돌던 문제 해소(하린아빠 #cs 제보).
  return `linear-gradient(180deg, ${c}40 0%, ${c}1A 45%, transparent 85%)`;
}

/**
 * 무팀/다팀(크보팬 라벨) 글 썸네일 아이콘.
 * 크보팬 로고와 동일한 파랑→빨강 말풍선 + 야구공 모티프(하린아빠 C안 확정 2026-06-26).
 * 단색 lucide 아이콘이 밋밋해 브랜드 컬러를 입힌 인라인 SVG로 교체.
 */
function IconTile() {
  return (
    <div className="w-full h-full flex items-center justify-center bg-bg-tertiary">
      <svg
        width="39"
        height="39"
        viewBox="0 0 48 48"
        fill="none"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id="kbo-bubble-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#1E5BB8" />
            <stop offset="0.5" stopColor="#2F57C9" />
            <stop offset="1" stopColor="#D6353F" />
          </linearGradient>
        </defs>
        {/* 말풍선(꼬리 좌하단) — 크보팬 로고 형태 */}
        <path
          d="M13 7 H35 a9 9 0 0 1 9 9 V28 a9 9 0 0 1 -9 9 H23 l-7 7 v-7 H13 a9 9 0 0 1 -9 -9 V16 a9 9 0 0 1 9 -9 Z"
          fill="url(#kbo-bubble-grad)"
        />
        {/* 야구공 */}
        <g transform="translate(24 22)">
          <circle r="9" fill="#fff" />
          <path
            d="M-6.4 -6.4 A9 9 0 0 0 -6.4 6.4"
            fill="none"
            stroke="#C42A35"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <path
            d="M6.4 -6.4 A9 9 0 0 1 6.4 6.4"
            fill="none"
            stroke="#C42A35"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <g stroke="#C42A35" strokeWidth="1.1" strokeLinecap="round">
            <path d="M-5.2 -4 l1.6 0.5 M-5.7 -1.4 l1.7 0.2 M-5.5 1.6 l1.7 -0.3 M-4.6 4 l1.5 -0.8" />
            <path d="M5.2 -4 l-1.6 0.5 M5.7 -1.4 l-1.7 0.2 M5.5 1.6 l-1.7 -0.3 M4.6 4 l-1.5 -0.8" />
          </g>
        </g>
      </svg>
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
      onClick={() => {
        // 홈 최신글에서 연 글 → 뒤로 나오면 이 섹션으로 포커스 복귀시키도록 표식.
        try { sessionStorage.setItem(HOME_FOCUS_KEY, "1"); } catch { /* private mode 무시 */ }
      }}
      className="flex items-center gap-3 py-2.5 active:opacity-70 transition-opacity"
    >
      {/* 썸네일 56x56 — 선수 히어로샷/팀 로고는 팀컬러 그라데이션 배경(선수페이지 동일) */}
      <div className="w-14 h-14 shrink-0 rounded-xl overflow-hidden bg-bg-tertiary">
        {thumb.kind === "none" || thumb.kind === "kbo" || imgFailed ? (
          // 크보팬 라벨(다팀/무팀) 글은 말풍선 아이콘 타일. 크보팬 로고는 라벨과
          // 중복이고, 본문 미리보기는 우측 텍스트와 중복이라 중립 말풍선 채택(하린아빠 결정).
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
            {/* 히어로샷(752×944, Daum 소스 실루엣 정규화). object-cover는 56px 박스에서 턱이
                잘려(실배포 확인) → object-contain으로 전체 노출, 잘림 0. 측면 여백은 팀 그라데이션
                bg가 채움. 최애선수 카드(contain)와 동일 처리. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={thumb.src}
              alt=""
              className="absolute inset-0 w-full h-full object-contain"
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
export default function CommunityLatestPosts({ myTeamId }: { myTeamId: number | null }) {
  const { posts, loading, reload } = useUnifiedFeed({ kind: "all" }, HOME_LATEST_COUNT);
  const { user } = useAuth();
  const [writeMode, setWriteMode] = useState<WriteFlowMode>(null);
  const sectionRef = useRef<HTMLElement | null>(null);
  const didFocusRef = useRef(false);

  const showList = !loading && posts.length > 0;

  // 홈 최신글에서 글을 열고 뒤로 나온 경우에 한해, 홈 최상단 대신 이 섹션으로 스크롤 복귀.
  // router.back() 직후엔 뉴스/숏츠 등 상단 섹션이 뒤늦게 로드되며 위치가 아래로 밀리므로,
  // 유저가 직접 스크롤(휠/터치/키)하기 전까지 짧은 창(≤1s) 동안 섹션을 뷰포트 상단에 재고정한다.
  useEffect(() => {
    if (!showList || didFocusRef.current || typeof window === "undefined") return;
    let flagged = false;
    try { flagged = sessionStorage.getItem(HOME_FOCUS_KEY) === "1"; } catch { /* 무시 */ }
    if (!flagged) return;
    didFocusRef.current = true;
    try { sessionStorage.removeItem(HOME_FOCUS_KEY); } catch { /* 무시 */ }

    let cancelled = false;
    const cancel = () => { cancelled = true; };
    window.addEventListener("wheel", cancel, { passive: true, once: true });
    window.addEventListener("touchstart", cancel, { passive: true, once: true });
    window.addEventListener("keydown", cancel, { once: true });

    const start = Date.now();
    let raf = 0;
    const pin = () => {
      if (cancelled) return;
      sectionRef.current?.scrollIntoView({ block: "start" });
      if (Date.now() - start < 1000) raf = requestAnimationFrame(pin);
    };
    raf = requestAnimationFrame(pin);

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("wheel", cancel);
      window.removeEventListener("touchstart", cancel);
      window.removeEventListener("keydown", cancel);
    };
  }, [showList]);

  // 로딩 중이거나 글이 없으면 섹션 자체를 숨김(빈 박스 방지) — 뉴스 섹션과 동일 패턴.
  if (loading || posts.length === 0) return null;

  const latest = posts.slice(0, HOME_LATEST_COUNT);

  return (
    <section ref={sectionRef} className="scroll-mt-4">
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

      {/* '새 글 올리기' CTA — 내 팀 컬러 배경(미선택 시 앱 액센트). 커뮤니티로 이동하지 않고
          그 자리에서 글쓰기 모달을 연다(배경 전환 어색함 제거, 하린아빠 스펙). 더보기 바로 위. */}
      <button
        type="button"
        onClick={() => setWriteMode(user ? "entry" : "login")}
        className="mt-2 flex items-center justify-center gap-1.5 w-full py-3 rounded-xl bg-accent text-[14px] font-semibold text-white active:scale-[0.99] transition-transform"
        style={myTeamId ? { background: getTeamBgColorById(myTeamId) } : undefined}
      >
        <PenSquare size={16} /> 새 글 올리기
      </button>

      <Link
        href="/community/all-posts"
        className="mt-2 flex items-center justify-center gap-1 w-full py-2.5 rounded-xl bg-bg-secondary text-[13px] font-medium text-text-secondary active:scale-[0.99] transition-transform"
      >
        커뮤니티 더보기 <ChevronRight size={15} />
      </Link>

      {/* 페이지 이동 없이 그 자리에서 뜨는 글쓰기 플로우. 작성 성공 시 홈 최신글 즉시 갱신. */}
      <CommunityWriteFlow mode={writeMode} onClose={() => setWriteMode(null)} onPosted={reload} />
    </section>
  );
}
