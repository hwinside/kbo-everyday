import { TEAMS, getTeamBySlug, isAllStarTeamId } from "@/lib/constants/teams";
import { teamIdForKboId } from "@/lib/utils/player-roster";

/**
 * 글 공개범위 라벨 SSOT (하린아빠 스펙 2026-08-06).
 *
 * 홈 최신글·커뮤니티 피드·글 상세가 각자 라벨을 계산하던 걸 여기 하나로 모은다.
 * 기존엔 홈은 team_tags 기반(resolveLabel), 피드는 board_type/board_id 기반
 * (getPostSourceLabel)이라 같은 글이 화면마다 다른 배지를 달고 있었다.
 *
 * 규칙:
 *   · 관여 팀 10팀 전부  → "전체구단 공개"
 *   · 팀 태그 0개(레거시 자유글) → "전체구단 공개" (하린아빠: 자유글 = 전체구단 선택과 동일 개념)
 *   · 2~3팀            → 각 팀 배지 나열
 *   · 4~9팀            → 앞 3팀 배지 + "외 n팀"
 *   · 1팀 + 선수 태그 1명 → 팀 + 선수 이름 (예: "LG 김현수")
 *   · 1팀              → 그 팀 배지
 *
 * 관여 팀 = team_tags(직접 선택) ∪ player_tags 선수들의 소속팀.
 * 올스타(101/102)는 정규 10구단이 아니므로 집합에서 제외한다 — 포함시키면
 * "10팀 전부" 판정이 흐트러진다.
 */

/** 정규 KBO 구단 수. TEAMS(올스타 제외)에서 파생 — 구단 수가 바뀌면 자동 추종. */
export const KBO_TEAM_COUNT = TEAMS.length;

/** 4팀 이상일 때 배지로 직접 노출하는 팀 수. 나머지는 "외 n팀". */
export const SCOPE_SHOWN_LIMIT = 3;

export type PostScope =
  /** 선수 태그 1명 (단일 팀) */
  | { kind: "player"; teamId: number; name: string; kboId: string }
  /** 단일 팀 */
  | { kind: "team"; teamId: number }
  /** 2~9팀. shown은 최대 3팀(구단 기본 순서), overflow는 나머지 팀 수(0이면 전부 노출). */
  | { kind: "teams"; teamIds: number[]; shown: number[]; overflow: number }
  /** 10팀 전부 또는 태그 없음 → 전체구단 공개 */
  | { kind: "all" };

/** 글 공개범위 라벨 텍스트(접근성 label·공유 텍스트용). */
export const ALL_TEAMS_LABEL = "전체구단 공개";

type ScopeInput = {
  player_tags?: string[] | null;
  team_tags?: string[] | null;
};

/** "kboId:이름" 태그에서 kboId와 이름을 분리. */
function parseTag(tag: string): { kboId: string; name: string } {
  const parts = String(tag).split(":");
  return { kboId: parts[0], name: parts.slice(1).join(":").trim() };
}

/**
 * 관여 팀 id 집합 — team_tags ∪ player_tags 소속팀. 올스타 제외.
 * 반환 순서는 구단 기본 순서(TEAMS)로 고정한다. 사용자가 고른 순서를 쓰면
 * 같은 글이 화면·기기마다 다른 팀을 앞에 보여줄 수 있다.
 */
export function resolveScopeTeamIds(post: ScopeInput): number[] {
  const ids = new Set<number>();

  for (const tag of post.player_tags ?? []) {
    const { kboId } = parseTag(tag);
    if (!kboId) continue;
    const tid = teamIdForKboId(kboId);
    if (tid != null && !isAllStarTeamId(tid)) ids.add(tid);
  }

  for (const slug of post.team_tags ?? []) {
    const tid = getTeamBySlug(String(slug))?.id;
    if (tid != null && !isAllStarTeamId(tid)) ids.add(tid);
  }

  // 구단 기본 순서로 정렬(안정적 표기).
  return TEAMS.filter((t) => ids.has(t.id)).map((t) => t.id);
}

/**
 * 글의 공개범위 스코프. 표시 컴포넌트(홈/피드/상세)는 전부 이 함수를 통과해야 한다.
 */
export function resolvePostScope(post: ScopeInput): PostScope {
  const teamIds = resolveScopeTeamIds(post);

  // 10팀 전부 = 전체구단 공개.
  if (teamIds.length >= KBO_TEAM_COUNT) return { kind: "all" };

  // 태그 0개(레거시 자유글) = 전체구단 공개와 동일 개념(하린아빠 2026-08-06).
  if (teamIds.length === 0) return { kind: "all" };

  if (teamIds.length === 1) {
    const teamId = teamIds[0];
    // 그 팀 선수 1명만 태그된 글은 선수 이름까지 표기(기존 홈 라벨 동작 유지).
    const players = (post.player_tags ?? []).map(parseTag).filter((p) => p.kboId);
    if (players.length === 1 && players[0].name) {
      return { kind: "player", teamId, name: players[0].name, kboId: players[0].kboId };
    }
    return { kind: "team", teamId };
  }

  // 2~9팀.
  const shown = teamIds.slice(0, SCOPE_SHOWN_LIMIT);
  return {
    kind: "teams",
    teamIds,
    shown,
    overflow: teamIds.length - shown.length,
  };
}
