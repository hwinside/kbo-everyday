#!/usr/bin/env bash
set -euo pipefail

PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@17/bin}"
[ -x "$PGBIN/initdb" ] || { echo "SKIP: postgresql@17 binaries not found"; exit 0; }

export LC_ALL=C
export LANG=C
REVIEW_ROOT="${OPENCLAW_REVIEW_ROOT:-/Volumes/T7-Dev/reviews/runtime}"
WORK="$(mktemp -d "$REVIEW_ROOT/player-popularity-pg17.XXXXXX")"
PORT="$(node -e 'const net=require("net");const s=net.createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>console.log(p));});')"

cleanup() {
  "$PGBIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

"$PGBIN/initdb" -D "$WORK/data" -A trust -U postgres --locale=C --encoding=UTF8 >/dev/null
"$PGBIN/pg_ctl" -D "$WORK/data" -o "-k $WORK -p $PORT -c fsync=off" -w start >/dev/null
PSQL=("$PGBIN/psql" -h "$WORK" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -qtA)

"${PSQL[@]}" <<'SQL'
create role anon;
create role authenticated;
create role service_role bypassrls;
create table public.profiles (id uuid primary key, favorite_players jsonb);
grant select on public.profiles to service_role;
SQL
"${PSQL[@]}" -f supabase/migrations/20260803020000_favorite_player_counts_rpc.sql

"${PSQL[@]}" <<'SQL'
insert into public.profiles values
  ('00000000-0000-0000-0000-000000000001',
    (select jsonb_agg(jsonb_build_object('playerId', 'fake-' || n)) from generate_series(1, 2000) n)),
  ('00000000-0000-0000-0000-000000000002',
    '[{"playerId":"real-1"},{"playerId":"real-1"},{"playerId":"real-2"},
      {"playerId":"real-3"},{"playerId":"real-4"},{"playerId":"real-5"},{"playerId":"real-6"}]'),
  ('00000000-0000-0000-0000-000000000003', '{"playerId":"not-an-array"}'),
  ('00000000-0000-0000-0000-000000000004', 'null');

do $$
declare
  fake_rows bigint;
  bounded_rows bigint;
  real_one_count bigint;
  oversized_rows bigint;
begin
  select count(*) filter (where player_id like 'fake-%') into fake_rows
  from public.favorite_player_counts(array['real-1','real-2','real-3','real-4','real-5','real-6']);
  if fake_rows <> 0 then
    raise exception 'synthetic fake ID escaped active roster allowlist: %', fake_rows;
  end if;

  select count(*) into bounded_rows
  from public.favorite_player_counts(array['real-1','real-2','real-3','real-4','real-5','real-6']);
  if bounded_rows > 6 then
    raise exception 'result exceeded active roster bound: %', bounded_rows;
  end if;

  select fan_count into real_one_count
  from public.favorite_player_counts(array['real-1']) where player_id = 'real-1';
  if real_one_count <> 1 then
    raise exception 'duplicate favorite was not counted per account: %', real_one_count;
  end if;

  select count(*) into oversized_rows
  from public.favorite_player_counts(
    array(select 'candidate-' || n from generate_series(1, 1001) n)
  );
  if oversized_rows <> 0 then
    raise exception 'oversized allowlist must fail closed, got % rows', oversized_rows;
  end if;
end;
$$;

do $$
begin
  if has_function_privilege('anon', 'public.favorite_player_counts(text[])', 'EXECUTE') then
    raise exception 'anon still has direct RPC execute';
  end if;
  if has_function_privilege('authenticated', 'public.favorite_player_counts(text[])', 'EXECUTE') then
    raise exception 'authenticated still has direct RPC execute';
  end if;
  if not has_function_privilege('service_role', 'public.favorite_player_counts(text[])', 'EXECUTE') then
    raise exception 'service_role execute missing';
  end if;
end;
$$;
SQL

FAKE_RETURNED="$("${PSQL[@]}" -c "select count(*) from public.favorite_player_counts(array(select 'fake-' || n from generate_series(1, 2000) n))")"
[ "$FAKE_RETURNED" = "0" ]
echo "PASS PG17 player popularity: synthetic_fake=2000 fake_returned=0 hard_bound=1000 anon_execute=false"
