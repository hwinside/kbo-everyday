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

# bootstrap seed는 자신의 committed row 수를 만들며 재실행해도 중복되지 않는다.
BASELINE_TOTAL=$(grep -c '^  (' supabase/migrations/20260731_baseball_genius_rag_sources_seed.sql)
BASELINE_PLAYERS=$(grep -c ", 'player'," supabase/migrations/20260731_baseball_genius_rag_sources_seed.sql)
"${PSQL[@]}" -f supabase/migrations/20260731_baseball_genius_rag_sources_seed.sql
"${PSQL[@]}" -f supabase/migrations/20260731_baseball_genius_rag_sources_seed.sql
[ "$("${PSQL[@]}" -c 'select count(*) from public.genius_rag_sources')" = "$BASELINE_TOTAL" ]
[ "$("${PSQL[@]}" -c "select count(*) from public.genius_rag_sources where entity_type='player' and resolution_status is null")" = "$BASELINE_PLAYERS" ]

# 후속 roster 변경은 기존 bootstrap을 변조하지 않고 append-only delta로 적용한다.
"${PSQL[@]}" -f supabase/migrations/20260801184500_baseball_genius_roster_sources_56103.sql
[ "$("${PSQL[@]}" -c 'select count(*) from public.genius_rag_sources')" = "$((BASELINE_TOTAL + 1))" ]
[ "$("${PSQL[@]}" -c "select count(*) from public.genius_rag_sources where source_key='namu:player:56103' and metadata->>'team'='LG'")" = "1" ]
[ "$("${PSQL[@]}" -c "select count(*) from public.genius_rag_sources where source_key in ('namu:player:55435','namu:player:69428') and metadata->>'team'='LG'")" = "2" ]
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

-- [R2-B1] §12 "마지막 성공 snapshot 보존": stale 재수집 claim은 새 generation을 stage만 하고
-- 이전 성공 snapshot을 지우지 않는다. active 전환은 complete 시점의 원자 swap으로만 일어난다.
update public.genius_rag_sources
set ingestion_status='not_started', ingestion_attempts=0, lease_until=null, claim_token=null,
    claim_generation=0, active_claim_generation=0, question_count=600, revision=null, content_hash=null,
    crawled_at=null, ingested_at=null
where source_key='namu:team:7';
do $$
declare
  gen1 public.genius_rag_sources%rowtype;
  gen2 public.genius_rag_sources%rowtype;
  gen3 public.genius_rag_sources%rowtype;
  completed boolean;
  serving_rev text;
