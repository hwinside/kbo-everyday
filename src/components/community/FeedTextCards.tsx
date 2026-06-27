"use client";

import Image from "next/image";
import { getTeamById, getTeamBySlug, getTeamBgColor, type TeamData } from "@/lib/constants/teams";
import PLAYERS_ROSTER from "@/lib/constants/players-roster.json";
import heroApprovedList from "@/lib/constants/hero-approved-kboids.json";
import { parsePlayerTag } from "@/lib/utils/player-tags";
import type { Post } from "@/lib/supabase/usePosts";
import LinkPreview from "./LinkPreview";

// Hero cutout: 검수 통과(allowlist) 선수만 노출. public/players-hero/{kboId}.webp
const HERO_APPROVED = new Set<string>(heroApprovedList as string[]);
export function getPlayerHeroPath(kboId: string | null | undefined): string | null {
  return kboId && HERO_APPROVED.has(kboId) ? `/players-hero/${kboId}.webp` : null;
}

function findPlayerByName(name: string): { kboId: string; teamId: number } | null {
  for (const p of PLAYERS_ROSTER) {
    if (p.name === name) return { kboId: p.kboId, teamId: p.teamId };
  }
  return null;
}

function findPlayerByKboId(kboId: string): { teamId: number; name: string } | null {
  for (const p of PLAYERS_ROSTER) {
    if (p.kboId === kboId) return { teamId: p.teamId, name: p.name };
  }
  return null;
}

