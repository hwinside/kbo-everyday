-- 커뮤니티 검색 v1: 전체글 제목·본문 부분일치 (#cs 건의함 feedback:8f16ef65).
--
-- 설계 요지
--  * pg_trgm GIN 인덱스 2개(title, content) + ILIKE. 한국어 토크나이저가 없어 tsvector 는 어절을 못 잡으므로
--    음절 단위 트리그램 부분일치를 택했다. pg_trgm 확장은 20260723_query_opt_indexes.sql 에서 이미 활성화.
--  * 검색어 가드(길이 2~50)·LIKE 이스케이프(\ % _)는 **이 함수 한 곳에서만** 처리한다(삼순 리뷰 ①).
--    클라이언트는 원문을 그대로 넘기고 어떤 이스케이프도 하지 않는다 — 두 곳에서 처리하면 `%`·`_`·`\`
--    리터럴 검색 결과가 달라진다.
--  * security invoker → posts 의 기존 public SELECT 정책이 그대로 적용된다. 신규 정책 없음.
--  * returns setof public.posts → PostgREST 가 테이블 함수로 취급해 `select("…, profiles(...)")` 임베딩이
--    기존 피드 SELECT 상수 그대로 붙는다(useUnifiedFeed 재사용, 삼순 리뷰 ②).
--  * 키셋: id desc + before_id (기존 피드와 동일). limit 상한 50 (query-pagination-policy boundedRpcAllowlist).

create extension if not exists pg_trgm;

create index if not exists idx_posts_title_trgm
  on public.posts using gin (title gin_trgm_ops);

create index if not exists idx_posts_content_trgm
  on public.posts using gin (content gin_trgm_ops);

create or replace function public.search_posts(
  q text,
  before_id bigint default null,
  page_size int default 20
)
returns setof public.posts
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  raw text := btrim(coalesce(q, ''));
  pat text;
begin
  -- 길이 가드: 1자(트리그램 미형성·전수 탐색)·51자 이상은 빈 결과. 에러가 아니라 빈 집합이어야
  -- 클라이언트가 "검색 결과 없음"으로 자연 처리된다.
  if char_length(raw) < 2 or char_length(raw) > 50 then
    return;
  end if;

  -- LIKE 메타문자 이스케이프(유일 지점). 역슬래시를 먼저 처리해야 뒤에서 넣는 이스케이프 문자가 다시 이스케이프되지 않는다.
  pat := '%' || replace(replace(replace(raw, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  return query
    select p.*
    from public.posts p
    where p.is_hidden is not true
      and p.board_type in ('team', 'player', 'free', 'poll')
      and (p.title ilike pat escape '\' or p.content ilike pat escape '\')
      and (before_id is null or p.id < before_id)
    order by p.id desc
    limit least(greatest(coalesce(page_size, 20), 1), 50);
end;
$$;

comment on function public.search_posts(text, bigint, int) is
  '커뮤니티 전체글 제목·본문 부분일치 검색. 길이 가드·LIKE 이스케이프는 이 함수가 유일 지점. id desc 키셋, limit ≤ 50.';

grant execute on function public.search_posts(text, bigint, int) to anon, authenticated;
