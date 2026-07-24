-- 시작알림 정시 게이트 관측시각 "단조" 저장 (2026-07-24, PR #815 삼순 재리뷰 blocker).
--
-- 문제: warmup cron은 매분 돌지만 실행이 75초 넘게 겹칠 수 있다(느린 fetch/DB). 이때
-- 뒤늦게 끝난 "이전" invocation은 자기 관측시각(더 과거 observedAtMs)으로 마지막에 write
-- 하는데, 기존 unconditional upsert(last-write-wins)는 그 오래된 값이 최신
-- last_seen_scheduled_at을 "뒤로" 덮는다. 그러면 다음 live 틱이 실제보다 오래된 관측으로
-- 판정 → 관측상 연속(76초)인 정상 시작을 stale(예: 102초+)로 오판해 mark-only 억제한다.
--
-- 해결: ON CONFLICT DO UPDATE + GREATEST로 원자 단조 저장. 과거 방향(더 이른 관측) 갱신은
-- 무시하고 항상 가장 최신 관측만 유지한다. ON CONFLICT DO UPDATE는 충돌 행에 락을 잡으므로
-- 겹친 write가 직렬화되어 인터리빙에서도 단조성이 보장된다. GREATEST는 NULL을 무시하므로
-- 최초 관측(기존 NULL)은 그대로 기록된다.
create or replace function mark_scheduled_seen(p_game_ids text[], p_observed_at timestamptz)
returns void
language sql
set search_path = public
as $$
  insert into game_notify_state (game_id, last_seen_scheduled_at)
  select distinct unnest(p_game_ids), p_observed_at
  on conflict (game_id) do update
    set last_seen_scheduled_at = greatest(
      game_notify_state.last_seen_scheduled_at,
      excluded.last_seen_scheduled_at
    );
$$;

-- cron(service_role)만 호출. 클라이언트 롤 차단(default deny).
revoke all on function mark_scheduled_seen(text[], timestamptz) from anon, authenticated, public;
grant execute on function mark_scheduled_seen(text[], timestamptz) to service_role;