// 본문 내 링크 매칭(PostCard와 동일 패턴). test용은 non-global, strip용은 global.
const URL_REGEX = /(?:https?:\/\/|www\.)[^\s<>"')\]]+/;
const URL_REGEX_G = /(?:https?:\/\/|www\.)[^\s<>"')\]]+/g;

/** URL을 제거한 본문 — 짧은글 판정/표시에 사용(OG 카드가 링크를 대신 노출). */
export function stripUrls(text: string): string {
  return text.replace(URL_REGEX_G, "").replace(/\n{3,}/g, "\n\n").trim();
}

export function hasLink(text: string): boolean {
  return URL_REGEX.test(text);
}

/**
 * 배경 텍스트 카드(B) 조건: 첨부 0(호출부 보장) + URL 제거 본문 ≤ 80자.
 * 링크/OG만 달랑 있는 OG-only 글(하린아빠 확정 예외)도 LongTextCard로 빠지지 않고
 * 배경카드 유지 → BrandedTextCard 내부에서 카드 위에 OG 프리뷰 노출 + 본문 URL strip.
 */
export function isShortText(body: string): boolean {
  return stripUrls(body).length <= 80;
}

/**
 * 카드 배경 컨텍스트(V3 태그 기반) — 팀컬러 + 선수 Hero 결정.
 * - 선수 1명 태그 → 그 선수 팀컬러 BG + 그 선수 Hero(우하단)
 * - 선수 2명↑ 태그 → 모두 같은 팀이면 팀컬러 BG(단일 Hero 없음), 다른 팀 섞이면 중립 BG
 * - 레거시 선수보드 글 → 그 선수 팀컬러 + Hero(컷아웃 유지)
 * - 그 외 팀/자유 글 → team_tags 단일이면 그 팀, 2개↑(다중 태그)면 중립 BG(구단 로고 미노출)
 *
 * 다중 팀 태그 글(예: 전 구단 태그한 올스타 투표 글)은 여러 팀 탭에 노출되는데, 특정 한 팀
 * 로고/컬러를 칠하면 "LG탭인데 두산 로고" 같은 혼란이 생긴다(#cs id 2044). 하린아빠 확정 기준:
 * 다중 태그 글은 *중립 배경*(특정 구단 색/로고 없음). 작성자 배지(post.team_id)는 별개로 유지.
 */
function deriveBrandContext(post: Post): { team?: TeamData; heroKboId?: string } {
  const playerTags = Array.isArray(post.player_tags) ? (post.player_tags as string[]) : [];
  if (playerTags.length > 0) {
    const parsed = playerTags.map((t) => {
      const { kboId, displayName } = parsePlayerTag(t);
      if (kboId) return { kboId, teamId: findPlayerByKboId(kboId)?.teamId };
      const p = findPlayerByName(displayName);
      return { kboId: p?.kboId, teamId: p?.teamId };
    });
    if (playerTags.length === 1) {
      const only = parsed[0];
      return { team: only.teamId ? getTeamById(only.teamId) : undefined, heroKboId: only.kboId ?? undefined };
    }
    const teamIds = new Set(parsed.map((p) => p.teamId).filter((x): x is number => !!x));
    if (teamIds.size === 1) return { team: getTeamById([...teamIds][0]) };
    return {}; // 다른 팀 선수 혼합 → 중립 BG
  }
  // 레거시 선수보드 글(player_tags 없음) → 그 선수 Hero 컷아웃 유지.
  if (post.board_type === "player") {
    const entry = findPlayerByKboId(post.board_id);
    return { team: entry ? getTeamById(entry.teamId) : undefined, heroKboId: post.board_id };
  }
  // 팀/자유 글 → team_tags 기준. 다중(2개↑)이면 중립, 단일이면 그 팀.
  const teamTags = Array.isArray(post.team_tags) ? (post.team_tags as string[]) : [];
  if (teamTags.length >= 2) return {}; // 다중 팀 태그 → 중립 BG(구단 로고 미노출)
  if (teamTags.length === 1) return { team: getTeamBySlug(teamTags[0]) };
  // team_tags 비어있는 레거시 글 → 작성 게시판(team) → 작성자 응원팀(free) 폴백.
  if (post.board_type === "team") return { team: getTeamBySlug(post.board_id) };
  return { team: post.team_id ? getTeamById(post.team_id) : undefined };
}

/**
 * 글 소속 브레드크럼 스코프 — 글 상세 헤더 "커뮤니티 > {scope}"용(홈 최신글 라벨과 동일 원칙).
 *   · 선수 태그 1명 → "팀단축명 선수이름" (예: "LG 송찬의")
 *   · 선수 2명↑(동팀) / 팀 태그 단일 → "팀단축명"
 *   · 팀이 둘 이상 / 없음 → "" (헤더는 "커뮤니티"만)
 */
export function getPostScopeLabel(post: Post): string {
  const { team, heroKboId } = deriveBrandContext(post);
  if (heroKboId) {
    const nm = findPlayerByKboId(heroKboId)?.name;
    if (team && nm) return `${team.shortName} ${nm}`;
    if (nm) return nm;
  }
  return team ? team.shortName : "";
}

/** 카드 B — 페북식 배경 텍스트 카드. 태그 기반으로 팀컬러 + 선수 Hero(우하단) 결정. */
export function BrandedTextCard({ post, body }: { post: Post; body: string }) {
  const { team, heroKboId } = deriveBrandContext(post);
  const heroPath = getPlayerHeroPath(heroKboId);

  const gradient = team
    ? `linear-gradient(135deg, color-mix(in srgb, ${getTeamBgColor(team)} 35%, #1a1a1d) 0%, #1a1a1d 100%)`
    : "linear-gradient(135deg, #2a2a3d 0%, #1a1a1d 100%)";

  // OG-only 예외: URL은 본문에서 strip하고 OG 프리뷰를 카드 위에 노출(하린아빠 확정).
  const displayBody = stripUrls(body);
  const linked = hasLink(body);

  return (
    <div
      className="relative flex min-h-[200px] w-full items-center justify-center overflow-hidden px-8 py-10"
      style={{ background: gradient }}
    >
      {heroPath ? (
        // 선수 1명 태그 → 팀컬러 BG 위에 선수 Hero 우하단(팀글의 로고 자리 대신 인물 컷아웃)
        <Image
          src={heroPath}
          alt=""
          width={200}
          height={240}
          unoptimized
          // 30% 축소(h 88%→62%) + 반투명 + 좌상단 페이드 마스크 → 팀 로고처럼 배경에 스며드는 느낌(①).
          className="pointer-events-none absolute bottom-0 right-0 h-[62%] w-auto object-contain object-bottom"
          style={{
            opacity: 0.4,
            maskImage: "linear-gradient(to top left, #000 50%, transparent 100%)",
            WebkitMaskImage: "linear-gradient(to top left, #000 50%, transparent 100%)",
          }}
        />
      ) : team ? (
        <div className="absolute right-4 top-4 opacity-20">
          <Image src={team.logoPath} alt="" width={88} height={88} unoptimized className="object-contain" />
        </div>
      ) : null}
      {/* 하단 스크림 — 히어로처럼 컷아웃 바닥을 배경으로 페이드(딱 잘리는 느낌 제거). 선수 Hero가 있을 때만. */}
      {heroPath && (
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2"
          style={{ background: "linear-gradient(to top, #1a1a1d 0%, transparent 100%)" }}
        />
      )}
      <div className="relative z-10 flex w-full flex-col items-center gap-3">
        {displayBody && (
          <p className="whitespace-pre-line break-keep text-center text-xl font-bold leading-snug text-white line-clamp-5">
            {displayBody}
          </p>
        )}
        {linked && (
          <div className="w-full max-w-sm">
            <LinkPreview text={body} maxPreviews={1} stopPropagation />
          </div>
        )}
      </div>
    </div>
  );
}