begin
  select * into gen1 from public.claim_baseball_genius_rag_batch(1, 60);
  if gen1.source_key <> 'namu:team:7' then raise exception 'R2-B1 setup claim mismatch'; end if;
  perform public.upsert_baseball_genius_rag_chunk(
    gen1.source_key, gen1.claim_token, gen1.claim_generation, gen1.entity_type, gen1.entity_id,
    gen1.page_title, gen1.canonical_url, 'rGEN1', '개요', 0, repeat('gen1 content ', 4), 'docGEN1', 'hGEN1',
    gen1.source_grade, '2026-07-31T00:00:00Z', '2026-07-31', 'vec-768'
  );
  select public.complete_baseball_genius_rag_source(
    gen1.source_key, gen1.claim_token, gen1.claim_generation,
    'rGEN1', 'docGEN1', '2026-07-31T00:00:00Z', '2026-08-01T00:00:00Z'
  ) into completed;
  if not completed then raise exception 'R2-B1 gen1 failed to reach ready'; end if;
  if (select active_claim_generation from public.genius_rag_sources where source_key=gen1.source_key)
     <> gen1.claim_generation then
    raise exception 'R2-B1 active generation not swapped to gen1';
  end if;

  -- source stale → 재수집 claim(gen2 stage). 이 시점에 gen1 snapshot은 그대로 살아있어야 한다.
  update public.genius_rag_sources set ingestion_status='stale' where source_key=gen1.source_key;
  select * into gen2 from public.claim_baseball_genius_rag_batch(1, 60);
  if gen2.source_key <> gen1.source_key or gen2.claim_generation <> gen1.claim_generation + 1 then
    raise exception 'R2-B1 stale reclaim generation mismatch';
  end if;
  if not exists (
    select 1 from public.genius_rag_chunks
    where source_key=gen1.source_key and claim_generation=gen1.claim_generation
  ) then
    raise exception 'R2-B1 stale reclaim destroyed last successful snapshot';
  end if;
  -- 서빙도 계속된다(active generation 결속 뷰).
  select revision into serving_rev from public.genius_rag_serving_chunks where source_key=gen1.source_key;
  if serving_rev is distinct from 'rGEN1' then
    raise exception 'R2-B1 serving snapshot lost during stale reclaim (got %)', coalesce(serving_rev, '<none>');
  end if;

  -- gen2 stage 중 crash(chunk 일부만 쓰고 lease 만료) → gen1이 계속 서빙된다.
  perform public.upsert_baseball_genius_rag_chunk(
    gen2.source_key, gen2.claim_token, gen2.claim_generation, gen2.entity_type, gen2.entity_id,
    gen2.page_title, gen2.canonical_url, 'rGEN2', '개요', 0, repeat('gen2 content ', 4), 'docGEN2', 'hGEN2',
    gen2.source_grade, '2026-07-31T01:00:00Z', '2026-07-31', 'vec-768'
  );
  if (select count(*) from public.genius_rag_serving_chunks where source_key=gen1.source_key) <> 1
     or (select revision from public.genius_rag_serving_chunks where source_key=gen1.source_key) <> 'rGEN1' then
    raise exception 'R2-B1 staged generation leaked into serving set';
  end if;
  update public.genius_rag_sources set lease_until=now()-interval '1 second' where source_key=gen1.source_key;

  -- gen3 reclaim: 실패한 gen2 partial은 정리하되 active gen1 snapshot은 보존한다.
  select * into gen3 from public.claim_baseball_genius_rag_batch(1, 60);
  if gen3.claim_generation <> gen2.claim_generation + 1 then
    raise exception 'R2-B1 gen3 reclaim generation mismatch';
  end if;
  if exists (
    select 1 from public.genius_rag_chunks
    where source_key=gen1.source_key and claim_generation=gen2.claim_generation
  ) then
    raise exception 'R2-B1 failed partial generation survived reclaim';
  end if;
  if not exists (
    select 1 from public.genius_rag_chunks
    where source_key=gen1.source_key and claim_generation=gen1.claim_generation
  ) then
    raise exception 'R2-B1 active snapshot purged by later reclaim';
  end if;

  -- gen3 complete → active swap + 이전 generation 정리.
  perform public.upsert_baseball_genius_rag_chunk(
    gen3.source_key, gen3.claim_token, gen3.claim_generation, gen3.entity_type, gen3.entity_id,
    gen3.page_title, gen3.canonical_url, 'rGEN3', '개요', 0, repeat('gen3 content ', 4), 'docGEN3', 'hGEN3',
    gen3.source_grade, '2026-07-31T02:00:00Z', '2026-07-31', 'vec-768'
  );
  select public.complete_baseball_genius_rag_source(
    gen3.source_key, gen3.claim_token, gen3.claim_generation,
    'rGEN3', 'docGEN3', '2026-07-31T02:00:00Z', '2026-08-01T00:00:00Z'
  ) into completed;
  if not completed then raise exception 'R2-B1 gen3 failed to complete'; end if;
  if (select active_claim_generation from public.genius_rag_sources where source_key=gen1.source_key)
     <> gen3.claim_generation then
    raise exception 'R2-B1 active generation not swapped to gen3';
  end if;
  if (select count(*) from public.genius_rag_chunks where source_key=gen1.source_key) <> 1
     or (select revision from public.genius_rag_serving_chunks where source_key=gen1.source_key) <> 'rGEN3' then
    raise exception 'R2-B1 atomic swap did not retire previous generation';
  end if;
end;
$$;

-- [R2-B2] current claim generation에 이질 provenance chunk가 섞이면 complete를 거부한다.
update public.genius_rag_sources
set ingestion_status='not_started', ingestion_attempts=0, lease_until=null, claim_token=null,
    claim_generation=0, active_claim_generation=0, question_count=500, revision=null, content_hash=null,
    crawled_at=null, ingested_at=null
where source_key='namu:team:8';
do $$
declare
  claim public.genius_rag_sources%rowtype;
  completed boolean;
