#!/usr/bin/env bash
# venue_stories.upload_counted_at 마커 ↔ venue_story_upload_daily 롤업 1:1 정합 통합 회귀
# (삼순 PR #885 NO-GO 지정 필수 회귀).
#
# 임시 로컬 Postgres 에 upload_daily(롤업) + counted_marker(마커) migration 을 실제 적용한다.
# marker 적용 전에 실제 운영 순서(daily → counted active → removed/archived → marker)를 재현해
# 복원 불가능한 cutover가 명시적으로 abort하고 transaction 전체가 rollback되는지 먼저 검증한다.
# 그 뒤 정합 상태에서 marker migration 을 적용하고,
# 삼순이 지정한 경계 케이스마다 (마커 있는 행 수) == (롤업 uploads) 를 검증한다:
#   1) image INSERT active(story_geofence) → 마커 O, 롤업 +1
#   2) video pending → 마커 X / active 승격 → 마커 O
#   3) 동일 active 재UPDATE → 마커 값 불변(이중 마킹 없음)
#   4) admin_qa / legacy → 마커 X, 롤업 0
#   5) active → removed(신고삭제) → 마커 보존(카드 무차감과 대칭, 목록에 계속 노출)
#   6) pending → removed(검증실패) → 마커 X(카드 미집계와 동일)
#   7) active → archived(보관) → 마커 보존
#   8) KST created_at 날짜 귀속 = 롤업 upload_day 와 동일
#   9) 전 구간: count(upload_counted_at NOT NULL, media_type) == 롤업 uploads (정합 불변식)
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

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MIG_DAILY="$ROOT/supabase/migrations/20260725_venue_story_upload_daily.sql"
MIG_MARK="$ROOT/supabase/migrations/20260726_venue_story_upload_counted_marker.sql"
for f in "$MIG_DAILY" "$MIG_MARK"; do [ -f "$f" ] || { echo "migration not found: $f" >&2; exit 1; }; done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/venue-marker-qa.XXXXXX")"
DATADIR="$WORK/data"
SOCKDIR="$WORK/sock"
mkdir -p "$SOCKDIR"
cleanup() {
  "$PGBIN/pg_ctl" -D "$DATADIR" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATADIR" -A trust -U qa --locale=C --encoding=UTF8 >/dev/null
"$PGBIN/pg_ctl" -D "$DATADIR" -o "-p 59328 -k $SOCKDIR -c listen_addresses=''" -w start >/dev/null

PSQL=("$PGBIN/psql" -h "$SOCKDIR" -p 59328 -U qa -d postgres -v ON_ERROR_STOP=1 -qtA)

# ── 최소 스키마 스텁 (두 migration 이 참조하는 컬럼만; status CHECK 은 archived 포함) ──
"${PSQL[@]}" >/dev/null <<'SQL'
CREATE ROLE service_role NOLOGIN;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE TABLE venue_stories (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  status            TEXT NOT NULL CHECK (status IN ('pending','active','removed','cleanup_failed','archived')),
  attendance_source TEXT NOT NULL DEFAULT 'story_geofence',
  media_type        TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
SQL

# 롤업 migration 먼저 적용.
"${PSQL[@]}" -1 -f "$MIG_DAILY" >/dev/null

pass=0; fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "  ✅ $1"; else fail=$((fail+1)); echo "  ❌ $1 (got: $2 / want: $3)"; fi; }
roll() { "${PSQL[@]}" -c "SELECT COALESCE((SELECT uploads FROM venue_story_upload_daily WHERE upload_day='$1' AND media_type='$2'),0)"; }
mark() { "${PSQL[@]}" -c "SELECT count(*) FROM venue_stories WHERE upload_counted_at IS NOT NULL AND (created_at AT TIME ZONE 'Asia/Seoul')::date='$1' AND media_type='$2'"; }
markid() { "${PSQL[@]}" -c "SELECT CASE WHEN upload_counted_at IS NULL THEN 'null' ELSE 'set' END FROM venue_stories WHERE id=$1"; }

D=2026-07-25

echo "[0) 실제 cutover 순서: counted → removed/archived → marker = fail-close]"
"${PSQL[@]}" -c "INSERT INTO venue_stories (status, attendance_source, media_type, created_at) VALUES ('active','story_geofence','image','$D 10:00:00+09'), ('active','story_geofence','video','$D 10:30:00+09')" >/dev/null
"${PSQL[@]}" -c "UPDATE venue_stories SET status='removed' WHERE media_type='image'; UPDATE venue_stories SET status='archived' WHERE media_type='video';" >/dev/null
MIGRATION_LOG="$WORK/cutover-failure.log"
if "${PSQL[@]}" -1 -f "$MIG_MARK" >"$MIGRATION_LOG" 2>&1; then
  check "불일치 migration abort" "success" "failure"
else
  check "불일치 migration abort" "failure" "failure"
fi
COLUMN_EXISTS=$("${PSQL[@]}" -c "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='venue_stories' AND column_name='upload_counted_at'")
check "abort 시 ALTER COLUMN 포함 transaction rollback" "$COLUMN_EXISTS" "0"

# 다음 정상 cutover 회귀를 위해 롤업·원본을 함께 초기화한다.
"${PSQL[@]}" -c "TRUNCATE venue_stories, venue_story_upload_daily RESTART IDENTITY" >/dev/null
"${PSQL[@]}" -1 -f "$MIG_MARK" >/dev/null

echo "[1) image INSERT active → 마커 O]"
"${PSQL[@]}" -c "INSERT INTO venue_stories (status, attendance_source, media_type, created_at) VALUES ('active','story_geofence','image','$D 12:00:00+09')" >/dev/null
check "image active 마커 set" "$(markid 1)" "set"
check "정합: mark image == roll image (1)" "$(mark $D image)" "$(roll $D image)"

echo "[2) video pending → active]"
"${PSQL[@]}" -c "INSERT INTO venue_stories (status, attendance_source, media_type, created_at) VALUES ('pending','story_geofence','video','$D 13:00:00+09')" >/dev/null
check "pending 마커 null" "$(markid 2)" "null"
check "정합: pending 동안 mark==roll video (0)" "$(mark $D video)" "$(roll $D video)"
"${PSQL[@]}" -c "UPDATE venue_stories SET status='active' WHERE id=2" >/dev/null
check "pending→active 마커 set" "$(markid 2)" "set"
check "정합: 승격 후 mark==roll video (1)" "$(mark $D video)" "$(roll $D video)"

echo "[3) 동일 active 재UPDATE → 마커 불변]"
BEFORE=$("${PSQL[@]}" -c "SELECT upload_counted_at FROM venue_stories WHERE id=2")
"${PSQL[@]}" -c "UPDATE venue_stories SET status='active' WHERE id=2" >/dev/null
AFTER=$("${PSQL[@]}" -c "SELECT upload_counted_at FROM venue_stories WHERE id=2")
check "재UPDATE 후 마커 값 불변" "$BEFORE" "$AFTER"

echo "[4) admin_qa / legacy → 마커 X]"
"${PSQL[@]}" -c "INSERT INTO venue_stories (status, attendance_source, media_type, created_at) VALUES ('active','admin_qa','image','$D 14:00:00+09')" >/dev/null
"${PSQL[@]}" -c "INSERT INTO venue_stories (status, attendance_source, media_type, created_at) VALUES ('active','legacy_unclassified','image','$D 14:30:00+09')" >/dev/null
check "admin_qa 마커 null" "$(markid 3)" "null"
check "legacy 마커 null" "$(markid 4)" "null"
check "정합: mark==roll image 여전히 1" "$(mark $D image)" "$(roll $D image)"

echo "[5) active → removed(신고삭제) → 마커 보존]"
"${PSQL[@]}" -c "INSERT INTO venue_stories (status, attendance_source, media_type, created_at) VALUES ('active','story_geofence','image','$D 15:00:00+09')" >/dev/null
check "removed 전 마커 set" "$(markid 5)" "set"
R_BEFORE=$(roll $D image)
"${PSQL[@]}" -c "UPDATE venue_stories SET status='removed' WHERE id=5" >/dev/null
check "active→removed 후 마커 보존(set)" "$(markid 5)" "set"
check "롤업 무차감(불변)" "$(roll $D image)" "$R_BEFORE"
check "정합: mark==roll image (removed 포함, 무차감 대칭)" "$(mark $D image)" "$(roll $D image)"

echo "[6) pending → removed(검증실패) → 마커 X]"
"${PSQL[@]}" -c "INSERT INTO venue_stories (status, attendance_source, media_type, created_at) VALUES ('pending','story_geofence','video','$D 16:00:00+09')" >/dev/null
"${PSQL[@]}" -c "UPDATE venue_stories SET status='removed' WHERE id=6" >/dev/null
check "pending→removed 마커 null(카드 미집계와 동일)" "$(markid 6)" "null"
check "정합: mark==roll video (검증실패 제외)" "$(mark $D video)" "$(roll $D video)"

echo "[7) active → archived(보관) → 마커 보존]"
"${PSQL[@]}" -c "INSERT INTO venue_stories (status, attendance_source, media_type, created_at) VALUES ('active','story_geofence','image','$D 17:00:00+09')" >/dev/null
"${PSQL[@]}" -c "UPDATE venue_stories SET status='archived' WHERE id=7" >/dev/null
check "active→archived 후 마커 보존(set)" "$(markid 7)" "set"
check "정합: mark==roll image (archived 포함)" "$(mark $D image)" "$(roll $D image)"

echo "[8) KST 경계 created_at 귀속]"
"${PSQL[@]}" -c "INSERT INTO venue_stories (status, attendance_source, media_type, created_at) VALUES ('active','story_geofence','image','$D 23:59:00+09')" >/dev/null
"${PSQL[@]}" -c "INSERT INTO venue_stories (status, attendance_source, media_type, created_at) VALUES ('active','story_geofence','image','2026-07-26 00:00:00+09')" >/dev/null
check "정합: 25일 mark==roll image" "$(mark $D image)" "$(roll $D image)"
check "정합: 26일 mark==roll image" "$(mark 2026-07-26 image)" "$(roll 2026-07-26 image)"

echo "[9) 전 구간 정합 불변식 재확인]"
check "최종 25일 video mark==roll" "$(mark $D video)" "$(roll $D video)"
check "최종 26일 video mark==roll" "$(mark 2026-07-26 video)" "$(roll 2026-07-26 video)"

echo "[10) marker migration 멱등 재적용]"
if "${PSQL[@]}" -1 -f "$MIG_MARK" >/dev/null 2>&1; then
  check "removed/archived 마커 포함 재적용 성공" "success" "success"
else
  check "removed/archived 마커 포함 재적용 성공" "failure" "success"
fi
check "재적용 후 25일 image 정합" "$(mark $D image)" "$(roll $D image)"

echo ""
echo "venue-story-counted-marker: $pass pass, $fail fail"
[ "$fail" -eq 0 ]
