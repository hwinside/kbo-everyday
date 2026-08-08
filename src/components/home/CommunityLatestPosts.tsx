"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { MessageCircle, Heart, ChevronRight, ChevronDown, ChevronUp, PenSquare, FileText, Image as ImageIcon, Video, BarChart3 } from "lucide-react";
import { useUnifiedFeed, type FeedBoard } from "@/lib/supabase/useUnifiedFeed";
import { useAuth } from "@/lib/supabase/AuthContext";
import { getPostDetailPath } from "@/lib/utils/post-share";
import { getTeamById } from "@/lib/constants/teams";
import { getTeamColor, getTeamBgColorById } from "@/lib/utils/team";
import { getPlayerPhotoByKboId } from "@/lib/constants/player-photos";
import PostScopeBadge from "@/components/community/PostScopeBadge";
import { resolvePostScope } from "@/lib/utils/post-scope";
import { scopeInputForPost } from "@/lib/utils/post-scope-input";
import CommunityWriteFlow, { type WriteFlowMode } from "@/components/community/CommunityWriteFlow";
import heroApprovedList from "@/lib/constants/hero-approved-kboids.json";
import type { Post } from "@/lib/supabase/usePosts";

const HERO_APPROVED = new Set<string>(heroApprovedList as string[]);

const HOME_LATEST_COUNT = 20;
// 홈 최신글 접힘 기본 노출 수. 20개 전량은 목록만 ~1,520px라 스크롤 부담(삼순 리뷰).
// 기본 5개만 노출하고 '15개 더 보기/접기'로 나머지를 토글한다.
const HOME_LATEST_COLLAPSED = 5;

// 홈 최신글에서 글을 열었다는 표식(sessionStorage, pending). 클릭 시점엔 아직
// "뒤로가기로 돌아왔는지" 알 수 없으므로 대기 상태로만 남긴다.
const HOME_FOCUS_PENDING_KEY = "kbo:home-focus-pending";
// 실제 popstate(브라우저/제스처 뒤로가기)가 발생했을 때만 pending→confirmed로 승격되는 플래그.
// 홈이 마운트될 때 이 플래그만 소비한다 — 탭바 홈 이동 등 push 네비게이션은 popstate가 없어
// confirmed가 세팅되지 않으므로 스크롤이 발동하지 않는다(삼순 리뷰 반영, PR #597).
const HOME_FOCUS_CONFIRMED_KEY = "kbo:home-focus-confirmed";

// 모듈은 SPA 수명 동안 1회만 평가되는 싱글턴이라(Next.js 클라이언트 라우팅은 전체 리로드 없이
// 같은 JS 컨텍스트를 유지) 여기서 등록한 popstate 리스너는 라우트 전환과 무관하게 항상 살아있다.
if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => {
    try {
      if (sessionStorage.getItem(HOME_FOCUS_PENDING_KEY) === "1") {
        sessionStorage.setItem(HOME_FOCUS_CONFIRMED_KEY, "1");
        sessionStorage.removeItem(HOME_FOCUS_PENDING_KEY);
      }
    } catch { /* private mode 무시 */ }
  });
}

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

