import { getTeamById, getTeamBySlug } from "@/lib/constants/teams";
import { resolveRosterPlayer } from "@/lib/utils/player-roster";

/**
 * 글 → 공개범위 스코프 입력 변환 (홈 최신글 · 커뮤니티 피드 · 상세 공용).
 *
 * team_tags/player_tags 가 있으면 그대로 쓰고, 없으면(레거시·움짤콜렉터 글)
 * board_type/board_id 로 팀을 복원한다. 복원도 실패하면 태그 0개 →
 * resolvePostScope 가 "전체구단 공개"로 판정한다(하린아빠 2026-08-06:
 * 팀 태그 없음 = 전체구단 선택과 동일 개념).
 *
 * 이 변환을 화면마다 따로 쓰면 같은 글이 홈과 피드에서 다른 배지를 달게 된다 —
 * 실제로 2026-08-06 이전이 그 상태였다(홈=team_tags / 피드=board_type).
 */

export interface ScopeSourcePost {
  player_tags?: string[] | null;
  team_tags?: string[] | null;
  board_type?: string | null;
  board_id?: string | null;
}

export interface ScopeInput {
  player_tags?: string[] | null;
  team_tags?: string[] | null;
}

export function scopeInputForPost(post: ScopeSourcePost): ScopeInput {
  const hasTags = (post.player_tags?.length ?? 0) > 0 || (post.team_tags?.length ?? 0) > 0;
  if (hasTags) return { player_tags: post.player_tags, team_tags: post.team_tags };

  if (post.board_type === "player" && post.board_id) {
    const rp = resolveRosterPlayer({ name: null, kboId: post.board_id });
    if (rp?.teamId != null) {
      const slug = getTeamById(rp.teamId)?.slug;
      return {
        player_tags: rp.name ? [`${post.board_id}:${rp.name}`] : undefined,
        team_tags: slug ? [slug] : undefined,
      };
    }
  }

  if (post.board_type === "team" && post.board_id) {
    const slug = getTeamBySlug(post.board_id)?.slug;
    if (slug) return { team_tags: [slug] };
  }

  return {};
}
