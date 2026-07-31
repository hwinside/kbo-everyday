#!/usr/bin/env bash
# 야잘알봇 v2 S2a — RAG 인벤토리/chunk DB 계약 회귀 (실제 PG17).
#
# 왜 필요한가(삼순 재리뷰 #3·#4·#7): 코드 가드만으로는 SQL 직접 쓰기를 막지 못한다.
# 아래를 **DB 레벨에서** 실증한다:
#   RED  = 나무위키 tier1 승격 / resolved인데 canonical_url NULL / ambiguous에 URL /
#          chunk 메타 결측(빈문자열) / content_chars 위조 / 길이 범위 밖 /
#          chunk가 원본과 다른 entity·grade·url로 결속 / 미resolved 소스에 chunk
#   GREEN = 적법 케이스 / 시드 919행 적재 / 재실행 무중복(멱등) / 재실행이 resolved를 되돌리지 않음
set -euo pipefail

# macOS Homebrew PG17은 locale이 비어 있으면 기동 중 multithreaded FATAL로 죽는다(기존 pg17 스크립트 관행).
export LC_ALL=C LANG=C

PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@17/bin}"
[ -x "$PGBIN/initdb" ] || { echo "SKIP: postgresql@17 binaries not found"; exit 0; }

REVIEW_ROOT="${OPENCLAW_REVIEW_ROOT:-/Volumes/T7-Dev/reviews/runtime}"
WORK="$(mktemp -d "$REVIEW_ROOT/genius-rag-pg17.XXXXXX")"
PORT=59347

