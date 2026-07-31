#!/usr/bin/env bash
set -euo pipefail

PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@17/bin}"
[ -x "$PGBIN/initdb" ] || { echo "SKIP: postgresql@17 binaries not found"; exit 0; }

REVIEW_ROOT="${OPENCLAW_REVIEW_ROOT:-/Volumes/T7-Dev/reviews/runtime}"
WORK="$(mktemp -d "$REVIEW_ROOT/baseball-rag-pg17.XXXXXX")"
PORT=59343

cleanup() {
  "$PGBIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

"$PGBIN/initdb" -D "$WORK/data" -A trust -U postgres --locale=C --encoding=UTF8 >/dev/null
"$PGBIN/pg_ctl" -D "$WORK/data" -o "-k $WORK -p $PORT -c fsync=off" -w start >/dev/null
PSQL=("$PGBIN/psql" -h "$WORK" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -qtA)

"${PSQL[@]}" -c "create role anon; create role authenticated; create role service_role;"
# Homebrew PG에는 pgvector가 없으므로 타입만 text로 치환한다. Supabase의 vector 설치 여부와
# 무관한 DDL/RPC/동시 claim 계약을 실제 PG17 파서·실행기로 검증한다.
sed \
  -e '/CREATE EXTENSION IF NOT EXISTS vector/d' \
  -e 's/embedding extensions\.vector/embedding text/' \
  supabase/migrations/20260731_baseball_genius_rag_sources.sql | "${PSQL[@]}"

"${PSQL[@]}" <<'SQL'
insert into public.genius_rag_sources (
  source_key, source_kind, entity_type, entity_id, page_title, candidate_urls,
  canonical_url, resolution_status, source_grade, question_count, last_question_at
) values
  ('namu:team:1', 'namu_document', 'team', '1', 'LG 트윈스', array['https://example/1'], 'https://example/1', 'resolved', 'secondary', 2, '2026-07-31T01:00:00Z'),
  ('namu:team:2', 'namu_document', 'team', '2', '두산 베어스', array['https://example/2'], 'https://example/2', 'resolved', 'secondary', 7, '2026-07-31T02:00:00Z'),
  ('namu:player:pending', 'namu_document', 'player', 'pending', '검증 전', array['https://example/p'], null, null, 'secondary', 99, '2026-07-31T03:00:00Z'),
  ('kbo:record:rank', 'kbo_structured', 'record_category', 'rank', '팀 순위', array['https://example/k'], 'https://example/k', 'resolved', 'official', 100, '2026-07-31T04:00:00Z');

do $$
declare
  claimed text[];
  updated_count integer;
begin
  select array_agg(source_key order by question_count desc)
    into claimed
  from public.claim_baseball_genius_rag_batch(2, 60);
  if claimed <> array['namu:team:2', 'namu:team:1'] then
    raise exception 'demand order/fail-close mismatch: %', claimed;
  end if;

  select public.record_baseball_genius_source_demand(array['namu:team:1', 'namu:team:1'])
    into updated_count;
  if updated_count <> 1 then
    raise exception 'demand dedupe mismatch: %', updated_count;
  end if;
  if (select question_count from public.genius_rag_sources where source_key = 'namu:team:1') <> 3 then
    raise exception 'demand counter mismatch';
  end if;
end;
$$;
SQL

echo "baseball QA source inventory PG17 PASS"
