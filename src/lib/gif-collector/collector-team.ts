/**
 * 콜렉터(짤/움짤) 글의 팀 파생 — 공개범위(team_tags)와 작성자 배지(author_team_id_snapshot)의 단일 출처.
 *
 * 봇은 응원팀이 없다. `profiles.team_id` 는 NOT NULL 을 충족하려고 seed 가 박아둔 임의값(1=LG)이라
 * 그걸 작성자 배지로 쓰면 KIA 김도영 글이 "LG 팬"으로 보인다(2026-08-07 하린아빠 지적).
 * 그래서 배지도 공개범위도 매칭 결과(board)에서 파생한다.
 *   · board_type='team'   → board_id 가 곧 구단 slug
 *   · board_type='player' → 그 선수의 소속팀 (로스터 SSOT)
 * 해석 불가면 null — 호출측이 발행을 철회한다(임의 팀을 찍지 않는다).
 *
 * supabase 를 import 하지 않는 순수 모듈 — 게이트가 실행 환경 없이 직접 호출할 수 있어야 한다.
 */

import { getTeamById, getTeamBySlug } from "@/lib/constants/teams";
import { playerNameForKboId, teamIdForKboId } from "@/lib/utils/player-roster";
import { formatPlayerTag } from "@/lib/utils/player-tags";

export interface CollectorTeam {
  id: number;
  slug: string;
}

export function resolveCollectorTeam(
  boardType: string | null,
  boardId: string | null,
): CollectorTeam | null {
  if (!boardId) return null;
  if (boardType === "team") {
    const team = getTeamBySlug(boardId);
    return team ? { id: team.id, slug: team.slug } : null;
  }
  if (boardType === "player") {
    const teamId = teamIdForKboId(boardId);
    const team = teamId != null ? getTeamById(teamId) : undefined;
    return team ? { id: team.id, slug: team.slug } : null;
  }
  return null;
}

/**
 * 콜렉터 글의 선수 태그(player_tags) 파생 — 최애선수 게시글 알림(`fav_player_post`)의 유일한 근거.
 *
 * 사고: 2026-08-16 하린아빠 — 콜렉터 계정 글에 최애선수 알림이 안 온다.
 * 원인은 publisher 가 posts INSERT 에 `player_tags` 를 아예 넣지 않은 것. 디스패처
 * (`/api/notifications/dispatch` handlePost)는 `player_tags` 가 비면 그 자리에서 `return []`
 * 하므로, board_id 가 선수판(`player/52605`)이어도 푸시 시도 자체가 0건이 된다.
 * 실측: 콜렉터 최근 글 50건 전부 `player_tags = []`.
 *
 * 포맷은 커뮤니티 SSOT 와 동일한 "kboId:이름"(formatPlayerTag). 로스터에서 이름이 해석되지 않으면
 * 빈 배열 — 이름 없는 태그("52605:")를 만들면 알림 제목이 깨지고, 태그 파서의 displayName 계약도
 * 무너진다. 임의 문자열을 지어내지 않고 알림을 포기하는 쪽이 안전하다(fail-close).
 *
 * board_type='team' 글은 특정 선수 글이 아니므로 태그가 없다 — 팀 공개범위(team_tags)만 남는다.
 *
 * supabase 를 import 하지 않는 순수 모듈 — 게이트가 실행 환경 없이 직접 호출할 수 있어야 한다.
 */
export function buildCollectorPlayerTags(matchedKboId: string | null): string[] {
  if (!matchedKboId) return [];
  const kboId = String(matchedKboId).trim();
  if (!kboId) return [];
  const name = playerNameForKboId(kboId);
  if (!name) return [];
  return [formatPlayerTag(kboId, name)];
}
