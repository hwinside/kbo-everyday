-- 홈 커뮤니티 섹션을 '최신글'에서 '최근 7일 인기글'로 전환(하린아빠 스펙 2026-09-05 #product).
-- 인기도 = 하트수 + 댓글수. PostgREST는 표현식 정렬(like_count + comment_count)을 못 하므로
-- STORED 생성 컬럼으로 두고 서버가 (popularity desc, id desc) keyset 페이징으로 정렬한다.
-- like_count/comment_count 는 트리거·RPC 가 갱신하는 카운터라 생성 컬럼이 항상 동기화된다.
-- coalesce 로 null 카운터(구 행) 방어 — 생성 컬럼이 null 이면 keyset 비교에서 행이 증발한다.

alter table public.posts
  add column if not exists popularity integer
    generated always as (coalesce(like_count, 0) + coalesce(comment_count, 0)) stored;

-- 홈 인기글 쿼리: where created_at >= now()-7d and is_hidden is not true [+ 보드 필터]
--                 order by popularity desc, id desc limit N
-- 7일 창 + 보드 필터로 후보가 수백 행이라 정렬 비용 자체는 작지만, 전체구단(all) 보드는
-- 팀 필터 없이 7일치 전량을 정렬하므로 정렬 순서와 같은 부분 인덱스를 둔다.
create index if not exists posts_popularity_id_idx
  on public.posts (popularity desc, id desc)
  where is_hidden is not true;
