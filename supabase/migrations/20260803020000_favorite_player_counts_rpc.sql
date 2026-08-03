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

create or replace function public.favorite_player_counts(p_active_player_ids text[])
returns table (player_id text, fan_count bigint)
language sql
stable
set search_path = pg_catalog, public
as $$
  with active_players as (
    -- 앱의 players-roster.json SSOT만 allowlist로 받는다. 호출 배열 자체도 1,000개로
    -- hard-bound해 잘못된 서버 호출이 profiles의 임의 JSONB ID를 결과 행으로 늘리지 못한다.
    select distinct btrim(candidate.player_id) as player_id
    from unnest(p_active_player_ids) as candidate(player_id)
    where cardinality(p_active_player_ids) between 1 and 1000
      and btrim(coalesce(candidate.player_id, '')) <> ''
    limit 1000
  )
  select
    active.player_id,
    count(distinct p.id) as fan_count
  from public.profiles as p
  cross join lateral jsonb_array_elements(
    case
      when jsonb_typeof(p.favorite_players) = 'array' then p.favorite_players
      else '[]'::jsonb
    end
  ) as element
  join active_players as active
    -- `->>` 는 jsonb string/number 를 모두 text 로 뽑는다(타입 혼재 정규화).
    on active.player_id = btrim(coalesce(element ->> 'playerId', ''))
  group by active.player_id
  order by fan_count desc, active.player_id
  limit 1000;
$$;

comment on function public.favorite_player_counts(text[]) is
  '활성 roster allowlist 안의 선수별 최애 지정 계정 수. 입력·출력 최대 1,000행, service_role 전용.';

-- 브라우저는 캐시된 서버 route만 호출한다. profiles 집계를 직접 반복 호출할 이유가 없다.
revoke all on function public.favorite_player_counts(text[]) from public, anon, authenticated;
grant execute on function public.favorite_player_counts(text[]) to service_role;
