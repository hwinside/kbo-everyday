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
# Homebrew PG에는 pgvector가 없으므로 타입만 text로 치환한다. 나머지 DDL/RPC/trigger는
# 실제 PG17 파서·실행기로 검증한다.
sed \
  -e '/CREATE EXTENSION IF NOT EXISTS vector/d' \
  -e 's/embedding extensions\.vector(768)/embedding text/' \
  supabase/migrations/20260731_baseball_genius_rag_sources.sql | "${PSQL[@]}"

# committed inventory는 migration 직후 928행을 만들며 재실행해도 중복되지 않는다.
"${PSQL[@]}" -f supabase/migrations/20260731_baseball_genius_rag_sources_seed.sql
"${PSQL[@]}" -f supabase/migrations/20260731_baseball_genius_rag_sources_seed.sql
[ "$("${PSQL[@]}" -c 'select count(*) from public.genius_rag_sources')" = "928" ]
[ "$("${PSQL[@]}" -c "select count(*) from public.genius_rag_sources where entity_type='player' and resolution_status is null")" = "878" ]
[ "$("${PSQL[@]}" -c "select count(*) from public.claim_baseball_genius_rag_batch(50, 60) where entity_type='player'")" = "0" ]

"${PSQL[@]}" <<'SQL'
-- resolved/null, ready/pending, KBO chunk는 모두 DB에서 거부한다.
do $$
begin
  begin
    insert into public.genius_rag_sources (
      source_key, source_kind, entity_type, entity_id, page_title, candidate_urls,
      canonical_url, resolution_status, source_grade, identity_fingerprint
    ) values ('bad:grade-pair', 'namu_document', 'player', 'bad0', 'bad', array['https://example/bad'],
      'https://example/bad', 'resolved', 'tier1', 'bad0');
  exception when others then null;
  end;
  if exists (select 1 from public.genius_rag_sources where source_key='bad:grade-pair') then
    raise exception 'source kind/grade mismatch accepted';
  end if;

  begin
    insert into public.genius_rag_sources (
      source_key, source_kind, entity_type, entity_id, page_title, candidate_urls,
      canonical_url, resolution_status, source_grade, identity_fingerprint
    ) values ('bad:resolved-null', 'namu_document', 'player', 'bad1', 'bad', array['https://example/bad'], null, 'resolved', 'tier2', 'bad1');
  exception when others then null;
  end;
  if exists (select 1 from public.genius_rag_sources where source_key='bad:resolved-null') then
    raise exception 'resolved-null accepted';
  end if;

  begin
    insert into public.genius_rag_sources (
      source_key, source_kind, entity_type, entity_id, page_title, candidate_urls,
      source_grade, identity_fingerprint, ingestion_status, revision, content_hash, crawled_at, ingested_at
    ) values ('bad:ready-pending', 'namu_document', 'player', 'bad2', 'bad', array['https://example/bad'],
      'tier2', 'bad2', 'ready', 'r', 'h', now(), now());
  exception when others then null;
  end;
  if exists (select 1 from public.genius_rag_sources where source_key='bad:ready-pending') then
    raise exception 'pending-ready accepted';
  end if;

  begin
    insert into public.genius_rag_chunks (
      source_key, source_kind, entity_type, entity_id, page_title, canonical_url,
      revision, section_path, chunk_index, content, document_content_hash, content_hash, source_grade,
      crawled_at, as_of, claim_token, claim_generation
    ) values ('kbo:record:team-rank', 'kbo_structured', 'record_category', 'team-rank', '팀 순위',
      'https://www.koreabaseball.com/Record/TeamRank/TeamRank.aspx', 'r', 's', 0,
      repeat('x', 40), 'dh', 'h', 'tier1', now(), current_date, gen_random_uuid(), 1);
  exception when others then null;
  end;
  if exists (select 1 from public.genius_rag_chunks where source_key='kbo:record:team-rank') then
    raise exception 'KBO embedding chunk accepted';
  end if;
end;
$$;

-- attempts=3인 expired owner는 더 이상 claim되지 않는다.
update public.genius_rag_sources
set ingestion_status='ingesting', ingestion_attempts=3, lease_until=now()-interval '1 second',
    claim_token=gen_random_uuid(), claim_generation=3