begin
  select * into claim from public.claim_baseball_genius_rag_batch(1, 60);
  if claim.source_key <> 'namu:team:8' then raise exception 'R2-B2 setup claim mismatch'; end if;

  perform public.upsert_baseball_genius_rag_chunk(
    claim.source_key, claim.claim_token, claim.claim_generation, claim.entity_type, claim.entity_id,
    claim.page_title, claim.canonical_url, 'r-good', '개요', 0, repeat('good content ', 4), 'doc-good', 'h-good',
    claim.source_grade, '2026-07-31T00:00:00Z', '2026-07-31', 'vec-768'
  );
  -- 같은 claim generation에 다른 revision/document hash/crawled_at을 가진 chunk를 주입(embedding은 non-null).
  perform public.upsert_baseball_genius_rag_chunk(
    claim.source_key, claim.claim_token, claim.claim_generation, claim.entity_type, claim.entity_id,
    claim.page_title, claim.canonical_url, 'r-rogue', '본문', 0, repeat('rogue content ', 4), 'doc-rogue', 'h-rogue',
    claim.source_grade, '2026-07-30T00:00:00Z', '2026-07-30', 'vec-768'
  );

  select public.complete_baseball_genius_rag_source(
    claim.source_key, claim.claim_token, claim.claim_generation,
    'r-good', 'doc-good', '2026-07-31T00:00:00Z', '2026-08-01T00:00:00Z'
  ) into completed;
  if completed then raise exception 'R2-B2 ready granted with mixed provenance in current generation'; end if;
  if (select ingestion_status from public.genius_rag_sources where source_key=claim.source_key) = 'ready' then
    raise exception 'R2-B2 source went ready with rogue provenance chunk';
  end if;
  if (select active_claim_generation from public.genius_rag_sources where source_key=claim.source_key) <> 0 then
    raise exception 'R2-B2 rejected completion still swapped active generation';
  end if;

  -- 이질 chunk를 제거해 provenance가 균일해지면 ready로 올라간다(GREEN 대조군).
  delete from public.genius_rag_chunks
  where source_key=claim.source_key and claim_generation=claim.claim_generation and revision='r-rogue';
  select public.complete_baseball_genius_rag_source(
    claim.source_key, claim.claim_token, claim.claim_generation,
    'r-good', 'doc-good', '2026-07-31T00:00:00Z', '2026-08-01T00:00:00Z'
  ) into completed;
  if not completed then raise exception 'R2-B2 uniform provenance generation failed to complete'; end if;
  -- 서빙은 active generation에 결속된다.
  if (select count(*) from public.genius_rag_serving_chunks where source_key=claim.source_key) <> 1 then
    raise exception 'R2-B2 serving set not bound to active generation';
  end if;
end;
$$;

-- [R2-B3] 동일 claim(같은 token+generation+key) 재시도는 idempotent하게 성공한다.
-- lower generation 역주행과 다른 token의 동일 generation 덮어쓰기는 계속 거부된다.
update public.genius_rag_sources
set ingestion_status='not_started', ingestion_attempts=0, lease_until=null, claim_token=null,
    claim_generation=0, active_claim_generation=0, question_count=400, revision=null, content_hash=null,
    crawled_at=null, ingested_at=null
where source_key='namu:team:9';
do $$
declare
  claim public.genius_rag_sources%rowtype;
  first_id bigint;
  retry_id bigint;
  rogue_rejected boolean := false;
  lower_rejected boolean := false;
