/**
 * 게시글 작성자 팀 ID 우선순위: author_team_id_snapshot > profiles.team_id.
 *
 * 게시 시점에 저장된 snapshot을 우선해 추후 작성자 profile 변경에도 과거 글의
 * 작성자 팀 배지가 안정적으로 유지되게 한다 (움짤콜렉터 봇이 매칭 선수 팀을
 * 동적으로 바꾸지만, 이미 발행된 글은 그 시점 팀으로 고정).
 */

interface PostLike {
  author_team_id_snapshot?: number | null;
  profiles?: { team_id?: number | null } | null;
}

/**
 * post의 작성자 팀 ID를 반환. snapshot이 있으면 그 값, 없으면 profile.team_id.
 * 양쪽 모두 없으면 null.
 */
export function effectiveAuthorTeamId(post: PostLike): number | null {
  if (post.author_team_id_snapshot != null) return post.author_team_id_snapshot;
  return post.profiles?.team_id ?? null;
}

/**
 * post 객체의 `profiles.team_id`를 `author_team_id_snapshot`으로 덮어쓴 새 객체를 반환.
 * 각 페이지/컴포넌트가 `profiles.team_id`를 직접 참조하더라도 자동으로 snapshot 효과.
 */
export function applyAuthorTeamSnapshot<T extends PostLike>(post: T): T {
  if (post.author_team_id_snapshot == null || !post.profiles) return post;
  return {
    ...post,
    profiles: { ...post.profiles, team_id: post.author_team_id_snapshot },
  };
}