where source_key='namu:team:1';
do $$
begin
  perform * from public.claim_baseball_genius_rag_batch(50, 60);
  if (select ingestion_attempts from public.genius_rag_sources where source_key='namu:team:1') <> 3 then
    raise exception 'expired owner exceeded retry bound';
  end if;
end;
$$;

-- old owner는 reclaim 뒤 chunk write/complete를 할 수 없다(CAS generation+token).
update public.genius_rag_sources
set ingestion_status='not_started', ingestion_attempts=0, lease_until=null, claim_token=null,
    claim_generation=0, question_count=1000
where source_key='namu:team:2';
do $$
declare
  first_claim public.genius_rag_sources%rowtype;
  second_claim public.genius_rag_sources%rowtype;
  completed boolean;
begin
  select * into first_claim from public.claim_baseball_genius_rag_batch(1, 60);
  insert into public.genius_rag_chunks (
    source_key, entity_type, entity_id, page_title, canonical_url, revision, section_path,
    chunk_index, content, document_content_hash, content_hash, source_grade, crawled_at, as_of,
    claim_token, claim_generation
  ) values (
    first_claim.source_key, first_claim.entity_type, first_claim.entity_id, first_claim.page_title,
    first_claim.canonical_url, 'r1', '개요', 0, repeat('content ', 6), 'doc1', 'h1', first_claim.source_grade,
    '2026-07-31T00:00:00Z', '2026-07-31', first_claim.claim_token, first_claim.claim_generation
  );
  update public.genius_rag_sources set lease_until=now()-interval '1 second'
    where source_key=first_claim.source_key;
  select * into second_claim from public.claim_baseball_genius_rag_batch(1, 60);
  if second_claim.source_key <> first_claim.source_key
    or second_claim.claim_token = first_claim.claim_token
    or second_claim.claim_generation <> first_claim.claim_generation + 1 then
    raise exception 'reclaim owner generation mismatch';
  end if;
  select public.complete_baseball_genius_rag_source(
    first_claim.source_key, first_claim.claim_token, first_claim.claim_generation,
    'r1', 'doc1', '2026-07-31T00:00:00Z', '2026-08-01T00:00:00Z'
  ) into completed;
  if completed then raise exception 'stale owner completed after reclaim'; end if;

  update public.genius_rag_sources
  set identity_fingerprint = identity_fingerprint || '-changed'
  where source_key = first_claim.source_key;
  if exists (select 1 from public.genius_rag_chunks where source_key = first_claim.source_key) then
    raise exception 'identity drift preserved stale chunks';
  end if;
end;
$$;

-- 동일 source demand 입력은 한 번만 증가한다.
do $$
declare updated_count integer;
begin
  select public.record_baseball_genius_source_demand(array['namu:team:3', 'namu:team:3']) into updated_count;
  if updated_count <> 1 then raise exception 'demand dedupe mismatch'; end if;
end;
$$;
SQL

# 두 worker가 동시에 claim해도 20개 source가 중복 없이 정확히 한 번씩 배정된다.
"${PSQL[@]}" <<'SQL'
update public.genius_rag_sources set ingestion_status='tombstoned' where source_kind='namu_document';
insert into public.genius_rag_sources (
  source_key, source_kind, entity_type, entity_id, page_title, candidate_urls, canonical_url,
  resolution_status, source_grade, identity_fingerprint, question_count
)
select 'concurrent:'||n, 'namu_document', 'team', 'c'||n, 'team'||n,
  array['https://example/'||n], 'https://example/'||n, 'resolved', 'tier2', 'fp'||n, n
from generate_series(1,20) n;
SQL
"${PSQL[@]}" -c "select source_key from public.claim_baseball_genius_rag_batch(10, 60)" > "$WORK/a" &
PID_A=$!
"${PSQL[@]}" -c "select source_key from public.claim_baseball_genius_rag_batch(10, 60)" > "$WORK/b" &
PID_B=$!
wait "$PID_A" "$PID_B"
[ "$(sort -u "$WORK/a" "$WORK/b" | wc -l | tr -d ' ')" = "20" ]
[ "$(cat "$WORK/a" "$WORK/b" | wc -l | tr -d ' ')" = "20" ]

echo "baseball QA source inventory PG17 PASS (seed928·pending878·fault/CAS/concurrency)"