begin
  select * into claim from public.claim_baseball_genius_rag_batch(1, 60);
  if claim.source_key <> 'namu:team:9' then raise exception 'R2-B3 setup claim mismatch'; end if;

  first_id := public.upsert_baseball_genius_rag_chunk(
    claim.source_key, claim.claim_token, claim.claim_generation, claim.entity_type, claim.entity_id,
    claim.page_title, claim.canonical_url, 'rR2B3', '개요', 0, repeat('retry content ', 4), 'docR2B3', 'hR2B3',
    claim.source_grade, '2026-07-31T00:00:00Z', '2026-07-31', 'vec-768'
  );

  -- DB commit 후 응답 timeout → worker가 결과를 모른 채 똑같은 write를 재시도한다.
  retry_id := public.upsert_baseball_genius_rag_chunk(
    claim.source_key, claim.claim_token, claim.claim_generation, claim.entity_type, claim.entity_id,
    claim.page_title, claim.canonical_url, 'rR2B3', '개요', 0, repeat('retry content ', 4), 'docR2B3', 'hR2B3',
    claim.source_grade, '2026-07-31T00:00:00Z', '2026-07-31', 'vec-768'
  );
  if retry_id is distinct from first_id then
    raise exception 'R2-B3 same-claim retry created a different row (dup)';
  end if;
  if (select count(*) from public.genius_rag_chunks
      where source_key=claim.source_key and claim_generation=claim.claim_generation) <> 1 then
    raise exception 'R2-B3 same-claim retry duplicated chunk';
  end if;

  -- 다른 token의 동일 generation 덮어쓰기는 거부된다.
  begin
    perform public.upsert_baseball_genius_rag_chunk(
      claim.source_key, gen_random_uuid(), claim.claim_generation, claim.entity_type, claim.entity_id,
      claim.page_title, claim.canonical_url, 'rR2B3', '개요', 0, repeat('rogue token ', 4), 'docR2B3', 'hRogue',
      claim.source_grade, '2026-07-31T00:00:00Z', '2026-07-31', 'vec-768'
    );
  exception when others then rogue_rejected := true;
  end;
  if not rogue_rejected then raise exception 'R2-B3 foreign token overwrote same-generation chunk'; end if;

  -- 멱춘 generation 역주행도 거부된다.
  begin
    perform public.upsert_baseball_genius_rag_chunk(
      claim.source_key, claim.claim_token, claim.claim_generation - 1, claim.entity_type, claim.entity_id,
      claim.page_title, claim.canonical_url, 'rR2B3', '개요', 0, repeat('older gen ', 4), 'docR2B3', 'hOld',
      claim.source_grade, '2026-07-31T00:00:00Z', '2026-07-31', 'vec-768'
    );
  exception when others then lower_rejected := true;
  end;
  if not lower_rejected then raise exception 'R2-B3 lower generation write accepted'; end if;
end;
$$;

-- [R2-B4] ready source에 identity drift가 오면 chunk 전량 삭제로 서빙 snapshot이 사라진다.
-- active를 같이 내리지 않으면 ready 계약 위반으로 drift UPDATE 자체가 거부되어
-- 이름·소속이 바뀜 문서를 영원히 무효화할 수 없게 된다.
update public.genius_rag_sources
set ingestion_status='not_started', ingestion_attempts=0, lease_until=null, claim_token=null,
    claim_generation=0, active_claim_generation=0, question_count=650, revision=null, content_hash=null,
    crawled_at=null, ingested_at=null
where source_key='namu:team:10';
do $$
declare
  gen1 public.genius_rag_sources%rowtype;
  completed boolean;
  drift_failed boolean := false;
  final_status text;
  final_active bigint;
begin
  select * into gen1 from public.claim_baseball_genius_rag_batch(1, 60);
  if gen1.source_key <> 'namu:team:10' then raise exception 'R2-B4 setup claim mismatch'; end if;
  perform public.upsert_baseball_genius_rag_chunk(
    gen1.source_key, gen1.claim_token, gen1.claim_generation, gen1.entity_type, gen1.entity_id,
    gen1.page_title, gen1.canonical_url, 'rB4', '개요', 0, repeat('content ', 6), 'docB4', 'hB4',
    gen1.source_grade, '2026-07-31T00:00:00Z', '2026-07-31', 'vec-768'
  );
  select public.complete_baseball_genius_rag_source(
    gen1.source_key, gen1.claim_token, gen1.claim_generation,
    'rB4', 'docB4', '2026-07-31T00:00:00Z', '2026-08-01T00:00:00Z'
  ) into completed;
  if not completed then raise exception 'R2-B4 setup publish failed'; end if;

  -- ready 상태에서 identity drift 발생.
  begin
    update public.genius_rag_sources
    set identity_fingerprint = identity_fingerprint || '-changed'
    where source_key = gen1.source_key;
  exception when others then drift_failed := true;
  end;
  if drift_failed then raise exception 'R2-B4 identity drift blocked on ready source'; end if;

  select ingestion_status, active_claim_generation into final_status, final_active
  from public.genius_rag_sources where source_key = gen1.source_key;
  if exists (select 1 from public.genius_rag_chunks where source_key = gen1.source_key) then
    raise exception 'R2-B4 identity drift preserved stale chunks';
  end if;
  if final_active <> 0 then raise exception 'R2-B4 active snapshot survived chunk purge'; end if;
  if final_status = 'ready' then raise exception 'R2-B4 source stayed ready with zero chunks'; end if;
end;
$$;

