#!/usr/bin/env bash
# 직관 스토리 조회수 트래킹(A안) RPC dedupe 회귀.
#
# 임시 로컬 Postgres 클러스터에 migration 을 실제 적용한 뒤 record_venue_story_view 검증:
#   1) 첫 조회 → daily +1, mark 1행
#   2) 같은 뷰어 같은 날 재조회 → 증가 없음 (dedupe)
#   3) 다른 뷰어 → +1
#   4) 다른 KST 날짜 → 새 daily 행 +1 (일 단위 dedupe 키 확인)
#   5) removed / 존재하지 않는 스토리 → 조용히 no-op (에러·카운트 없음)
#   6) 스토리 DELETE → marks CASCADE 정리, daily 롤업은 영구 보존
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

pass=0 fail=0
check() { # name actual expected
  if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "  ✅ $1"
  else fail=$((fail+1)); echo "  ❌ $1 (got: $2 / want: $3)"; fi
}
daily_total() { # story_id → 전체 기간 view_count 합 (없으면 0)
  "${PSQL[@]}" -c "SELECT COALESCE(sum(view_count),0) FROM venue_story_view_daily WHERE story_id=$1"
}
daily_rows() { # story_id → daily 행 수
  "${PSQL[@]}" -c "SELECT count(*) FROM venue_story_view_daily WHERE story_id=$1"
}
marks_rows() { # story_id → marks 행 수
  "${PSQL[@]}" -c "SELECT count(*) FROM venue_story_view_marks WHERE story_id=$1"
}
rec() { # story_id viewer_key
  "${PSQL[@]}" -c "SELECT record_venue_story_view($1, '$2')" >/dev/null
}

"${PSQL[@]}" -c "INSERT INTO venue_stories (status) VALUES ('active'), ('removed')" >/dev/null
ACTIVE=1 REMOVED=2 MISSING=999

echo "[1) 첫 조회 → +1]"
rec "$ACTIVE" viewer-a
check "daily 합 = 1" "$(daily_total $ACTIVE)" "1"
check "marks = 1" "$(marks_rows $ACTIVE)" "1"

echo "[2) 같은 뷰어 같은 날 재조회 → dedupe]"
rec "$ACTIVE" viewer-a
rec "$ACTIVE" viewer-a
check "daily 합 여전히 1" "$(daily_total $ACTIVE)" "1"
check "marks 여전히 1" "$(marks_rows $ACTIVE)" "1"

echo "[3) 다른 뷰어 → +1]"
rec "$ACTIVE" viewer-b
check "daily 합 = 2" "$(daily_total $ACTIVE)" "2"

echo "[4) 다른 KST 날짜 → 새 daily 행 +1]"
# RPC 는 now() 기준이므로 viewer-a 의 오늘 mark 를 어제로 밀어 '어제 이미 봤던 뷰어' 상황 재현.
"${PSQL[@]}" -c "UPDATE venue_story_view_marks SET view_date = view_date - 1 WHERE story_id=$ACTIVE AND viewer_key='viewer-a'" >/dev/null
"${PSQL[@]}" -c "UPDATE venue_story_view_daily SET view_date = view_date - 1 WHERE story_id=$ACTIVE" >/dev/null
rec "$ACTIVE" viewer-a
check "daily 합 = 3 (날짜 바뀌면 재집계)" "$(daily_total $ACTIVE)" "3"
check "daily 행 2개 (어제/오늘)" "$(daily_rows $ACTIVE)" "2"

echo "[5) removed/없는 스토리 → 조용히 no-op]"
rec "$REMOVED" viewer-a
rec "$MISSING" viewer-a
check "removed 카운트 0" "$(daily_total $REMOVED)" "0"
check "없는 id 카운트 0" "$(daily_total $MISSING)" "0"

echo "[6) 스토리 삭제 → marks CASCADE, daily 보존]"
BEFORE="$(daily_total $ACTIVE)"
"${PSQL[@]}" -c "DELETE FROM venue_stories WHERE id=$ACTIVE" >/dev/null
check "marks CASCADE 정리" "$(marks_rows $ACTIVE)" "0"
check "daily 롤업 보존" "$(daily_total $ACTIVE)" "$BEFORE"

echo
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