cleanup() {
  "$PGBIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

"$PGBIN/initdb" -D "$WORK/data" -A trust -U postgres --locale=C --encoding=UTF8 >/dev/null
"$PGBIN/pg_ctl" -D "$WORK/data" -o "-k $WORK -p $PORT -c fsync=off" -w start >/dev/null
PSQL=("$PGBIN/psql" -h "$WORK" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -qtA)

"${PSQL[@]}" -c "create role anon; create role authenticated; create role service_role;"

# Homebrew PG에는 pgvector가 없다. vector 타입만 text로 치환해 나머지 DDL/CHECK/트리거 계약을
# 실제 PG17 파서·실행기로 검증한다(차원 계약은 스모크가 migration 텍스트로 별도 검사).
sed \
  -e '/CREATE EXTENSION IF NOT EXISTS vector/d' \
  -e 's/embedding vector(768)/embedding text/' \
  supabase/migrations/20260731_genius_rag_source_inventory.sql | "${PSQL[@]}"

# --- 시드 migration 적용 (1회차) ---------------------------------------------
"${PSQL[@]}" -f supabase/migrations/20260731_genius_rag_inventory_seed.sql >/dev/null

SEED_COUNT=$("${PSQL[@]}" -c "select count(*) from public.genius_source_inventory;")
[ "$SEED_COUNT" -gt 0 ] || { echo "FAIL: seed inserted 0 rows"; exit 1; }
echo "seed rows: $SEED_COUNT"

# --- 멱등: 재실행해도 중복 0 + resolved 승격 유지 ------------------------------
"${PSQL[@]}" <<'SQL'
-- 크롤 검증이 끝나 resolved로 승격된 상황을 흉내낸다.
update public.genius_source_inventory
set status = 'resolved', canonical_url = 'https://namu.wiki/w/resolved-fixture', status_reason = 'verified'
where entity_type = 'team' and entity_id = '1';
SQL

"${PSQL[@]}" -f supabase/migrations/20260731_genius_rag_inventory_seed.sql >/dev/null

RERUN_COUNT=$("${PSQL[@]}" -c "select count(*) from public.genius_source_inventory;")
[ "$RERUN_COUNT" = "$SEED_COUNT" ] || { echo "FAIL: re-run changed row count $SEED_COUNT -> $RERUN_COUNT"; exit 1; }

"${PSQL[@]}" <<'SQL'
do $$
declare v_status text; v_url text; v_resolved integer; v_ambiguous_url integer;
begin
  select status, canonical_url into v_status, v_url
  from public.genius_source_inventory where entity_type = 'team' and entity_id = '1';
  if v_status <> 'resolved' or v_url <> 'https://namu.wiki/w/resolved-fixture' then
    raise exception 'idempotent re-run downgraded resolved row: % / %', v_status, v_url;
  end if;

  -- 시드는 미확인을 확인됨으로 승격하지 않는다(fixture 1건 외 resolved 없음).
  select count(*) into v_resolved from public.genius_source_inventory where status = 'resolved';
  if v_resolved <> 1 then
    raise exception 'seed must not promote to resolved (got %)', v_resolved;
  end if;

  -- ambiguous(동명이인)는 canonical_url을 갖지 않는다.
  select count(*) into v_ambiguous_url
  from public.genius_source_inventory where status = 'ambiguous' and canonical_url is not null;
  if v_ambiguous_url <> 0 then
    raise exception 'ambiguous rows must not carry canonical_url (got %)', v_ambiguous_url;
  end if;
end;
$$;
SQL

# --- 결함 주입: 반드시 RED여야 하는 케이스 ------------------------------------
expect_reject() {
  local label="$1"; local sql="$2"
  if "${PSQL[@]}" -c "$sql" >/dev/null 2>&1; then
    echo "FAIL(should be rejected): $label"
    exit 1
  fi
  echo "RED ok: $label"
}

expect_reject "나무위키 tier1 승격" \
  "insert into public.genius_source_inventory (entity_type,entity_id,entity_name,source_kind,source_grade,canonical_url,status)
   values ('player','X1','침입자','namuwiki','tier1','https://namu.wiki/w/x','pending');"

expect_reject "KBO 공식을 tier2로 강등" \
  "insert into public.genius_source_inventory (entity_type,entity_id,entity_name,source_kind,source_grade,canonical_url,status)
   values ('record_book','X2','강등','kbo_official','tier2','https://www.koreabaseball.com/x','pending');"

expect_reject "resolved인데 canonical_url NULL" \
  "insert into public.genius_source_inventory (entity_type,entity_id,entity_name,source_kind,source_grade,canonical_url,status)
   values ('player','X3','무URL','namuwiki','tier2',NULL,'resolved');"

expect_reject "resolved인데 canonical_url 공백" \
  "insert into public.genius_source_inventory (entity_type,entity_id,entity_name,source_kind,source_grade,canonical_url,status)
   values ('player','X4','공백URL','namuwiki','tier2','   ','resolved');"

expect_reject "ambiguous인데 canonical_url 존재" \
  "insert into public.genius_source_inventory (entity_type,entity_id,entity_name,source_kind,source_grade,canonical_url,status)
   values ('player','X5','임의선택','namuwiki','tier2','https://namu.wiki/w/guess','ambiguous');"

# 적법한 resolved tier2 소스 1건을 만들고 chunk 계약을 검증한다.
"${PSQL[@]}" <<'SQL' >/dev/null
insert into public.genius_source_inventory (entity_type,entity_id,entity_name,source_kind,source_grade,canonical_url,status)
values ('player','64432','김도영','namuwiki','tier2','https://namu.wiki/w/kimdoyoung','resolved');
insert into public.genius_source_inventory (entity_type,entity_id,entity_name,source_kind,source_grade,canonical_url,status)
values ('player','64433','미확인선수','namuwiki','tier2','https://namu.wiki/w/pending-guy','pending');
SQL

SRC_OK=$("${PSQL[@]}" -c "select id from public.genius_source_inventory where entity_id='64432' and source_kind='namuwiki';")
SRC_PENDING=$("${PSQL[@]}" -c "select id from public.genius_source_inventory where entity_id='64433' and source_kind='namuwiki';")
BODY="$(printf 'a%.0s' $(seq 1 200))"

chunk_insert() { # inventory_id entity_type entity_id grade url revision section content chars
  echo "insert into public.genius_rag_chunks
    (inventory_id, entity_type, entity_id, page_title, canonical_url, revision, section_path,
     crawled_at, content_hash, source_grade, as_of, content, content_chars)
    values ('$1','$2','$3','김도영','$5','$6','$7', now(), 'hash-$RANDOM', '$4', now(), '$8', $9);"
}

expect_reject "chunk가 tier2 원본을 참조하며 tier1로 승격" \
  "$(chunk_insert "$SRC_OK" player 64432 tier1 https://namu.wiki/w/kimdoyoung r1 개요 "$BODY" 200)"

expect_reject "chunk entity_id 오결속(WRONG)" \
  "$(chunk_insert "$SRC_OK" player WRONG tier2 https://namu.wiki/w/kimdoyoung r1 개요 "$BODY" 200)"

expect_reject "chunk entity_type 오결속(team)" \
  "$(chunk_insert "$SRC_OK" team 64432 tier2 https://namu.wiki/w/kimdoyoung r1 개요 "$BODY" 200)"

expect_reject "chunk canonical_url 오결속(다른 문서)" \
  "$(chunk_insert "$SRC_OK" player 64432 tier2 https://namu.wiki/w/other r1 개요 "$BODY" 200)"

expect_reject "chunk revision 빈문자열(메타 결측)" \
  "$(chunk_insert "$SRC_OK" player 64432 tier2 https://namu.wiki/w/kimdoyoung '' 개요 "$BODY" 200)"

expect_reject "chunk section_path 공백(메타 결측)" \
  "$(chunk_insert "$SRC_OK" player 64432 tier2 https://namu.wiki/w/kimdoyoung r1 '   ' "$BODY" 200)"

expect_reject "content_chars 위조(실제 길이와 불일치)" \
  "$(chunk_insert "$SRC_OK" player 64432 tier2 https://namu.wiki/w/kimdoyoung r1 개요 "$BODY" 1)"

expect_reject "content 길이 상한(900) 초과" \
  "$(chunk_insert "$SRC_OK" player 64432 tier2 https://namu.wiki/w/kimdoyoung r1 개요 "$(printf 'b%.0s' $(seq 1 1200))" 1200)"

expect_reject "content 길이 하한(40) 미만" \
  "$(chunk_insert "$SRC_OK" player 64432 tier2 https://namu.wiki/w/kimdoyoung r1 개요 "짧음" 2)"

expect_reject "미resolved(pending) 소스에 chunk 저장" \
  "insert into public.genius_rag_chunks
    (inventory_id, entity_type, entity_id, page_title, canonical_url, revision, section_path,
     crawled_at, content_hash, source_grade, as_of, content, content_chars)
   values ('$SRC_PENDING','player','64433','미확인선수','https://namu.wiki/w/pending-guy','r1','개요',
           now(),'h-pending','tier2',now(),'$BODY',200);"

# --- GREEN: 적법 케이스는 통과해야 한다 ---------------------------------------
"${PSQL[@]}" -c "$(chunk_insert "$SRC_OK" player 64432 tier2 https://namu.wiki/w/kimdoyoung r1 개요 "$BODY" 200)" >/dev/null
CHUNKS=$("${PSQL[@]}" -c "select count(*) from public.genius_rag_chunks;")
[ "$CHUNKS" = "1" ] || { echo "FAIL: legit chunk insert did not land (count=$CHUNKS)"; exit 1; }
echo "GREEN ok: 적법 chunk 저장"

echo "genius RAG inventory PG17 PASS"
