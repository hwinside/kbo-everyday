#!/usr/bin/env bash
# venue_story_comment_post RPC 동시성 통합 회귀 (삼순 #807 라운드3 blocker 1)
#
# 임시 로컬 Postgres 클러스터를 띄워 migration 의 RPC 를 실제로 적용한 뒤:
#   1) 같은 유저의 "동시" POST 2건 → 정확히 1건만 성공 (advisory xact lock 직렬화)
#   2) 만료/비활성 스토리 → not_found
#   3) 정규화 키 동일내용 반복 → duplicate
#   4) 60초 창 3건 초과 → rate
# 를 검증한다. supabase local 없이도 도는 순수 pg 통합 테스트.
#
# 요구: PostgreSQL 17 (PATH 또는 /opt/homebrew/opt/postgresql@17/bin)
set -euo pipefail

# macOS + 한국어 로케일에서 postmaster 가 멀티쓰레드로 물들어 기동 실패하는 문제 회피
export LC_ALL=C LANG=C

PGBIN=""
for cand in "$(dirname "$(command -v initdb 2>/dev/null || true)")" /opt/homebrew/opt/postgresql@17/bin /usr/local/opt/postgresql@17/bin; do
  if [ -n "$cand" ] && [ -x "$cand/initdb" ] && [ -x "$cand/psql" ]; then PGBIN="$cand"; break; fi
done
if [ -z "$PGBIN" ]; then
  echo "SKIP: local PostgreSQL(initdb/psql) not found" >&2
  exit 2
fi