function PostLabel({ post }: { post: Post }) {
  return <PostScopeBadge post={scopeInputForPost(post)} variant="compact" />;
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
 * 라벨(resolvePostScope)과 동일한 분기를 따라야 한다 — 라벨이 다팀/전체구단인데
 * 썸네일만 작성 보드 팀 로고가 뜨던 불일치 수정(하린아빠 #cs 제보). board_id가
 * 아니라 태그 기반 라벨을 SSOT로 삼는다.
 * 선수 히어로샷·팀 로고는 팀컬러 그라데이션 배경 위에 얹는다(선수페이지 동일).
 * 이미지 로드 실패 시 onError로 아이콘 타일 fallback (320px·깨진 에셋 대비).
 */
function resolveThumb(post: Post): Thumb {
  const img = post.image_urls?.[0];
  if (img) return { kind: "image", src: img };

  const scope = resolvePostScope(scopeInputForPost(post));
  if (scope.kind === "player") {
    const hero = HERO_APPROVED.has(scope.kboId)
      ? `/players-hero/${scope.kboId}.webp`
      : getPlayerPhotoByKboId(scope.kboId);
    if (hero) return { kind: "player", src: hero, teamId: scope.teamId };
  }

  if (scope.kind === "team") {
    const team = getTeamById(scope.teamId);
    if (team) return { kind: "logo", src: team.logoPath, teamId: team.id };
  }

  // 다팀(2~9팀) / 전체구단 → 크보팬 로고 (특정 구단 로고를 쓰면 라벨과 어긋난다)
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

/**
 * 글 유형 아이콘 (하린아빠 스펙 2026-07-28) — 일반글/사진/동영상/투표 4종.
 * 사진과 동영상이 섞여 있으면 동영상으로 표기(동영상 우선).
 * 우선순위: 투표(board_type='poll') > 동영상(video_urls) > 사진(image_urls) > 일반글.
 */
function postTypeBadge(post: Post): { Icon: typeof FileText; label: string } {
  if (post.board_type === "poll") return { Icon: BarChart3, label: "투표" };
  if ((post.video_urls?.length ?? 0) > 0) return { Icon: Video, label: "동영상" };
  if ((post.image_urls?.length ?? 0) > 0) return { Icon: ImageIcon, label: "사진" };
  return { Icon: FileText, label: "일반글" };
}

/** 제목 왼쪽 인라인 글 유형 아이콘. 썸네일 오버레이는 선수 얼굴을 가려 제목 앞으로 이동(하린아빠). */
function PostTypeIcon({ post }: { post: Post }) {
  const { Icon, label } = postTypeBadge(post);
  return (
    <Icon
      size={16}
      strokeWidth={2.25}
      aria-label={label}
      className="shrink-0 text-text-secondary"
    />
  );
}

function PostRow({ post }: { post: Post }) {
  const [imgFailed, setImgFailed] = useState(false);
  const thumb = resolveThumb(post);
  const summary = summaryLine(post);

  return (
    <Link prefetch={false}
      href={getPostDetailPath(post)}
      onClick={() => {
        // 홈 최신글에서 연 글 → 실제 뒤로가기(popstate)로 나올 때만 이 섹션으로 포커스
        // 복귀시키도록 대기 표식만 남긴다(확정은 popstate 리스너가 담당).
        try { sessionStorage.setItem(HOME_FOCUS_PENDING_KEY, "1"); } catch { /* private mode 무시 */ }
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
        {/* 글 유형 아이콘을 제목 왼쪽에 인라인 배치(오버레이가 선수 얼굴 가림 → 이동). */}
        <div className="flex items-center gap-1">
          <PostTypeIcon post={post} />
          <p className="text-[14px] leading-[20px] font-medium text-text-primary line-clamp-1">
            {summary || "(내용 없음)"}
          </p>
        </div>
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
 * 전체 통합피드(자유+팀+선수) 최신 HOME_LATEST_COUNT개를 세로 compact 리스트로 노출.
 * 신규 API·테이블 없이 useUnifiedFeed를 재사용한다.
 */
export default function CommunityLatestPosts({ myTeamId, refreshNonce = 0 }: { myTeamId: number | null; refreshNonce?: number }) {
  // 홈 최신글은 '최애팀 태그된 글'만 노출(하린아빠 스펙 2026-07-25). 전체글이 너무 많아진 데 대한 대응.
  // 최애팀이 있으면 팀 피드(team_tags·해당 팀 선수 태그·레거시 팀/선수 보드 OR 쿼리)로 서버 필터,
  // 최애팀 미선택(비로그인·온보딩 전)이면 필터 기준이 없으므로 기존처럼 전체글을 노출한다.
  const myTeam = myTeamId != null ? getTeamById(myTeamId) : null;
  const myTeamSlug = myTeam?.slug ?? null;
  const board: FeedBoard = myTeamSlug ? { kind: "team", teamId: myTeamSlug } : { kind: "all" };
  // 최애팀 필터 적용 중임을 타이틀에 명시: '커뮤니티 최신글(LG)'. 미선택 시 괄호 없음.
  const sectionTitle = myTeam ? `커뮤니티 최신글(${myTeam.shortName})` : "커뮤니티 최신글";
  const { posts, loading, reload } = useUnifiedFeed(board, HOME_LATEST_COUNT);
  const { user } = useAuth();
  const [writeMode, setWriteMode] = useState<WriteFlowMode>(null);
  const [expanded, setExpanded] = useState(false);
  const sectionRef = useRef<HTMLElement | null>(null);
  const didFocusRef = useRef(false);

  const showList = !loading && posts.length > 0;

  // Pull-to-refresh: refreshNonce가 증가하면 통합피드를 실제로 재조회(reload). 초기 mount(0)엔 미호출.
  useEffect(() => {
    if (refreshNonce > 0) reload();
    // reload identity 변동으로인 중복 호출 방지 — nonce 변경 시에만 1회.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshNonce]);

  // 홈 최신글에서 글을 열고 뒤로 나온 경우에 한해, 홈 최상단 대신 이 섹션으로 스크롤 복귀.
  // router.back() 직후엔 뉴스/숏츠 등 상단 섹션이 뒤늦게 로드되며 위치가 아래로 밀리므로,
  // 유저가 직접 스크롤(휠/터치/키)하기 전까지 짧은 창(≤1s) 동안 섹션을 뷰포트 상단에 재고정한다.
  useEffect(() => {
    if (!showList || didFocusRef.current || typeof window === "undefined") return;
    let confirmed = false;
    try { confirmed = sessionStorage.getItem(HOME_FOCUS_CONFIRMED_KEY) === "1"; } catch { /* 무시 */ }
    // 이 시점까지 confirmed가 안 세팅됐다면 popstate 없이(탭바 홈 등) 도착한 것 — pending이
    // 남아있으면 이후 무관한 popstate에서 오탐하지 않도록 정리한다.
    try { sessionStorage.removeItem(HOME_FOCUS_PENDING_KEY); } catch { /* 무시 */ }
    if (!confirmed) return;
    didFocusRef.current = true;
    try { sessionStorage.removeItem(HOME_FOCUS_CONFIRMED_KEY); } catch { /* 무시 */ }

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
  const visible = expanded ? latest : latest.slice(0, HOME_LATEST_COLLAPSED);
  const hiddenCount = latest.length - HOME_LATEST_COLLAPSED;

  return (
    <section ref={sectionRef} className="scroll-mt-4">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-lg font-semibold leading-[26px] text-text-primary">💬 {sectionTitle}</h2>
        <Link prefetch={false}
          href="/community/all-posts"
          className="flex items-center text-xs text-text-tertiary active:opacity-70 transition-opacity"
        >
          더보기 <ChevronRight size={14} />
        </Link>
      </div>

      <div className="divide-y divide-black/5 dark:divide-white/5">
        {visible.map((post) => (
          <PostRow key={post.id} post={post} />
        ))}
      </div>

      {/* 기본 5개 노출, 나머지는 '더 보기/접기'로 토글(삼순 리뷰 — 20개 전량 스크롤 부담 완화). */}
      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 flex items-center justify-center gap-1 w-full py-2 text-[13px] font-medium text-text-secondary active:opacity-70 transition-opacity"
        >
          {expanded ? (
            <>접기 <ChevronUp size={15} /></>
          ) : (
            <>{hiddenCount}개 더 보기 <ChevronDown size={15} /></>
          )}
        </button>
      )}

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

      <Link prefetch={false}
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
