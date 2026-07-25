#!/usr/bin/env bash
# venue_story_upload_daily 영구 롤업 통합 회귀 (삼순 PR #861 NO-GO 지정 필수 회귀).
#
# 임시 로컬 Postgres 클러스터를 띄워 migration 을 실제 적용한 뒤:
#   1) image INSERT active → +1
#   2) video pending → active → +1 (pending 동안은 0)
#   3) 동일 active 재UPDATE → 0 증가 (이중집계 방지)
#   4) attendance_source='admin_qa' → 0 (지표 오염 제외)
#   5) KST 23:59 / 00:00 경계 → 정확한 upload_day 귀속
#   6) migration 재실행 후 기존 누적 합계 불변 (cleanup 삭제 뒤에도 DO NOTHING 멱등)
#   7) admin_venue_story_daily RPC 영상/사진 분해 정확
# supabase local 없이도 도는 순수 pg 통합 테스트.
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

MIGRATION="$(cd "$(dirname "$0")/../.." && pwd)/supabase/migrations/20260725_venue_story_upload_daily.sql"
[ -f "$MIGRATION" ] || { echo "migration not found: $MIGRATION" >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/venue-upload-qa.XXXXXX")"
DATADIR="$WORK/data"
SOCKDIR="$WORK/sock"
mkdir -p "$SOCKDIR"
cleanup() {
  "$PGBIN/pg_ctl" -D "$DATADIR" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATADIR" -A trust -U qa --locale=C --encoding=UTF8 >/dev/null
"$PGBIN/pg_ctl" -D "$DATADIR" -o "-p 59327 -k $SOCKDIR -c listen_addresses=''" -w start >/dev/null

PSQL=("$PGBIN/psql" -h "$SOCKDIR" -p 59327 -U qa -d postgres -v ON_ERROR_STOP=1 -qtA)

# ── 최소 스키마 스텁 (migration 이 참조하는 venue_stories 컬럼만) ──
"${PSQL[@]}" >/dev/null <<'SQL'
CREATE ROLE service_role NOLOGIN;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE TABLE venue_stories (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  status            TEXT NOT NULL,
  attendance_source TEXT NOT NULL DEFAULT 'story_geofence',
  media_type        TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
SQL

# migration 은 Supabase 처럼 단일 트랜잭션으로 적용해야 LOCK TABLE 이 유효(cutover 원자화 재현).
"${PSQL[@]}" -1 -f "$MIGRATION" >/dev/null

pass=0; fail=0
check() { # name actual expected
  if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "  ✅ $1"
  else fail=$((fail+1)); echo "  ❌ $1 (got: $2 / want: $3)"; fi
}
cnt() { # day media_type → uploads (없으면 0)
  "${PSQL[@]}" -c "SELECT COALESCE((SELECT uploads FROM venue_story_upload_daily WHERE upload_day='$1' AND media_type='$2'),0)"
}

echo "[1) image INSERT active → +1]"
"${PSQL[@]}" -c "INSERT INTO venue_stories (status, attendance_source, media_type, created_at) VALUES ('active','story_geofence','image','2026-07-25 12:00:00+09')" >/dev/null
check "2026-07-25 image = 1" "$(cnt 2026-07-25 image)" "1"

echo "[2) video pending → active]"
"${PSQL[@]}" -c "INSERT INTO venue_stories (status, attendance_source, media_type, created_at) VALUES ('pending','story_geofence','video','2026-07-25 13:00:00+09')" >/dev/null
check "pending 동안 video = 0" "$(cnt 2026-07-25 video)" "0"
"${PSQL[@]}" -c "UPDATE venue_stories SET status='active' WHERE media_type='video' AND status='pending'" >/dev/null
check "pending→active 후 video = 1" "$(cnt 2026-07-25 video)" "1"

echo "[3) 동일 active 재UPDATE → 0 증가]"
"${PSQL[@]}" -c "UPDATE venue_stories SET status='active' WHERE media_type='video'" >/dev/null
check "active→active 재UPDATE 후 video 여전히 1" "$(cnt 2026-07-25 video)" "1"

echo "[4) admin_qa → 0]"
"${PSQL[@]}" -c "INSERT INTO venue_stories (status, attendance_source, media_type, created_at) VALUES ('active','admin_qa','image','2026-07-25 14:00:00+09')" >/dev/null
"${PSQL[@]}" -c "INSERT INTO venue_stories (status, attendance_source, media_type, created_at) VALUES ('active','legacy_unclassified','image','2026-07-25 14:30:00+09')" >/dev/null
check "admin_qa/legacy 미집계 → 2026-07-25 image 여전히 1" "$(cnt 2026-07-25 image)" "1"

echo "[5) KST 23:59 / 00:00 경계 귀속]"
# 23:59 KST 25일 = 14:59 UTC 25일 / 00:00 KST 26일 = 15:00 UTC 25일
"${PSQL[@]}" -c "INSERT INTO venue_stories (status, attendance_source, media_type, created_at) VALUES ('active','story_geofence','image','2026-07-25 23:59:00+09')" >/dev/null
"${PSQL[@]}" -c "INSERT INTO venue_stories (status, attendance_source, media_type, created_at) VALUES ('active','story_geofence','image','2026-07-26 00:00:00+09')" >/dev/null
check "23:59 KST → 2026-07-25 image = 2" "$(cnt 2026-07-25 image)" "2"
check "00:00 KST → 2026-07-26 image = 1" "$(cnt 2026-07-26 image)" "1"

echo "[7) admin_venue_story_daily RPC 분해]"
RPC=$("${PSQL[@]}" -c "SELECT day||':'||videos||'/'||photos FROM admin_venue_story_daily() WHERE day='2026-07-25'")
check "RPC 2026-07-25 = videos1/photos2" "$RPC" "2026-07-25:1/2"

echo "[6) migration 재실행 멱등 — cleanup 삭제 뒤에도 누적 불변]"
BEFORE_I=$(cnt 2026-07-25 image); BEFORE_V=$(cnt 2026-07-25 video)
# cleanup cron 이 그날 active 행을 전부 삭제한 상황 시뮬레이션
"${PSQL[@]}" -c "DELETE FROM venue_stories WHERE created_at::date IN ('2026-07-25','2026-07-26')" >/dev/null
# migration 재실행 (백필 DO NOTHING + LOCK, 단일 트랜잭션)
"${PSQL[@]}" -1 -f "$MIGRATION" >/dev/null
check "재실행 후 2026-07-25 image 불변" "$(cnt 2026-07-25 image)" "$BEFORE_I"
check "재실행 후 2026-07-25 video 불변" "$(cnt 2026-07-25 video)" "$BEFORE_V"
check "재실행 후 2026-07-26 image 불변(=1)" "$(cnt 2026-07-26 image)" "1"

echo ""
echo "venue-story-upload-daily: $pass pass, $fail fail"
[ "$fail" -eq 0 ]
