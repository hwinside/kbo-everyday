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

-- ─────────────────────────────────────────────────────────────────────────────
-- 홈 인기글 페이지 RPC (설계 A, 하린아빠 2026-09-05 15:16 선택 / 삼순 #1343 4·5차).
-- 노출 조건을 전부 SQL 에서 판정해 클라이언트 필터·보충 조회가 없고, 페이지당 조회 1회로 정확히 N 행을 돌려준다.
--  · 최애팀 단독: team_tags = [p_team_slug] AND 선수 태그 중 **다른 팀 선수**(p_other_kbo_ids)가 하나도 없음.
--    태그는 'kboId:이름' 이므로 split_part(tag, ':', 1) 로 ID 만 비교한다 — 배지 SSOT(resolvePostScope)와 같은
--    ID 기준 판정. 이름 뒤 공백·표기 차이·로스터에 없는(은퇴) ID 는 SSOT 처럼 무시된다(삼순 5차 ③).
--  · 순위 이동: 인기도 커서 대신 p_exclude(화면에 이미 있는 id)로 다음 페이지를 뽑는다. 미노출 글의 점수가
--    올라가도(95→110) 다음 페이지 최상단에 나오고, 내려가도 중복되지 않는다(삼순 5차 ①). 누락 0·중복 0.
--  · 차단: author_id ∉ p_blocked.  · 소진: 호출자가 want+1 로 읽어 마지막 1행으로 판정.
--  · security invoker: posts RLS(공개 글 select)가 그대로 적용된다. limit 은 100 으로 상한.
create or replace function public.home_popular_posts(
  p_since timestamptz,
  p_limit integer,
  p_team_slug text default null,
  p_other_kbo_ids text[] default '{}',
  p_blocked uuid[] default '{}',
  p_exclude bigint[] default '{}'
)
returns setof public.posts
language sql
stable
security invoker
set search_path = public
as $$
  select p.*
  from public.posts p
  where p.created_at >= p_since
    and p.is_hidden is not true
    and not (p.id = any (coalesce(p_exclude, '{}')))
    and not (p.author_id = any (coalesce(p_blocked, '{}')))
    and (
      (p_team_slug is null and p.board_type in ('team', 'player', 'free', 'poll'))
      or (
        p_team_slug is not null
        and p.team_tags = jsonb_build_array(p_team_slug)
        and not exists (
          select 1
          from jsonb_array_elements_text(coalesce(p.player_tags, '[]'::jsonb)) as t(tag)
          where split_part(t.tag, ':', 1) = any (coalesce(p_other_kbo_ids, '{}'))
        )
      )
    )
  order by p.popularity desc, p.id desc
  limit least(greatest(coalesce(p_limit, 0), 0), 100);
$$;

grant execute on function public.home_popular_posts(timestamptz, integer, text, text[], uuid[], bigint[])
  to anon, authenticated;
