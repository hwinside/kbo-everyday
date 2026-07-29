#!/usr/bin/env bash
# 직관 스토리 조회수 트래킹(A안 원문: click/impression 2종) RPC dedupe 회귀.
#
# 임시 로컬 Postgres 클러스터에 migration 을 실제 적용한 뒤 record_venue_story_view 검증:
#   1) click 첫 조회 → click daily +1 (impression 과 독립)
#   2) 같은 뷰어 같은 kind 같은 날 재조회 → 증가 없음 (스토리×뷰어×kind×KST일 dedupe)
#   3) 같은 뷰어 impression → click 과 분리 집계 +1
#   4) 다른 뷰어(guest viewer_key) → +1 — 게스트도 집계
#   5) 다른 KST 날짜 → 새 daily 행 +1 (일 단위 dedupe 키 확인)
#   6) invalid kind → 조용히 no-op
#   7) removed / 존재하지 않는 스토리 → 조용히 no-op (에러·카운트 없음)
#   8) 스토리 DELETE → marks CASCADE 정리, daily 롤업은 영구 보존
#   9) RPC/테이블 권한: anon·authenticated 실행/조회 불가, service_role 만 실행 가능
# supabase local 없이도 도는 순수 pg 통합 테스트 (venue-story-upload-daily.sh 패턴).
#
# 요구: PostgreSQL 17 (PATH 또는 /opt/homebrew/opt/postgresql@17/bin)
set -euo pipefail

export LC_ALL=C LANG=C

PGBIN=""
for cand in "$(dirname "$(command -v initdb 2>/dev/null || true)")" /opt/homebrew/opt/postgresql@17/bin /usr/local/opt/postgresql@17/bin; do
  if [ -n "$cand" ] && [ -x "$cand/initdb" ] && [ -x "$cand/psql" ]; then PGBIN="$cand"; break; fi
done
if [ -z "$PGBIN" ]; then
  echo "SKIP: local PostgreSQL(initdb/psql) not found" >&2
  exit 2
fi