-- [R2-B5] retry budget는 "연속 실패" 카운터다. complete 성공이 attempts를 0으로 되돌리지 않으면
-- lifetime 누적 3회로 예산이 말라 성공적으로 서빙 중인 source조차 stale 재claim이 영구히 0건이 되고
-- §12 증분 재수집이 정지한다. ①성공→stale 재claim ②성공→crash→재수집 성공→stale 재claim을 검증한다.
update public.genius_rag_sources
set ingestion_status='not_started', ingestion_attempts=0, lease_until=null, claim_token=null,
    claim_generation=0, active_claim_generation=0, question_count=9000, revision=null, content_hash=null,
    crawled_at=null, ingested_at=null
where source_key='namu:team:10';
do $$
declare
  claim public.genius_rag_sources%rowtype;
  completed boolean;
  attempts integer;
  reclaimed text;
begin
  -- gen1 성공.
  select * into claim from public.claim_baseball_genius_rag_batch(1, 60);
  if claim.source_key <> 'namu:team:10' then raise exception 'R2-B5 setup claim mismatch'; end if;
  perform public.upsert_baseball_genius_rag_chunk(
    claim.source_key, claim.claim_token, claim.claim_generation, claim.entity_type, claim.entity_id,
    claim.page_title, claim.canonical_url, 'rB5a', '개요', 0, repeat('content ', 6), 'docB5a', 'hB5a',
    claim.source_grade, '2026-07-31T00:00:00Z', '2026-07-31', 'vec-768'
  );
  select public.complete_baseball_genius_rag_source(
    claim.source_key, claim.claim_token, claim.claim_generation,
    'rB5a', 'docB5a', '2026-07-31T00:00:00Z', '2026-08-01T00:00:00Z'
  ) into completed;
  if not completed then raise exception 'R2-B5 gen1 publish failed'; end if;

  select ingestion_attempts into attempts
  from public.genius_rag_sources where source_key='namu:team:10';
  if attempts <> 0 then
    raise exception 'R2-B5 successful complete left retry budget consumed (attempts=%)', attempts;
  end if;

  -- ① 재수집 주기 도래(stale) → 정상적으로 재claim된다.
  update public.genius_rag_sources set ingestion_status='stale' where source_key='namu:team:10';
  select source_key into reclaimed from public.claim_baseball_genius_rag_batch(1, 60);
  if reclaimed is distinct from 'namu:team:10' then
    raise exception 'R2-B5 stale source after success was not reclaimable';
  end if;

  -- ② 그 generation이 crash(lease 만료)해도 다음 재수집 성공이 예산을 다시 회복시킨다.
  update public.genius_rag_sources set lease_until = clock_timestamp() - interval '1 second'
  where source_key='namu:team:10';
  select * into claim from public.claim_baseball_genius_rag_batch(1, 60);
  if claim.source_key <> 'namu:team:10' then raise exception 'R2-B5 crashed generation was not reclaimed'; end if;
  perform public.upsert_baseball_genius_rag_chunk(
    claim.source_key, claim.claim_token, claim.claim_generation, claim.entity_type, claim.entity_id,
    claim.page_title, claim.canonical_url, 'rB5b', '개요', 0, repeat('content ', 6), 'docB5b', 'hB5b',
    claim.source_grade, '2026-07-31T00:00:00Z', '2026-07-31', 'vec-768'
  );
  select public.complete_baseball_genius_rag_source(
    claim.source_key, claim.claim_token, claim.claim_generation,
    'rB5b', 'docB5b', '2026-07-31T00:00:00Z', '2026-08-01T00:00:00Z'
  ) into completed;
  if not completed then raise exception 'R2-B5 post-crash republish failed'; end if;

  update public.genius_rag_sources set ingestion_status='stale' where source_key='namu:team:10';
  select source_key into reclaimed from public.claim_baseball_genius_rag_batch(1, 60);
  if reclaimed is distinct from 'namu:team:10' then
    raise exception 'R2-B5 lifetime attempts exhausted incremental re-ingestion';
  end if;
end;
$$;

-- [R2-B5b] 무한 재시도 방지 계약 무회귀: 성공 없이 연속 3회 실패하면 여전히 예산이 소진된다.
update public.genius_rag_sources
set ingestion_status='not_started', ingestion_attempts=0, lease_until=null, claim_token=null,
    claim_generation=0, active_claim_generation=0, question_count=9000, revision=null, content_hash=null,
    crawled_at=null, ingested_at=null
