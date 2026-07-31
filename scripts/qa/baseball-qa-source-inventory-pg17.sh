#!/usr/bin/env bash
set -euo pipefail

PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@17/bin}"
[ -x "$PGBIN/initdb" ] || { echo "SKIP: postgresql@17 binaries not found"; exit 0; }

# locale이 비어 있으면 macOS에서 postmaster가
# "became multithreaded during startup"로 즉사해 게이트가 아예 돌지 않는다(실제 겪음).
# initdb가 --locale=C 로 클러스터를 만드므로 런타임도 C로 고정한다.
export LC_ALL=C
export LANG=C

REVIEW_ROOT="${OPENCLAW_REVIEW_ROOT:-/Volumes/T7-Dev/reviews/runtime}"
WORK="$(mktemp -d "$REVIEW_ROOT/baseball-rag-pg17.XXXXXX")"
# 고정 포트는 병렬 리뷰·CI job 간 충돌로 서버 기동을 실패시킨다(실제 겪음). 빈 포트를 골라 쓴다.
pick_free_port() {
  node -e 'const net=require("net");const s=net.createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>console.log(p));});'
}
PORT="${BASEBALL_RAG_PG_PORT:-$(pick_free_port)}"

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
  -e 's/p_embedding extensions\.vector(768)/p_embedding text/' \
  -e 's/timestamptz, date, extensions\.vector(768), jsonb/timestamptz, date, text, jsonb/' \
  supabase/migrations/20260731_baseball_genius_rag_sources.sql | "${PSQL[@]}"

