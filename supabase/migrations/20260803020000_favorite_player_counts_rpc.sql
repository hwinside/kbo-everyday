-- 최애선수 선택 목록을 "실제 지정 계정 수" 내림차순으로 정렬하기 위한 집계 RPC.
--
-- 왜 클라이언트 집계가 아니라 RPC 인가:
--   profiles 를 PostgREST 로 긁어 앱에서 세면 (1) 기본 1000행 제한에 걸려 조용히
--   잘린 채 "인기순" 이라고 표시되고(2026-08-03 기준 profiles 25,552행 → 96% 유실),
--   (2) 다른 사용자의 프로필 행을 클라이언트로 내려보내게 된다.
--   집계는 DB 에서 끝내고 결과(선수 id + 카운트)만 내보낸다.
--
-- 노출 범위: playerId 와 집계 수치뿐이다. user id·닉네임 등 개인 식별 정보는 나가지 않는다.
--
-- 집계 기준(2026-08-03 실측):
--   profiles 25,552행 중 favorite_players 보유 16,822행, jsonb 원소 68,520개,
--   distinct 선수 632명. playerId 는 100% jsonb string 이지만, 과거 데이터나
--   외부 유입으로 number 가 섞여도 깨지지 않도록 `->>` 로 text 정규화한다.
--   같은 프로필이 같은 선수를 중복으로 담고 있어도 1명으로 센다(count distinct).
--   seq scan 기준 실행시간 ~200ms.

create or replace function public.favorite_player_counts()
returns table (player_id text, fan_count bigint)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    -- `->>` 는 jsonb string/number 를 모두 text 로 뽑는다(타입 혼재 정규화).
    btrim(element ->> 'playerId') as player_id,
    count(distinct p.id) as fan_count
  from public.profiles as p
  cross join lateral jsonb_array_elements(p.favorite_players) as element
  where jsonb_typeof(p.favorite_players) = 'array'
    and element ? 'playerId'
    and btrim(coalesce(element ->> 'playerId', '')) <> ''
  group by 1;
$$;

comment on function public.favorite_player_counts() is
  '선수별 최애선수 지정 계정 수. 개인 식별 정보 없이 playerId + 집계값만 반환한다. 온보딩 선수 선택 목록 인기순 정렬용.';

-- 온보딩은 비로그인 상태에서도 뜨므로 anon 도 읽을 수 있어야 한다.
-- security definer 지만 반환값에 개인정보가 없고 집계만 나간다.
revoke all on function public.favorite_player_counts() from public;
grant execute on function public.favorite_player_counts() to anon, authenticated, service_role;