where source_key='namu:team:10';
delete from public.genius_rag_chunks where source_key='namu:team:10';
do $$
declare
  claim public.genius_rag_sources%rowtype;
  attempts integer;
  reclaimed text;
begin
  for i in 1..3 loop
    select * into claim from public.claim_baseball_genius_rag_batch(1, 60);
    if claim.source_key <> 'namu:team:10' then raise exception 'R2-B5b crash loop claim mismatch at %', i; end if;
    update public.genius_rag_sources set lease_until = clock_timestamp() - interval '1 second'
    where source_key='namu:team:10';
  end loop;

  select ingestion_attempts into attempts
  from public.genius_rag_sources where source_key='namu:team:10';
  if attempts <> 3 then raise exception 'R2-B5b consecutive failures did not accumulate (attempts=%)', attempts; end if;

  -- 이 검증의 claim은 다른 source를 가져가 뒤따르는 ACL 검증의 큐 순서를 흔든다.
  -- subtransaction으로 둘러 판정만 취하고 부수효과는 되돌린다.
  begin
    select source_key into reclaimed from public.claim_baseball_genius_rag_batch(1, 60);
    if reclaimed is not distinct from 'namu:team:10' then
      raise exception 'R2-B5b exhausted retry budget still claimable (infinite retry)';
    end if;
    raise exception 'R2B5B_ROLLBACK';
  exception when others then
    if sqlerrm <> 'R2B5B_ROLLBACK' then raise; end if;
  end;
end;
$$;

-- [R2-B6] 실패 종료 경로가 없으면 claim한 worker가 죽은 순간 source를 'ingesting'에서 내릴 수 없고,
-- 연속 3회 실패 시점에 `ingesting` + `last_error` NULL + claim_token 잔존 + claimable 0으로 영구 고착한다
-- (RPC 신설 전 PG17 actual로 재현한 상태). fail RPC가 그 종료를 책임지는지 검증한다.
update public.genius_rag_sources
set ingestion_status='not_started', ingestion_attempts=0, lease_until=null, claim_token=null,
    claim_generation=0, active_claim_generation=0, question_count=9000, revision=null, content_hash=null,
    crawled_at=null, ingested_at=null, last_error=null
where source_key='namu:team:10';
delete from public.genius_rag_chunks where source_key='namu:team:10';
do $$
declare
  claim public.genius_rag_sources%rowtype;
  stuck public.genius_rag_sources%rowtype;
  failed boolean;
  reclaimed text;
  chunk_rows integer;
begin
  -- ① 연속 3회 실패(worker crash → lease 만료)로 고착 상태를 만든다.
  for i in 1..3 loop
    select * into claim from public.claim_baseball_genius_rag_batch(1, 60);
    if claim.source_key <> 'namu:team:10' then raise exception 'R2-B6 crash loop claim mismatch at %', i; end if;
    update public.genius_rag_sources set lease_until = clock_timestamp() - interval '1 second'
    where source_key='namu:team:10';
  end loop;

  select * into stuck from public.genius_rag_sources where source_key='namu:team:10';
  if stuck.ingestion_status <> 'ingesting' or stuck.last_error is not null or stuck.claim_token is null then
    raise exception 'R2-B6 precondition drift (status=% last_error=% token_null=%)',
      stuck.ingestion_status, coalesce(stuck.last_error,'<null>'), (stuck.claim_token is null);
  end if;

  -- ② token 불일치는 no-op이다(남의 claim을 실패시킬 수 없다).
  select public.fail_baseball_genius_rag_source(
    'namu:team:10', gen_random_uuid(), stuck.claim_generation, 'wrong token'
  ) into failed;
  if failed then raise exception 'R2-B6 foreign token terminated someone else claim'; end if;

  -- ③ generation 불일치도 no-op이다(오래된 worker의 지연 실패 보고 역주행 차단).
  select public.fail_baseball_genius_rag_source(
    'namu:team:10', stuck.claim_token, stuck.claim_generation - 1, 'stale generation'
  ) into failed;
  if failed then raise exception 'R2-B6 stale generation terminated current claim'; end if;

  select * into stuck from public.genius_rag_sources where source_key='namu:team:10';
  if stuck.ingestion_status <> 'ingesting' or stuck.last_error is not null or stuck.claim_token is null then
    raise exception 'R2-B6 no-op path mutated the claim';
  end if;

  -- ④ exact token + generation은 그 claim만 실패 종료한다. lease가 이미 만료된 고착 상태에서도
  --   복구되어야 한다(만료를 조건으로 걸었으면 이 상태를 영원히 정리할 수 없다).
  select public.fail_baseball_genius_rag_source(
    'namu:team:10', stuck.claim_token, stuck.claim_generation, '  fetch timeout after 3 retries  '
  ) into failed;
  if not failed then raise exception 'R2-B6 exact-claim failure termination rejected'; end if;

  select * into stuck from public.genius_rag_sources where source_key='namu:team:10';
  if stuck.ingestion_status <> 'failed' then
    raise exception 'R2-B6 source still stuck in ingesting after termination (status=%)', stuck.ingestion_status;
  end if;
  if stuck.last_error <> 'fetch timeout after 3 retries' then
    raise exception 'R2-B6 last_error not recorded (got %)', coalesce(stuck.last_error,'<null>');
  end if;
  if stuck.claim_token is not null or stuck.lease_until is not null then
    raise exception 'R2-B6 terminated claim kept lease/token';
  end if;

  -- ⑤ 무한 재시도 방지 무회귀: 종료 RPC는 attempts를 리셋하지 않으므로 예산은 여전히 소진 상태다.
  if stuck.ingestion_attempts <> 3 then
    raise exception 'R2-B6 termination reset retry budget (attempts=%)', stuck.ingestion_attempts;
  end if;
  begin
    select source_key into reclaimed from public.claim_baseball_genius_rag_batch(1, 60);
    if reclaimed is not distinct from 'namu:team:10' then
      raise exception 'R2-B6 exhausted budget became claimable after termination (infinite retry)';
    end if;
    raise exception 'R2B6_ROLLBACK';
  exception when others then
    if sqlerrm <> 'R2B6_ROLLBACK' then raise; end if;
  end;
