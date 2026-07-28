alter table public.game_summary_generation_claims
  add column if not exists source_fingerprint jsonb;

-- Rollout compatibility for old app instances: reuse a fresh token instead of
-- superseding an active generation. New instances use the fingerprint-aware RPC below.
create or replace function public.claim_game_summary_generation(p_game_id text)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_token bigint;
  v_claimed_at timestamptz;
begin
  if p_game_id is null or p_game_id = '' then
    raise exception 'game_id required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_game_id, 0));

  select generation_token, claimed_at
    into v_token, v_claimed_at
    from public.game_summary_generation_claims
   where game_id = p_game_id;

  if found and v_claimed_at > now() - interval '120 seconds' then
    return v_token;
  end if;

  v_token := nextval('public.game_summary_generation_seq');
  insert into public.game_summary_generation_claims (
    game_id,
    generation_token,
    claimed_at,
    source_fingerprint
  )
  values (
    p_game_id,
    v_token,
    now(),
    null
  )
  on conflict (game_id) do update
  set generation_token = excluded.generation_token,
      claimed_at = excluded.claimed_at,
      source_fingerprint = excluded.source_fingerprint;

  return v_token;
end;
$$;

create or replace function public.claim_game_summary_generation_singleflight(
  p_game_id text,
  p_source_fingerprint jsonb,
  p_stale_after_seconds integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_token bigint;
  v_claimed_at timestamptz;
  v_source_fingerprint jsonb;
  v_stale_after_seconds integer;
begin
  if p_game_id is null or p_game_id = '' then
    raise exception 'game_id required';
  end if;
  if p_source_fingerprint is null then
    raise exception 'source_fingerprint required';
  end if;

  v_stale_after_seconds := greatest(30, least(coalesce(p_stale_after_seconds, 120), 600));
  perform pg_advisory_xact_lock(hashtextextended(p_game_id, 0));

  select generation_token, claimed_at, source_fingerprint
    into v_token, v_claimed_at, v_source_fingerprint
    from public.game_summary_generation_claims
   where game_id = p_game_id;

  if found
     and v_source_fingerprint = p_source_fingerprint
     and v_claimed_at > now() - make_interval(secs => v_stale_after_seconds) then
    return jsonb_build_object(
      'generation_token', v_token::text,
      'should_generate', false,
      'takeover', false,
      'claimed_at', v_claimed_at
    );
  end if;

  v_token := nextval('public.game_summary_generation_seq');
  insert into public.game_summary_generation_claims (
    game_id,
    generation_token,
    claimed_at,
    source_fingerprint
  )
  values (
    p_game_id,
    v_token,
    now(),
    p_source_fingerprint
  )
  on conflict (game_id) do update
  set generation_token = excluded.generation_token,
      claimed_at = excluded.claimed_at,
      source_fingerprint = excluded.source_fingerprint;

  return jsonb_build_object(
    'generation_token', v_token::text,
    'should_generate', true,
    'takeover', v_claimed_at is not null,
    'claimed_at', now()
  );
end;
$$;

revoke all on function public.claim_game_summary_generation_singleflight(text, jsonb, integer)
  from public, anon, authenticated;
grant execute on function public.claim_game_summary_generation_singleflight(text, jsonb, integer)
  to service_role;
