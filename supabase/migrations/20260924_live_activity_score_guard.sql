-- Durable correction probation, shared by broadcast/legacy and serverless workers.
create table if not exists public.live_activity_score_guards (
  game_id text not null,
  baseline text not null,
  last_observed_at timestamptz not null default '-infinity',
  candidate text,
  candidate_since timestamptz,
  candidate_count integer not null default 0,
  candidate_counted_at timestamptz,
  blocked_since timestamptz,
  blocked_count integer not null default 0,
  allow_correction boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (game_id, baseline)
);
alter table public.live_activity_score_guards enable row level security;
revoke all on public.live_activity_score_guards from anon, authenticated;
grant all on public.live_activity_score_guards to service_role;
create index if not exists live_activity_score_guards_updated_idx on public.live_activity_score_guards(updated_at);

create or replace function public.observe_live_activity_score_guard(
  p_game_id text, p_baseline text, p_candidate text, p_observed_at timestamptz,
  p_regressed boolean, p_eligible boolean, p_corroborated boolean
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s public.live_activity_score_guards%rowtype;
  elapsed_ms bigint;
begin
  if p_observed_at is null or p_observed_at > clock_timestamp() + interval '5 seconds' then
    raise exception 'invalid observation time';
  end if;
  -- Expired episodes are removed by the daily admin-telemetry-retention cron.
  insert into public.live_activity_score_guards(game_id, baseline) values(p_game_id, p_baseline)
    on conflict do nothing;
  select * into s from public.live_activity_score_guards
    where game_id = p_game_id and baseline = p_baseline for update;
  -- Same fetched snapshot counted once, regardless of env, catch-up, legacy, or retries.
  if p_observed_at < s.last_observed_at then
    return jsonb_build_object('allowCorrection', false, 'blockedCount', s.blocked_count, 'blockedMs', 0, 'outOfOrder', true);
  end if;
  if p_observed_at > s.last_observed_at then
    if not p_regressed then
      s.candidate := null; s.candidate_since := null; s.candidate_count := 0;
      s.candidate_counted_at := null;
      s.blocked_since := null; s.blocked_count := 0; s.allow_correction := false;
    else
      s.blocked_since := coalesce(s.blocked_since, p_observed_at);
      s.blocked_count := s.blocked_count + 1;
      if p_eligible then
        if s.candidate is distinct from p_candidate or s.candidate_since is null or
            p_observed_at - s.last_observed_at > interval '90 seconds' then
          s.candidate := p_candidate; s.candidate_since := p_observed_at; s.candidate_count := 1;
          s.candidate_counted_at := p_observed_at;
        elsif p_observed_at - s.candidate_counted_at >= interval '10 seconds' then
          s.candidate_count := s.candidate_count + 1;
          s.candidate_counted_at := p_observed_at;
        end if;
      else
        s.candidate := null; s.candidate_since := null; s.candidate_count := 0;
        s.candidate_counted_at := null;
      end if;
      -- Only fresh direct relay with non-retreating inning/status can time out the guard.
      -- A stale KBO/frames fallback never becomes trustworthy just by persisting.
      s.allow_correction := p_eligible and (p_corroborated or
        (s.candidate_count >= 3 and p_observed_at - s.candidate_since >= interval '30 seconds'));
    end if;
    s.last_observed_at := p_observed_at;
    update public.live_activity_score_guards set
      last_observed_at = s.last_observed_at, candidate = s.candidate,
      candidate_since = s.candidate_since, candidate_count = s.candidate_count,
      candidate_counted_at = s.candidate_counted_at,
      blocked_since = s.blocked_since, blocked_count = s.blocked_count,
      allow_correction = s.allow_correction, updated_at = now()
      where game_id = p_game_id and baseline = p_baseline;
  end if;
  elapsed_ms := coalesce((extract(epoch from (s.last_observed_at - s.blocked_since)) * 1000)::bigint, 0);
  return jsonb_build_object('allowCorrection', s.allow_correction,
    'blockedCount', s.blocked_count, 'blockedMs', elapsed_ms, 'candidateCount', s.candidate_count);
end;
$$;
revoke all on function public.observe_live_activity_score_guard(text,text,text,timestamptz,boolean,boolean,boolean) from public, anon, authenticated;
grant execute on function public.observe_live_activity_score_guard(text,text,text,timestamptz,boolean,boolean,boolean) to service_role;