end;
$$;

-- [R2-B6b] 예산이 남은 실패는 lease 만료를 기다리지 않고 즉시 재claim되고,
-- 실패 종료는 마지막 성공 snapshot(active generation)을 파괴하지 않는다(§12).
update public.genius_rag_sources
set ingestion_status='not_started', ingestion_attempts=0, lease_until=null, claim_token=null,
    claim_generation=0, active_claim_generation=0, question_count=9000, revision=null, content_hash=null,
    crawled_at=null, ingested_at=null, last_error=null
where source_key='namu:team:10';
delete from public.genius_rag_chunks where source_key='namu:team:10';
do $$
declare
  claim public.genius_rag_sources%rowtype;
  completed boolean;
  failed boolean;
  reclaimed text;
  active_rev text;
  serving_rev text;
  staged_rows integer;
begin
  -- gen1 성공 → 서빙 snapshot을 만든다.
  select * into claim from public.claim_baseball_genius_rag_batch(1, 60);
  if claim.source_key <> 'namu:team:10' then raise exception 'R2-B6b setup claim mismatch'; end if;
  perform public.upsert_baseball_genius_rag_chunk(
    claim.source_key, claim.claim_token, claim.claim_generation, claim.entity_type, claim.entity_id,
    claim.page_title, claim.canonical_url, 'rB6a', '개요', 0, repeat('content ', 6), 'docB6a', 'hB6a',
    claim.source_grade, '2026-07-31T00:00:00Z', '2026-07-31', 'vec-768'
  );
  select public.complete_baseball_genius_rag_source(
    claim.source_key, claim.claim_token, claim.claim_generation,
    'rB6a', 'docB6a', '2026-07-31T00:00:00Z', '2026-08-01T00:00:00Z'
  ) into completed;
  if not completed then raise exception 'R2-B6b gen1 publish failed'; end if;

  -- 재수집(gen2) claim → chunk를 일부 stage한 뒤 실패한다.
  update public.genius_rag_sources set ingestion_status='stale' where source_key='namu:team:10';
  select * into claim from public.claim_baseball_genius_rag_batch(1, 60);
  if claim.source_key <> 'namu:team:10' then raise exception 'R2-B6b stale reclaim mismatch'; end if;
  perform public.upsert_baseball_genius_rag_chunk(
    claim.source_key, claim.claim_token, claim.claim_generation, claim.entity_type, claim.entity_id,
    claim.page_title, claim.canonical_url, 'rB6b', '개요', 0, repeat('content ', 6), 'docB6b', 'hB6b',
    claim.source_grade, '2026-07-31T00:00:00Z', '2026-07-31', 'vec-768'
  );
  select public.fail_baseball_genius_rag_source(
    claim.source_key, claim.claim_token, claim.claim_generation, 'parser crashed'
  ) into failed;
  if not failed then raise exception 'R2-B6b live-lease failure termination rejected'; end if;

  -- 마지막 성공 snapshot은 그대로 서빙된다.
  select revision into active_rev from public.genius_rag_sources where source_key='namu:team:10';
  if active_rev is distinct from 'rB6a' then
    raise exception 'R2-B6b failure termination destroyed last successful revision (got %)', coalesce(active_rev,'<null>');
  end if;
  select revision into serving_rev from public.genius_rag_serving_chunks where source_key='namu:team:10';
  if serving_rev is distinct from 'rB6a' then
    raise exception 'R2-B6b serving snapshot lost after failure (got %)', coalesce(serving_rev,'<none>');
  end if;
  -- 실패한 generation의 미완성 chunk는 정리된다.
  select count(*) into staged_rows from public.genius_rag_chunks
  where source_key='namu:team:10' and revision='rB6b';
  if staged_rows <> 0 then raise exception 'R2-B6b failed generation chunks survived (%)', staged_rows; end if;

  -- 예산이 남았으므로 lease 만료 대기 없이 즉시 재claim된다.
  select source_key into reclaimed from public.claim_baseball_genius_rag_batch(1, 60);
  if reclaimed is distinct from 'namu:team:10' then
    raise exception 'R2-B6b terminated source was not immediately reclaimable';
  end if;
