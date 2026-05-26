-- posts.author_team_id_snapshot: 게시 시점의 작성자 팀 ID 스냅샷.
--
-- 배경 (2026-05-26):
-- 움짤콜렉터 봇이 매칭된 선수의 팀을 author 표시로 노출하되, 추후 봇 profile의
-- team_id가 변경되더라도 *이미 게시된 글의 작성자 팀 배지는 그대로 유지*해야 함.
-- 일반 유저도 향후 닉네임/팀 변경 시 과거 글의 표시 일관성을 위해 활용 가능.
--
-- 사용:
-- - publisher.ts: 봇 INSERT 시 매칭 선수의 team_id 저장
-- - 프론트: post.author_team_id_snapshot ?? profiles.team_id 우선순위

ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS author_team_id_snapshot INT NULL;

COMMENT ON COLUMN posts.author_team_id_snapshot IS
  '게시 시점의 작성자 팀 ID 스냅샷. 봇/유저 변경 시에도 과거 글 표시 안정성 보장. 일반 게시는 NULL(profiles.team_id로 fallback), 봇 게시는 매칭 선수 team_id.';
