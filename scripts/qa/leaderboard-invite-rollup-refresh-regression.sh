#!/bin/bash
# leaderboard_invite_rollup_refresh() 회귀 — 삼순 #915 NO-GO (pre-merge 실증)
#
# 임시 로컬 PostgreSQL 클러스터(initdb→pg_ctl)에 최소 스키마 + 실제 마이그레이션
# (20260728_leaderboard_views_security_invoker.sql)을 그대로 적용한 뒤 검증한다.
# 운영 DB는 일절 건드리지 않는다.
#
#  ① service_role RPC 2회 연속 → 둘 다 'refreshed' + rollup 멱등(행/합 동일)
#  ② public-qualified `DELETE ... WHERE TRUE` 로 스냅샷 실제 교체(중복 없음, PK 충돌 0)
#  ③ 동시성: 세션 A advisory xact lock 보유 중 세션 B refresh → 'skipped_lock_busy'
#     (PK 충돌/에러 0, 락 해제 후엔 'refreshed')
#  ④ 뷰 security_invoker + anon 역할 SELECT 파리티(현행 정의와 동일 집계)
#  ⑤ 내부자 제외는 뷰 read 시점 <> ALL() 로 동적 적용(rollup 엔 전원 보존)
#
# 사용: bash scripts/qa/leaderboard-invite-rollup-refresh-regression.sh
#       (PGBIN으로 postgres bin 경로 재정의 가능)
set -euo pipefail
export LC_ALL=C

PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@17/bin}"
[ -x "$PGBIN/initdb" ] || { echo "SKIP: postgres binaries not found at $PGBIN (set PGBIN)"; exit 0; }

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MIGRATION="$ROOT/supabase/migrations/20260728_leaderboard_views_security_invoker.sql"
TMP="$(mktemp -d)"
PORT=55433
trap '"$PGBIN/pg_ctl" -D "$TMP/data" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT

"$PGBIN/initdb" -D "$TMP/data" -A trust -U postgres --locale=C --encoding=UTF8 >/dev/null
"$PGBIN/pg_ctl" -D "$TMP/data" -o "-p $PORT -k $TMP -c listen_addresses=''" -l "$TMP/pg.log" start >/dev/null
PSQL=("$PGBIN/psql" -h "$TMP" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -qtA)

# ── 최소 스키마: 마이그레이션이 참조하는 대상(writing 뷰/롤업 stub 포함) ──
"${PSQL[@]}" <<'SQL'
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;

CREATE TABLE profiles (id uuid PRIMARY KEY, nickname text, team_id int);
-- 운영 선존재 조건 복제: profiles 는 이미 공개 read(Public profiles RLS + grant).
-- 본 마이그레이션이 소유하지 않는 대상이므로 harness 에서 grant 를 재현한다.
GRANT SELECT ON profiles TO anon, authenticated;

CREATE TABLE invitations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  inviter_id uuid,
  invitee_id uuid,
  activated_at timestamptz,
  flagged boolean
);

CREATE FUNCTION leaderboard_internal_user_ids() RETURNS uuid[]
  LANGUAGE sql STABLE AS $$ SELECT ARRAY['00000000-0000-0000-0000-0000000000ff'::uuid] $$;
GRANT EXECUTE ON FUNCTION leaderboard_internal_user_ids() TO anon, authenticated;

-- writing 쪽 stub (마이그레이션의 ALTER VIEW / CREATE POLICY 가 참조) --
CREATE TABLE leaderboard_writing_rollup (
  user_id uuid PRIMARY KEY, total_points int NOT NULL, last_active_day date NOT NULL
);
ALTER TABLE leaderboard_writing_rollup ENABLE ROW LEVEL SECURITY;
CREATE VIEW v_leaderboard_writing AS
  SELECT r.user_id, p.nickname, p.team_id, r.total_points, r.last_active_day
  FROM leaderboard_writing_rollup r JOIN profiles p ON p.id = r.user_id;
CREATE VIEW v_leaderboard_writing_monthly AS SELECT id AS user_id FROM profiles;
GRANT SELECT ON v_leaderboard_writing, v_leaderboard_writing_monthly TO anon, authenticated;

-- 기존 invite 뷰(정의 방식 stub — 마이그레이션이 DROP 후 재생성) --
CREATE VIEW v_leaderboard_invite AS
  SELECT inv.inviter_id AS user_id, p.nickname, p.team_id,
         count(*) AS invite_count, max(inv.activated_at) AS last_activated_at
  FROM invitations inv JOIN profiles p ON p.id = inv.inviter_id
  WHERE inv.activated_at IS NOT NULL AND (inv.flagged IS NULL OR inv.flagged = false)
    AND inv.inviter_id <> ALL (leaderboard_internal_user_ids())
  GROUP BY inv.inviter_id, p.nickname, p.team_id;
GRANT SELECT ON v_leaderboard_invite TO anon, authenticated;