end;
$$;

-- 뒤따르는 ACL/동시성 검증은 큐 순서에 의존한다. R2-B6계열이 높은 question_count로 올려둔
-- namu:team:10을 큐에서 내려둔다(예산 소진 상태로 고정).
update public.genius_rag_sources
set ingestion_status='failed', ingestion_attempts=3, lease_until=null, claim_token=null
where source_key='namu:team:10';
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
  check_acl "has_function_privilege('$role', 'public.fail_baseball_genius_rag_source(text,uuid,bigint,text)', 'EXECUTE')" "$want" "$role fail EXECUTE"
  check_acl "has_function_privilege('$role', 'public.upsert_baseball_genius_rag_chunk(text,uuid,bigint,text,text,text,text,text,text,integer,text,text,text,text,timestamptz,date,text,jsonb)', 'EXECUTE')" "$want" "$role upsert EXECUTE"
  # 테이블 직접 write는 전원 차단.
  check_acl "has_table_privilege('$role', 'public.genius_rag_chunks', 'INSERT')" f "$role chunks INSERT"
  check_acl "has_table_privilege('$role', 'public.genius_rag_sources', 'UPDATE')" f "$role sources UPDATE"
done
# claim RPC가 row type을 반환하므로 service_role은 sources SELECT만 가진다.
check_acl "has_table_privilege('service_role', 'public.genius_rag_sources', 'SELECT')" t "service sources SELECT"
check_acl "has_table_privilege('anon', 'public.genius_rag_sources', 'SELECT')" f "anon sources SELECT"
# retrieval은 active generation 결속 서빙 뷰만 읽는다. 기반 chunks 테이블 직접 SELECT은 전원 차단되어
# stage 중인 미완성 generation이 검색으로 새어나갈 경로가 없다.
check_acl "has_table_privilege('service_role', 'public.genius_rag_serving_chunks', 'SELECT')" t "service serving-view SELECT"
check_acl "has_table_privilege('anon', 'public.genius_rag_serving_chunks', 'SELECT')" f "anon serving-view SELECT"
check_acl "has_table_privilege('authenticated', 'public.genius_rag_serving_chunks', 'SELECT')" f "authenticated serving-view SELECT"
check_acl "has_table_privilege('service_role', 'public.genius_rag_chunks', 'SELECT')" f "service chunks direct SELECT"

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

echo "baseball QA source inventory PG17 PASS (bootstrap${BASELINE_TOTAL}·append-only-roster-delta·fault/CAS/concurrency·B1embedding·B2acl·B3reclaim·R2-B1stage→swap+snapshot보존·R2-B2provenance균일·R2-B3idempotent재시도·R2-B4drift→stale강등·R2-B5성공시retry예산회복+연속3회소진·R2-B6실패종료+token/gen불일치no-op·R2-B6b실패시snapshot보존+즉시재claim)"
