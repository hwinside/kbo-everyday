-- frames-stale 관측 마커 (2026-09-01 LG:OB 볼카운트 고착 조사 후속)
--
-- 배경: relay 퍼블리셔가 "fetch 성공 + 내용 동일" 로 발행을 skip 하는 stale-equal(mode B)
-- 구간은 relay-failed/deadline-cut 어느 발현 마커도 안 남겨 원리적으로 관측 불가였다
-- (9/1 20:17~20:21 KST 프레임 갭 2회가 소거법으로만 추정됨). 퍼블리셔가 연속 무변경
-- streak 임계(20틱≈60초)·배증 지점에서 `<gameId>:frames-stale=<streak>` 마커를 남긴다.
--
-- 이 migration 은 tick_kind CHECK 에 'publisher'(relay-live-publisher 인보케이션 단위
-- 관측)를 추가한다. 기존 행·기존 쓰기 경로('initial'/'subtick')는 영향 없음.

alter table public.warmup_enrich_obs
  drop constraint warmup_enrich_obs_tick_kind_check;

alter table public.warmup_enrich_obs
  add constraint warmup_enrich_obs_tick_kind_check
  check (tick_kind in ('initial', 'subtick', 'publisher'));

comment on table public.warmup_enrich_obs is
  'warmup relay enrich + relay 퍼블리셔 발현 틱 관측 (service_role write-only, 판독용. 보존 14일 — warmup 정시 틱 기회적 GC). tick_kind=publisher 행은 frames-stale(stale-equal) 마커.';