MIGRATION="$(cd "$(dirname "$0")/../.." && pwd)/supabase/migrations/20260723_venue_story_comments.sql"
[ -f "$MIGRATION" ] || { echo "migration not found: $MIGRATION" >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/story-rpc-qa.XXXXXX")"
DATADIR="$WORK/data"
SOCKDIR="$WORK/sock"
mkdir -p "$SOCKDIR"
cleanup() {
  "$PGBIN/pg_ctl" -D "$DATADIR" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATADIR" -A trust -U qa --locale=C --encoding=UTF8 >/dev/null
"$PGBIN/pg_ctl" -D "$DATADIR" -o "-p 59321 -k $SOCKDIR -c listen_addresses=''" -w start >/dev/null

PSQL=("$PGBIN/psql" -h "$SOCKDIR" -p 59321 -U qa -d postgres -v ON_ERROR_STOP=1 -qtA)

# 의존 스텁: auth.users / venue_stories (RPC 가 참조하는 최소 컬럼) + 클라 롤
"${PSQL[@]}" <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id UUID PRIMARY KEY);
CREATE TABLE venue_stories (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  status TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
INSERT INTO auth.users (id) VALUES
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222');
INSERT INTO venue_stories (status, expires_at) VALUES
  ('active', now() + interval '1 hour'),   -- id=1 live
  ('active', now() - interval '1 minute'), -- id=2 expired
  ('hidden', now() + interval '1 hour');   -- id=3 inactive
SQL

"${PSQL[@]}" -f "$MIGRATION" >/dev/null

pass=0; fail=0
check() { # name actual expected
  if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "  ✅ $1"
  else fail=$((fail+1)); echo "  ❌ $1 (got: $2 / want: $3)"; fi
}

echo "[동시 POST 원자성 — 같은 유저 2건 병렬, 정확히 1건만 성공]"
U1=11111111-1111-1111-1111-111111111111
"${PSQL[@]}" -c "SELECT venue_story_comment_post(1,'$U1','동시 A','a')" > "$WORK/r1" &
"${PSQL[@]}" -c "SELECT venue_story_comment_post(1,'$U1','동시 B','b')" > "$WORK/r2" &
wait
OKS=$(cat "$WORK/r1" "$WORK/r2" | grep -c '"ok": true' || true)
RATES=$(cat "$WORK/r1" "$WORK/r2" | grep -c '"rate"' || true)
ROWS=$("${PSQL[@]}" -c "SELECT count(*) FROM venue_story_comments WHERE user_id='$U1'")
check "동시 2건 중 성공 정확히 1건" "$OKS" "1"
check "탈락 1건은 rate 사유" "$RATES" "1"
check "INSERT 된 행도 정확히 1건" "$ROWS" "1"

echo "[수명주기 게이트]"
U2=22222222-2222-2222-2222-222222222222
R=$("${PSQL[@]}" -c "SELECT venue_story_comment_post(2,'$U2','만료 스토리','x')")
check "만료 스토리 → not_found" "$(echo "$R" | grep -c not_found)" "1"
R=$("${PSQL[@]}" -c "SELECT venue_story_comment_post(3,'$U2','비활성 스토리','x')")
check "비활성 스토리 → not_found" "$(echo "$R" | grep -c not_found)" "1"
R=$("${PSQL[@]}" -c "SELECT venue_story_comment_post(99,'$U2','없는 스토리','x')")
check "없는 스토리 → not_found" "$(echo "$R" | grep -c not_found)" "1"

echo "[동일내용/rate — created_at 조작으로 경계 재현]"
R=$("${PSQL[@]}" -c "SELECT venue_story_comment_post(1,'$U2','첫 댓글','key1')")
check "다른 유저 첫 댓글 성공" "$(echo "$R" | grep -c '"ok": true')" "1"
# 10초 쿨다운 회피를 위해 마지막 행을 15초 과거로 이동 후 동일 키 재시도 → duplicate
"${PSQL[@]}" -c "UPDATE venue_story_comments SET created_at = now() - interval '15 seconds' WHERE user_id='$U2'" >/dev/null
R=$("${PSQL[@]}" -c "SELECT venue_story_comment_post(1,'$U2','첫  댓 글','key1')")
check "정규화 키 동일 → duplicate" "$(echo "$R" | grep -c duplicate)" "1"
# soft delete 해도 rate/dup 판정에 남는지: 삭제 후에도 duplicate 유지
"${PSQL[@]}" -c "UPDATE venue_story_comments SET deleted_at = now() WHERE user_id='$U2'" >/dev/null
R=$("${PSQL[@]}" -c "SELECT venue_story_comment_post(1,'$U2','첫 댓글','key1')")
check "soft delete 후에도 duplicate(리셋 불가)" "$(echo "$R" | grep -c duplicate)" "1"
# 60초 창 3건: 과거 12/24/36초 시점 행 3건 구성 → 4번째 rate
"${PSQL[@]}" -c "DELETE FROM venue_story_comments WHERE user_id='$U2'" >/dev/null
"${PSQL[@]}" -c "
  INSERT INTO venue_story_comments (story_id, user_id, content, content_key, created_at) VALUES
  (1,'$U2','w1','w1', now() - interval '12 seconds'),
  (1,'$U2','w2','w2', now() - interval '24 seconds'),
  (1,'$U2','w3','w3', now() - interval '36 seconds')" >/dev/null
R=$("${PSQL[@]}" -c "SELECT venue_story_comment_post(1,'$U2','w4','w4')")
check "60초 내 3건 초과 → rate" "$(echo "$R" | grep -c rate)" "1"
# 10초 경계: 마지막 행이 정확히 10초 전(창 내 2건뿐)이면 허용
"${PSQL[@]}" -c "DELETE FROM venue_story_comments WHERE user_id='$U2'" >/dev/null
"${PSQL[@]}" -c "
  INSERT INTO venue_story_comments (story_id, user_id, content, content_key, created_at) VALUES
  (1,'$U2','w5','w5', now() - interval '10 seconds')" >/dev/null
R=$("${PSQL[@]}" -c "SELECT venue_story_comment_post(1,'$U2','w6','w6')")
check "정확히 10초 경과는 허용(JS 참조 구현과 동일 경계)" "$(echo "$R" | grep -c '"ok": true')" "1"

echo "[클라 롤 실행 차단]"
R=$("${PSQL[@]}" -c "SELECT has_function_privilege('anon','venue_story_comment_post(bigint,uuid,text,text)','EXECUTE')")
check "anon EXECUTE 불가" "$R" "f"
R=$("${PSQL[@]}" -c "SELECT has_function_privilege('authenticated','venue_story_comment_post(bigint,uuid,text,text)','EXECUTE')")
check "authenticated EXECUTE 불가" "$R" "f"

echo ""
echo "결과: $pass pass / $fail fail"
[ "$fail" -eq 0 ]
