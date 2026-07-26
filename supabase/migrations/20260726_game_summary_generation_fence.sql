create sequence if not exists public.game_summary_generation_seq;

create table if not exists public.game_summary_generation_claims (
  game_id text primary key,
  generation_token bigint not null,
  claimed_at timestamptz not null default now()
);

alter table public.game_summary_generation_claims enable row level security;
revoke all on table public.game_summary_generation_claims from public, anon, authenticated;
revoke all on sequence public.game_summary_generation_seq from public, anon, authenticated;
grant select, insert, update, delete on table public.game_summary_generation_claims to service_role;
grant usage, select on sequence public.game_summary_generation_seq to service_role;

create or replace function public.claim_game_summary_generation(p_game_id text)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_token bigint;
begin
  if p_game_id is null or p_game_id = '' then
    raise exception 'game_id required';
  end if;

  v_token := nextval('public.game_summary_generation_seq');
  insert into public.game_summary_generation_claims (
    game_id,
    generation_token,
    claimed_at
  )
  values (
    p_game_id,
    v_token,
    now()
  )
  on conflict (game_id) do update
  set generation_token = excluded.generation_token,
      claimed_at = excluded.claimed_at
  where public.game_summary_generation_claims.generation_token < excluded.generation_token;

  return v_token;
end;
$$;

create or replace function public.save_game_summary_if_current(
  p_game_id text,
  p_generation_token bigint,
  p_summary jsonb,
  p_prompt_version integer
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_current_token bigint;
begin
  select generation_token
    into v_current_token
    from public.game_summary_generation_claims
   where game_id = p_game_id
   for update;

  if v_current_token is null or v_current_token is distinct from p_generation_token then
    return false;
  end if;

  insert into public.game_summaries (
    game_id,
    summary,
    prompt_version,
    created_at
  )
  values (
    p_game_id,
    p_summary,
    p_prompt_version,
    now()
  )
  on conflict (game_id) do update
  set summary = excluded.summary,
      prompt_version = excluded.prompt_version,
      created_at = excluded.created_at;

  return true;
end;
$$;

revoke all on function public.claim_game_summary_generation(text) from public, anon, authenticated;
revoke all on function public.save_game_summary_if_current(text, bigint, jsonb, integer) from public, anon, authenticated;
grant execute on function public.claim_game_summary_generation(text) to service_role;
grant execute on function public.save_game_summary_if_current(text, bigint, jsonb, integer) to service_role;
