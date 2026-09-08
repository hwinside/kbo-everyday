-- 홈 최신글: 기간 제한 없이 최애팀 단독 공개 글을 작성시각순으로 조회한다.
-- 인기글 RPC/생성 컬럼은 유지한다. 앱은 별도 24시간 창·전체팀 인자로 호출한다.
create index if not exists posts_home_team_latest_idx
  on public.posts (team_tags, created_at desc, id desc)
  where is_hidden is not true;

create or replace function public.home_team_latest_posts(
  p_team_slug text,
  p_limit integer,
  p_other_kbo_ids text[] default '{}',
  p_blocked uuid[] default '{}',
  p_before_created_at timestamptz default null,
  p_before_id bigint default null
)
returns setof public.posts
language sql
stable
security invoker
set search_path = public
as $$
  select p.*
  from public.posts p
  where p_team_slug is not null
    and p.is_hidden is not true
    and p.team_tags = jsonb_build_array(p_team_slug)
    and not (p.author_id = any (coalesce(p_blocked, '{}')))
    and not exists (
      select 1
      from jsonb_array_elements_text(coalesce(p.player_tags, '[]'::jsonb)) as t(tag)
      where split_part(t.tag, ':', 1) = any (coalesce(p_other_kbo_ids, '{}'))
    )
    and (
      (p_before_created_at is null and p_before_id is null)
      or (p.created_at, p.id) < (p_before_created_at, p_before_id)
    )
  order by p.created_at desc, p.id desc
  limit least(greatest(coalesce(p_limit, 0), 0), 100);
$$;

revoke all on function public.home_team_latest_posts(text, integer, text[], uuid[], timestamptz, bigint) from public;
grant execute on function public.home_team_latest_posts(text, integer, text[], uuid[], timestamptz, bigint) to anon, authenticated;
