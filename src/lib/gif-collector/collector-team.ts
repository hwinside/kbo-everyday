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
import { resolveRosterPlayer, teamIdForKboId } from "@/lib/utils/player-roster";

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
 * 콜렉터 글의 player_tags 파생 (2026-08-16 하린아빠 요청 — 움짤/짤콜렉터 게시물 알림).
 *
 * posts INSERT webhook(handlePost)은 player_tags("kboId:이름")가 있어야
 * fav_player_post 토글 유저에게 푸시를 보낸다. 콜렉터 글은 사람이 피커로
 * 태그를 고르지 않으므로 매칭 결과(kboId)에서 파생한다.
 *
 * 규칙(안전 측):
 *  - 선수 게시판(board_type='player') + 로스터 canonical 이름 해석 성공일 때만 태그 1개.
 *  - 팀 게시판·이름 해석 실패는 null — 틀린 이름으로 알림이 나가느니 미발송이 낫다.
 *  - 이름에 ':' 가 들어갈 수 없는 구조(로스터 이름)라 "kboId:이름" 포맷과 충돌 없음.
 *
 * 순수 함수 — 게이트가 실행 환경 없이 직접 호출한다.
 */
export function collectorPlayerTags(
  boardType: string | null,
  matchedKboId: string | null,
): string[] | null {
  if (boardType !== "player" || !matchedKboId) return null;
  const player = resolveRosterPlayer({ name: null, kboId: matchedKboId });
  if (!player?.name) return null;
  return [`${matchedKboId}:${player.name}`];
}