MIGRATION="$(cd "$(dirname "$0")/../.." && pwd)/supabase/migrations/20260729_venue_story_views.sql"
[ -f "$MIGRATION" ] || { echo "migration not found: $MIGRATION" >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/venue-view-qa.XXXXXX")"
DATADIR="$WORK/data"
SOCKDIR="$WORK/sock"
mkdir -p "$SOCKDIR"
cleanup() {
  "$PGBIN/pg_ctl" -D "$DATADIR" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATADIR" -A trust -U qa --locale=C --encoding=UTF8 >/dev/null
"$PGBIN/pg_ctl" -D "$DATADIR" -o "-p 59331 -k $SOCKDIR -c listen_addresses=''" -w start >/dev/null

PSQL=("$PGBIN/psql" -h "$SOCKDIR" -p 59331 -U qa -d postgres -v ON_ERROR_STOP=1 -qtA)

# ── 최소 스키마 스텁 (migration 이 참조하는 venue_stories 컬럼만) ──
"${PSQL[@]}" >/dev/null <<'SQL'
CREATE ROLE service_role NOLOGIN;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE TABLE venue_stories (
  id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  status TEXT NOT NULL
);
SQL

# migration 은 Supabase 처럼 단일 트랜잭션으로 적용.
"${PSQL[@]}" -1 -f "$MIGRATION" >/dev/null

ok_count=0 bad_count=0
check() { # name actual expected
  if [ "$2" = "$3" ]; then ok_count=$((ok_count+1)); echo "  ✅ $1"
  else bad_count=$((bad_count+1)); echo "  ❌ $1 (got: $2 / want: $3)"; fi
}
daily_total() { # story_id kind → 전체 기간 view_count 합 (없으면 0)
  "${PSQL[@]}" -c "SELECT COALESCE(sum(view_count),0) FROM venue_story_view_daily WHERE story_id=$1 AND kind='$2'"
}
daily_rows() { # story_id kind → daily 행 수
  "${PSQL[@]}" -c "SELECT count(*) FROM venue_story_view_daily WHERE story_id=$1 AND kind='$2'"
}
marks_rows() { # story_id → marks 행 수(전체 kind)
  "${PSQL[@]}" -c "SELECT count(*) FROM venue_story_view_marks WHERE story_id=$1"
}
rec() { # story_id viewer_key kind
  "${PSQL[@]}" -c "SELECT record_venue_story_view($1, '$2', '$3')" >/dev/null
}

"${PSQL[@]}" -c "INSERT INTO venue_stories (status) VALUES ('active'), ('removed')" >/dev/null
ACTIVE=1 REMOVED=2 MISSING=999
USER_A="user:11111111-1111-1111-1111-111111111111"
GUEST_B="guest:22222222-2222-2222-2222-222222222222"

echo "[1) click 첫 조회 → +1]"
rec "$ACTIVE" "$USER_A" click
check "click daily 합 = 1" "$(daily_total $ACTIVE click)" "1"
check "impression daily 합 = 0 (독립)" "$(daily_total $ACTIVE impression)" "0"
check "marks = 1" "$(marks_rows $ACTIVE)" "1"

echo "[2) 같은 뷰어 같은 kind 같은 날 재조회 → dedupe]"
rec "$ACTIVE" "$USER_A" click
rec "$ACTIVE" "$USER_A" click
check "click daily 합 여전히 1" "$(daily_total $ACTIVE click)" "1"

echo "[3) 같은 뷰어 impression → click 과 분리 +1]"
rec "$ACTIVE" "$USER_A" impression
rec "$ACTIVE" "$USER_A" impression
check "impression daily 합 = 1" "$(daily_total $ACTIVE impression)" "1"
check "click daily 합 그대로 1" "$(daily_total $ACTIVE click)" "1"

echo "[4) 다른 뷰어(guest) → +1 — 게스트도 집계]"
rec "$ACTIVE" "$GUEST_B" click
check "click daily 합 = 2" "$(daily_total $ACTIVE click)" "2"
check "guest mark 존재" "$("${PSQL[@]}" -c "SELECT count(*) FROM venue_story_view_marks WHERE story_id=$ACTIVE AND viewer_key='$GUEST_B'")" "1"

echo "[5) 다른 KST 날짜 → 새 daily 행 +1 (일 단위 dedupe)]"
# RPC 는 now() 기준이므로 user:A 의 오늘 click mark 를 어제로 밀어 '어제 봤던 뷰어가 오늘 다시 여는' 상황 재현.
"${PSQL[@]}" -c "UPDATE venue_story_view_marks SET view_date = view_date - 1 WHERE story_id=$ACTIVE AND viewer_key='$USER_A' AND kind='click'" >/dev/null
"${PSQL[@]}" -c "UPDATE venue_story_view_daily SET view_date = view_date - 1 WHERE story_id=$ACTIVE AND kind='click'" >/dev/null
rec "$ACTIVE" "$USER_A" click
check "click daily 합 = 3 (날짜 바뀌면 재집계)" "$(daily_total $ACTIVE click)" "3"
check "click daily 행 2개 (어제/오늘)" "$(daily_rows $ACTIVE click)" "2"

echo "[6) invalid kind → 조용히 no-op]"
rec "$ACTIVE" "$USER_A" bogus
check "bogus kind 카운트 없음" "$("${PSQL[@]}" -c "SELECT count(*) FROM venue_story_view_daily WHERE story_id=$ACTIVE AND kind NOT IN ('click','impression')")" "0"

echo "[7) removed/없는 스토리 → 조용히 no-op]"
rec "$REMOVED" "$USER_A" click
rec "$MISSING" "$USER_A" click
check "removed 카운트 0" "$(daily_total $REMOVED click)" "0"
check "없는 id 카운트 0" "$(daily_total $MISSING click)" "0"

echo "[8) 스토리 삭제 → marks CASCADE, daily 보존]"
BEFORE_C="$(daily_total $ACTIVE click)"
BEFORE_I="$(daily_total $ACTIVE impression)"
"${PSQL[@]}" -c "DELETE FROM venue_stories WHERE id=$ACTIVE" >/dev/null
check "marks CASCADE 정리" "$(marks_rows $ACTIVE)" "0"
check "click daily 보존" "$(daily_total $ACTIVE click)" "$BEFORE_C"
check "impression daily 보존" "$(daily_total $ACTIVE impression)" "$BEFORE_I"

echo "[9) 권한 — RPC service_role 전용, 테이블 anon/authenticated 차단]"
check "anon RPC 실행 불가" "$("${PSQL[@]}" -c "SELECT has_function_privilege('anon','record_venue_story_view(bigint,text,text)','EXECUTE')")" "f"
check "authenticated RPC 실행 불가" "$("${PSQL[@]}" -c "SELECT has_function_privilege('authenticated','record_venue_story_view(bigint,text,text)','EXECUTE')")" "f"
check "service_role RPC 실행 가능" "$("${PSQL[@]}" -c "SELECT has_function_privilege('service_role','record_venue_story_view(bigint,text,text)','EXECUTE')")" "t"
check "anon daily SELECT 불가" "$("${PSQL[@]}" -c "SELECT has_table_privilege('anon','venue_story_view_daily','SELECT')")" "f"
check "authenticated marks SELECT 불가" "$("${PSQL[@]}" -c "SELECT has_table_privilege('authenticated','venue_story_view_marks','SELECT')")" "f"

echo
echo "passed=$ok_count failed=$bad_count"
[ "$bad_count" -eq 0 ]