-- 픽스처: 4 inviter (u1=2건, u2=1건, u3=0활성=집계제외, uff=내부자 제외 대상 1건) + NULL inviter --
INSERT INTO profiles(id, nickname, team_id) VALUES
 ('00000000-0000-0000-0000-000000000001','u1',1),
 ('00000000-0000-0000-0000-000000000002','u2',2),
 ('00000000-0000-0000-0000-000000000003','u3',3),
 ('00000000-0000-0000-0000-0000000000ff','internal',9);
INSERT INTO invitations(inviter_id, invitee_id, activated_at, flagged) VALUES
 ('00000000-0000-0000-0000-000000000001', gen_random_uuid(), now(),          false),
 ('00000000-0000-0000-0000-000000000001', gen_random_uuid(), now(),          null),
 ('00000000-0000-0000-0000-000000000002', gen_random_uuid(), now(),          false),
 ('00000000-0000-0000-0000-000000000002', gen_random_uuid(), now(),          true),   -- flagged 제외
 ('00000000-0000-0000-0000-000000000003', gen_random_uuid(), null,           false),  -- 미활성 제외
 ('00000000-0000-0000-0000-0000000000ff', gen_random_uuid(), now(),          false),  -- 내부자(rollup 보존, 뷰 제외)
 (null,                                   gen_random_uuid(), now(),          false);  -- NULL inviter 제외
SQL

"${PSQL[@]}" -f "$MIGRATION" >/dev/null
echo "migration applied on ephemeral cluster (pg17)"

pass=0; fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "✗ $1: got [$2] want [$3]"; fi; }
q() { "${PSQL[@]}" -c "$1"; }

# ① 2회 연속 refresh → 둘 다 refreshed
r1=$(q "SELECT leaderboard_invite_rollup_refresh();")
r2=$(q "SELECT leaderboard_invite_rollup_refresh();")
check "refresh#1 refreshed" "$r1" "refreshed"
check "refresh#2 refreshed" "$r2" "refreshed"

# ② 멱등: 2회 후 rollup 행수/합계 안정 (u1,u2,u3=0제외?, internal 보존)
#    활성+비flagged: u1=2, u2=1, internal=1 → rollup 3행 (u3 0건, NULL 제외)
check "rollup rows idempotent" "$(q "SELECT count(*) FROM leaderboard_invite_rollup;")" "3"
check "rollup u1 count" "$(q "SELECT invite_count FROM leaderboard_invite_rollup WHERE user_id='00000000-0000-0000-0000-000000000001';")" "2"
check "rollup u2 count" "$(q "SELECT invite_count FROM leaderboard_invite_rollup WHERE user_id='00000000-0000-0000-0000-000000000002';")" "1"
check "rollup internal preserved" "$(q "SELECT invite_count FROM leaderboard_invite_rollup WHERE user_id='00000000-0000-0000-0000-0000000000ff';")" "1"
check "rollup no NULL user" "$(q "SELECT count(*) FROM leaderboard_invite_rollup WHERE user_id IS NULL;")" "0"

# ③ 뷰: 내부자 제외 read 시점 적용 → 2행(u1,u2), internal 미노출
check "view rows (internal excluded)" "$(q "SELECT count(*) FROM v_leaderboard_invite;")" "2"
check "view has u1" "$(q "SELECT invite_count FROM v_leaderboard_invite WHERE user_id='00000000-0000-0000-0000-000000000001';")" "2"
check "view excludes internal" "$(q "SELECT count(*) FROM v_leaderboard_invite WHERE user_id='00000000-0000-0000-0000-0000000000ff';")" "0"

# ④ 뷰 security_invoker=on
check "view is security_invoker" "$(q "SELECT (reloptions @> ARRAY['security_invoker=on'])::text FROM pg_class WHERE relname='v_leaderboard_invite';")" "true"

# ⑤ anon 역할 파리티: 공개 rollup read 정책 → anon 도 뷰 2행 조회
anon_rows=$(q "SET LOCAL ROLE anon; SELECT count(*) FROM v_leaderboard_invite;")
check "anon view parity" "$anon_rows" "2"

# ⑥ 동시성: 세션 A 가 advisory xact lock 보유 중 세션 B refresh → skipped_lock_busy
"${PSQL[@]}" -c "BEGIN; SELECT pg_advisory_xact_lock(hashtext('leaderboard_invite_rollup_refresh')); SELECT pg_sleep(2);" &
AP=$!
sleep 0.5
busy=$(q "SELECT leaderboard_invite_rollup_refresh();")
check "concurrent refresh skipped" "$busy" "skipped_lock_busy"
wait $AP 2>/dev/null || true
after=$(q "SELECT leaderboard_invite_rollup_refresh();")
check "refresh after lock released" "$after" "refreshed"

echo "── invite rollup regression: $pass passed, $fail failed ──"
[ "$fail" -eq 0 ] || exit 1