# committed inventory는 migration 직후 932행을 만들며 재실행해도 중복되지 않는다.
"${PSQL[@]}" -f supabase/migrations/20260731_baseball_genius_rag_sources_seed.sql
"${PSQL[@]}" -f supabase/migrations/20260731_baseball_genius_rag_sources_seed.sql
[ "$("${PSQL[@]}" -c 'select count(*) from public.genius_rag_sources')" = "932" ]
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
    claim_token, claim_generation, embedding
  ) values (
    first_claim.source_key, first_claim.entity_type, first_claim.entity_id, first_claim.page_title,
    first_claim.canonical_url, 'r1', '개요', 0, repeat('content ', 6), 'doc1', 'h1', first_claim.source_grade,
    '2026-07-31T00:00:00Z', '2026-07-31', first_claim.claim_token, first_claim.claim_generation, 'vec-768'
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

  -- identity drift 회귀는 현 generation chunk가 존재해야 의미가 있다(reclaim이 구 generation을 이미 지운다).
  perform public.upsert_baseball_genius_rag_chunk(
    second_claim.source_key, second_claim.claim_token, second_claim.claim_generation,
    second_claim.entity_type, second_claim.entity_id, second_claim.page_title,
    second_claim.canonical_url, 'r1', '개요', 0, repeat('content ', 6), 'doc1', 'h1',
    second_claim.source_grade, '2026-07-31T00:00:00Z', '2026-07-31', 'vec-768'
  );
  if not exists (select 1 from public.genius_rag_chunks where source_key = first_claim.source_key) then
    raise exception 'identity drift precondition missing current-generation chunk';
  end if;

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

-- [B1] embedding 없는 chunk는 저장 자체가 거부되고, 설사 우회로 남아도 ready로 올라가지 못한다.
update public.genius_rag_sources
set ingestion_status='not_started', ingestion_attempts=0, lease_until=null, claim_token=null,
    claim_generation=0, question_count=900, revision=null, content_hash=null,
    crawled_at=null, ingested_at=null
where source_key='namu:team:4';
do $$
declare
  claim public.genius_rag_sources%rowtype;
  completed boolean;
  null_rejected boolean := false;
begin
  select * into claim from public.claim_baseball_genius_rag_batch(1, 60);
  if claim.source_key <> 'namu:team:4' then raise exception 'B1 setup claim mismatch'; end if;

  -- RPC는 embedding NULL을 명시 거부한다.
  begin
    perform public.upsert_baseball_genius_rag_chunk(
      claim.source_key, claim.claim_token, claim.claim_generation, claim.entity_type, claim.entity_id,
      claim.page_title, claim.canonical_url, 'rB1', '개요', 0, repeat('content ', 6), 'docB1', 'hB1',
      claim.source_grade, '2026-07-31T00:00:00Z', '2026-07-31', null
    );
  exception when others then null_rejected := true;
  end;
  if not null_rejected then raise exception 'B1 embedding-null chunk accepted by rpc'; end if;

  -- 테이블 제약 자체도 NOT NULL이다.
  null_rejected := false;
  begin
    insert into public.genius_rag_chunks (
      source_key, entity_type, entity_id, page_title, canonical_url, revision, section_path,
      chunk_index, content, document_content_hash, content_hash, source_grade, crawled_at, as_of,
      claim_token, claim_generation, embedding
    ) values (
      claim.source_key, claim.entity_type, claim.entity_id, claim.page_title, claim.canonical_url,
      'rB1', '개요', 1, repeat('content ', 6), 'docB1', 'hB1n', claim.source_grade,
      '2026-07-31T00:00:00Z', '2026-07-31', claim.claim_token, claim.claim_generation, null
    );
  exception when others then null_rejected := true;
  end;
  if not null_rejected then raise exception 'B1 embedding-null chunk accepted by table'; end if;

  -- 정상 chunk 1건 → complete 성공(GREEN).
  perform public.upsert_baseball_genius_rag_chunk(
    claim.source_key, claim.claim_token, claim.claim_generation, claim.entity_type, claim.entity_id,
    claim.page_title, claim.canonical_url, 'rB1', '개요', 0, repeat('content ', 6), 'docB1', 'hB1',
    claim.source_grade, '2026-07-31T00:00:00Z', '2026-07-31', 'vec-768'
  );
  select public.complete_baseball_genius_rag_source(
    claim.source_key, claim.claim_token, claim.claim_generation,
    'rB1', 'docB1', '2026-07-31T00:00:00Z', '2026-08-01T00:00:00Z'
  ) into completed;
  if not completed then raise exception 'B1 valid embedded chunk failed to complete'; end if;

  -- 같은 generation에 embedding NULL chunk가 섮이면 ready 승격을 거부한다(제약 우회 주입).
  update public.genius_rag_sources
  set ingestion_status='ingesting', lease_until=clock_timestamp()+interval '60 seconds',
      claim_token=claim.claim_token
  where source_key=claim.source_key;
  alter table public.genius_rag_chunks alter column embedding drop not null;
  insert into public.genius_rag_chunks (
    source_key, entity_type, entity_id, page_title, canonical_url, revision, section_path,
    chunk_index, content, document_content_hash, content_hash, source_grade, crawled_at, as_of,
    claim_token, claim_generation, embedding
  ) values (
    claim.source_key, claim.entity_type, claim.entity_id, claim.page_title, claim.canonical_url,
    'rB1', '본문', 0, repeat('content ', 6), 'docB1', 'hB1x', claim.source_grade,
    '2026-07-31T00:00:00Z', '2026-07-31', claim.claim_token, claim.claim_generation, null
  );
  select public.complete_baseball_genius_rag_source(
    claim.source_key, claim.claim_token, claim.claim_generation,
    'rB1', 'docB1', '2026-07-31T00:00:00Z', '2026-08-01T00:00:00Z'
  ) into completed;
  if completed then raise exception 'B1 ready granted with embedding-null sibling chunk'; end if;
  delete from public.genius_rag_chunks where source_key=claim.source_key and embedding is null;
  alter table public.genius_rag_chunks alter column embedding set not null;
end;
$$;

-- [B3] gen1 partial chunk → crash → reclaim → gen2가 같은 revision/section/index를 재생성해 ready까지 간다.
update public.genius_rag_sources
set ingestion_status='not_started', ingestion_attempts=0, lease_until=null, claim_token=null,
    claim_generation=0, question_count=800, revision=null, content_hash=null,
    crawled_at=null, ingested_at=null
where source_key='namu:team:5';
do $$
declare
  gen1 public.genius_rag_sources%rowtype;
  gen2 public.genius_rag_sources%rowtype;
  completed boolean;
  stale_rejected boolean := false;
begin
  select * into gen1 from public.claim_baseball_genius_rag_batch(1, 60);
  if gen1.source_key <> 'namu:team:5' then raise exception 'B3 setup claim mismatch'; end if;
  perform public.upsert_baseball_genius_rag_chunk(
    gen1.source_key, gen1.claim_token, gen1.claim_generation, gen1.entity_type, gen1.entity_id,
    gen1.page_title, gen1.canonical_url, 'rB3', '개요', 0, repeat('content ', 6), 'docB3', 'hB3',
    gen1.source_grade, '2026-07-31T00:00:00Z', '2026-07-31', 'vec-768'
  );

  -- crash: lease 만료
  update public.genius_rag_sources set lease_until=now()-interval '1 second' where source_key=gen1.source_key;
  select * into gen2 from public.claim_baseball_genius_rag_batch(1, 60);
  if gen2.source_key <> gen1.source_key or gen2.claim_generation <> gen1.claim_generation + 1 then
    raise exception 'B3 reclaim generation mismatch';
  end if;
  if exists (
    select 1 from public.genius_rag_chunks
    where source_key=gen1.source_key and claim_generation < gen2.claim_generation
  ) then
    raise exception 'B3 stale generation chunks survived reclaim';
  end if;

  -- 같은 (revision, section_path, chunk_index) 재저장이 UNIQUE 충돌 없이 성공해야 한다.
  perform public.upsert_baseball_genius_rag_chunk(
    gen2.source_key, gen2.claim_token, gen2.claim_generation, gen2.entity_type, gen2.entity_id,
    gen2.page_title, gen2.canonical_url, 'rB3', '개요', 0, repeat('content ', 6), 'docB3', 'hB3',
    gen2.source_grade, '2026-07-31T00:00:00Z', '2026-07-31', 'vec-768'
  );

  -- 오래된 generation의 역주행은 거부된다.
  begin
    perform public.upsert_baseball_genius_rag_chunk(
      gen1.source_key, gen1.claim_token, gen1.claim_generation, gen1.entity_type, gen1.entity_id,
      gen1.page_title, gen1.canonical_url, 'rB3', '개요', 0, repeat('stale ', 8), 'docB3', 'hB3s',
      gen1.source_grade, '2026-07-31T00:00:00Z', '2026-07-31', 'vec-768'
    );
  exception when others then stale_rejected := true;
  end;
  if not stale_rejected then raise exception 'B3 stale generation overwrote fresh chunk'; end if;

  select public.complete_baseball_genius_rag_source(
    gen2.source_key, gen2.claim_token, gen2.claim_generation,
    'rB3', 'docB3', '2026-07-31T00:00:00Z', '2026-08-01T00:00:00Z'
  ) into completed;
  if not completed then raise exception 'B3 reclaim path failed to reach ready'; end if;
  if (select ingestion_status from public.genius_rag_sources where source_key=gen2.source_key) <> 'ready' then
    raise exception 'B3 source not ready after reclaim';
  end if;
end;
$$;
SQL

# [B2] service_role은 쓰기 RPC를 실행할 수 있고, anon/authenticated는 모든 RPC가 막힌다.
# 직접 테이블 write는 어느 role에게도 열려 있지 않다(RPC가 유일 경로).
check_acl() { # $1=expr $2=expected $3=label
  local actual
  actual="$("${PSQL[@]}" -c "select $1")"
  [ "$actual" = "$2" ] || { echo "ACL FAIL: $3 expected=$2 actual=$actual"; exit 1; }
}
for role in service_role anon authenticated; do
  if [ "$role" = "service_role" ]; then want=t; else want=f; fi
  check_acl "has_function_privilege('$role', 'public.claim_baseball_genius_rag_batch(integer,integer)', 'EXECUTE')" "$want" "$role claim EXECUTE"
  check_acl "has_function_privilege('$role', 'public.complete_baseball_genius_rag_source(text,uuid,bigint,text,text,timestamptz,timestamptz)', 'EXECUTE')" "$want" "$role complete EXECUTE"
  check_acl "has_function_privilege('$role', 'public.record_baseball_genius_source_demand(text[])', 'EXECUTE')" "$want" "$role demand EXECUTE"
  check_acl "has_function_privilege('$role', 'public.upsert_baseball_genius_rag_chunk(text,uuid,bigint,text,text,text,text,text,text,integer,text,text,text,text,timestamptz,date,text,jsonb)', 'EXECUTE')" "$want" "$role upsert EXECUTE"
  # 테이블 직접 write는 전원 차단.
  check_acl "has_table_privilege('$role', 'public.genius_rag_chunks', 'INSERT')" f "$role chunks INSERT"
  check_acl "has_table_privilege('$role', 'public.genius_rag_sources', 'UPDATE')" f "$role sources UPDATE"
done
# claim RPC가 row type을 반환하므로 service_role은 sources SELECT만 가진다.
check_acl "has_table_privilege('service_role', 'public.genius_rag_sources', 'SELECT')" t "service sources SELECT"
check_acl "has_table_privilege('anon', 'public.genius_rag_sources', 'SELECT')" f "anon sources SELECT"

# service_role이 실제로 RPC만으로 ingestion write를 완주할 수 있는지 — 실행 경로 검증.
"${PSQL[@]}" <<'SQL'
update public.genius_rag_sources
set ingestion_status='not_started', ingestion_attempts=0, lease_until=null, claim_token=null,
    claim_generation=0, question_count=700, revision=null, content_hash=null,
    crawled_at=null, ingested_at=null
where source_key='namu:team:6';
SQL
"${PSQL[@]}" <<'SQL'
set role service_role;
do $$
declare
  claim public.genius_rag_sources%rowtype;
  completed boolean;
  blocked boolean := false;
begin
  select * into claim from public.claim_baseball_genius_rag_batch(1, 60);
  if claim.source_key <> 'namu:team:6' then raise exception 'B2 setup claim mismatch'; end if;

  -- 직접 INSERT는 막혀 있어야 한다.
  begin
    insert into public.genius_rag_chunks (
      source_key, entity_type, entity_id, page_title, canonical_url, revision, section_path,
      chunk_index, content, document_content_hash, content_hash, source_grade, crawled_at, as_of,
      claim_token, claim_generation, embedding
    ) values (
      claim.source_key, claim.entity_type, claim.entity_id, claim.page_title, claim.canonical_url,
      'rB2', '개요', 0, repeat('content ', 6), 'docB2', 'hB2', claim.source_grade,
      '2026-07-31T00:00:00Z', '2026-07-31', claim.claim_token, claim.claim_generation, 'vec-768'
    );
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked then raise exception 'B2 direct table insert allowed for service_role'; end if;

  -- RPC 경로는 동작해야 한다(worker가 chunk를 저장하고 ready까지 간다).
  perform public.upsert_baseball_genius_rag_chunk(
    claim.source_key, claim.claim_token, claim.claim_generation, claim.entity_type, claim.entity_id,
    claim.page_title, claim.canonical_url, 'rB2', '개요', 0, repeat('content ', 6), 'docB2', 'hB2',
    claim.source_grade, '2026-07-31T00:00:00Z', '2026-07-31', 'vec-768'
  );
  select public.complete_baseball_genius_rag_source(
    claim.source_key, claim.claim_token, claim.claim_generation,
    'rB2', 'docB2', '2026-07-31T00:00:00Z', '2026-08-01T00:00:00Z'
  ) into completed;
  if not completed then raise exception 'B2 service_role rpc ingestion path failed'; end if;
end;
$$;
reset role;
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

echo "baseball QA source inventory PG17 PASS (seed932·pending878·fault/CAS/concurrency·B1embedding·B2acl·B3reclaim)"
