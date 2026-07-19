-- 워치(갤워치 Wear OS + 애플워치) 앱 사용 계측 (2026-07-19 하린아빠 요청 "로깅하자").
-- 두 워치 앱은 매 동기화마다 고유 UA로 /api/standings를 정확히 1번 호출한다:
--   Wear OS(WearFetcher)   = kbo-everyday-wear/1.0   → platform 'wear'
--   Apple Watch(WatchData) = kbo-everyday-watch/1.0  → platform 'apple'
-- /api/standings는 CDN 캐시(s-maxage=300)라 라우트 핸들러는 캐시 미스에만 실행 → 캐시 앞단
-- 미들웨어(service_role)에서 계측해야 워치 요청을 전량 잡는다. 미들웨어가 원본 IP+platform을
-- 넘기면 이 RPC가 서버측에서 IP 해시(원본 미저장) + 일자·플랫폼별 upsert 증가한다.
-- ⚠️ 이 마이그레이션은 PR 머지 전 prod에 선적용해야 한다(미들웨어가 record_watch_ping에 의존).

-- Supabase는 pgcrypto를 extensions 스키마에 설치한다(public 아님). digest()는 반드시 extensions.digest로 명시.
create extension if not exists pgcrypto with schema extensions;

-- 일자(KST)·플랫폼·해시IP 단위 집계 — distinct ip_hash ≈ 대략의 워치 대수, sum(hits) = 호출량.
create table if not exists watch_pings (
  ping_date  date        not null,
  platform   text        not null,          -- 'wear'(갤워치 Wear OS) | 'apple'(애플워치)
  ip_hash    text        not null,
  hits       integer     not null default 1,
  first_seen timestamptz not null default now(),
  last_seen  timestamptz not null default now(),
  primary key (ping_date, platform, ip_hash)
);

-- service_role 전용(정책 0). 익명/유저 접근 차단.
alter table watch_pings enable row level security;

-- 미들웨어(service_role)가 호출 — 원본 IP를 받아 상수 salt로 해시(원본 미저장) + KST 일자·플랫폼별 upsert 증가.
-- IPv4는 저엔트로피라 해시가 강한 익명화는 아니지만, 원본 IP를 at-rest로 저장하지 않는 이점(방어 심층화).
create or replace function record_watch_ping(p_ip text, p_platform text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  h text;
  plat text;
begin
  plat := case when p_platform in ('wear', 'apple') then p_platform else 'unknown' end;
  -- ⚠️ extensions.digest 명시 — 함수 search_path=public이라 스키마 미지정 시 'function digest does not exist' (삼순 2차 P0).
  h := encode(
    extensions.digest(coalesce(nullif(p_ip, ''), 'unknown') || '::kbo-watch-ping', 'sha256'),
    'hex'
  );
  insert into watch_pings (ping_date, platform, ip_hash, hits)
  values ((now() at time zone 'Asia/Seoul')::date, plat, h, 1)
  on conflict (ping_date, platform, ip_hash)
  do update set hits = watch_pings.hits + 1, last_seen = now();
end;
$$;

-- 어드민 조회 — 일자·플랫폼별 distinct 워치(≈IP) + 총 호출량.
create or replace function admin_watch_activity(p_since date)
returns table (day date, platform text, devices bigint, hits bigint)
language sql
security definer
set search_path = public
as $$
  select ping_date as day, platform, count(*)::bigint as devices, sum(hits)::bigint as hits
  from watch_pings
  where ping_date >= p_since
  group by ping_date, platform
  order by ping_date, platform;
$$;

revoke all on function record_watch_ping(text, text) from public;
revoke all on function admin_watch_activity(date) from public;
grant execute on function record_watch_ping(text, text) to service_role;
grant execute on function admin_watch_activity(date) to service_role;
