#!/usr/bin/env bash
# home_popular_posts RPC 실제 SQL 검증 (PostgreSQL 17 로컬 인스턴스, npm run qa:home-popular-feed:pg17)
#
# 마이그레이션(생성 컬럼 + 인덱스 + RPC)을 최소 스키마 위에 실제로 적용하고 픽스처로 판정을 확인한다.
#  P1 정렬·limit: popularity desc, id desc / limit = p_limit (want+1 확인행은 호출자 몫)
#  P2 최애팀 단독: team_tags = [slug] 만. 다팀·전체구단·타팀 단독 제외
#  P3 선수 태그 ID 판정: 타팀 선수 ID 태그 → 제외. 같은 팀 선수·이름 뒤 공백·로스터에 없는 ID → 포함(배지 SSOT 동일)
#  P4 차단·제외: p_blocked 작성자 제외, p_exclude(화면 id) 제외
#  P5 순위 상승 반례: 첫 페이지 밖 글(95)이 110 으로 올라도 다음 페이지(제외 목록 방식)에 나온다 — 커서 방식이면 누락
#  P6 창·숨김: created_at < p_since, is_hidden 제외 / 전체(all) 보드는 board_type 4종
#  P7 limit 상한 100·음수 0 / grant anon·authenticated
set -euo pipefail
export LC_ALL=C LANG=C
for cand in "$(dirname "$(command -v initdb 2>/dev/null || true)")" /opt/homebrew/opt/postgresql@17/bin /usr/local/opt/postgresql@17/bin; do
  if [[ -x "$cand/initdb" && -x "$cand/postgres" && -x "$cand/psql" ]]; then PGBIN="$cand"; break; fi
done
# ci-tier 러너(ubuntu)에는 postgresql@17 이 없다 — 선례(player-popularity-rpc-pg17.sh)와 같이 SKIP 으로 명시하고 0 종료.
# 실제 SQL 판정은 로컬(postgresql@17)·result-tone 워크플로의 PG17 docker 단계에서 돈다. SKIP 은 PASS 가 아니다.
[[ -n "${PGBIN:-}" ]] || { echo "SKIP: postgresql@17 binaries not found — home_popular_posts RPC SQL 검증 미실행(로컬/PG17 docker 에서 실행)"; exit 0; }
WORK="$(mktemp -d "${OPENCLAW_REVIEW_ROOT:-${TMPDIR:-/tmp}}/home-popular-rpc.XXXXXX")"
trap '"$PGBIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT
PORT=$((59500 + RANDOM % 100))
"$PGBIN/initdb" -D "$WORK/data" -A trust -U postgres --locale=C --encoding=UTF8 >/dev/null
"$PGBIN/pg_ctl" -D "$WORK/data" -l "$WORK/postgres.log" -o "-k $WORK -p $PORT -c fsync=off -c full_page_writes=off" -w start >/dev/null
PSQL=("$PGBIN/psql" -h "$WORK" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -qtA)
SERVER_VERSION_NUM="$("${PSQL[@]}" -c "show server_version_num")"
[[ "$SERVER_VERSION_NUM" =~ ^17[0-9]{4}$ ]] || { echo "FAIL: expected PostgreSQL 17 server, got server_version_num=$SERVER_VERSION_NUM"; exit 1; }
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MIGRATION="$ROOT/supabase/migrations/20260905043000_posts_popularity.sql"

"${PSQL[@]}" <<'SQL' >/dev/null
DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE public.posts(
  id bigint PRIMARY KEY,
  author_id uuid NOT NULL,
  board_type text NOT NULL DEFAULT 'team',
  board_id text,
  like_count integer DEFAULT 0,
  comment_count integer DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  is_hidden boolean DEFAULT false,
  team_tags jsonb DEFAULT '[]'::jsonb,
  player_tags jsonb DEFAULT '[]'::jsonb
);
SQL
"${PSQL[@]}" -f "$MIGRATION" >/dev/null

A1=00000000-0000-4000-8000-000000000001
BAD=00000000-0000-4000-8000-00000000000b
# id, author, like, comment, created_offset(interval), hidden, team_tags, player_tags, board_type
"${PSQL[@]}" <<SQL >/dev/null
INSERT INTO public.posts(id, author_id, like_count, comment_count, created_at, is_hidden, team_tags, player_tags, board_type) VALUES
 (1000, '$A1', 60, 40, now() - interval '1 day', false, '["lg"]', '[]', 'team'),                      -- 100 LG 단독
 ( 999, '$A1', 50, 49, now() - interval '1 day', false, '["lg"]', '["79109:오지환"]', 'team'),        -- 99  LG 선수
 ( 998, '$A1', 50, 48, now() - interval '1 day', false, '["lg"]', '["79109:오지환 "]', 'team'),       -- 98  이름 뒤 공백 → 포함(ID 판정)
 ( 997, '$A1', 50, 47, now() - interval '1 day', false, '["lg"]', '["ZZ999:은퇴선수"]', 'team'),     -- 97  로스터 밖 ID → 포함(SSOT 무시)
 ( 996, '$A1', 50, 46, now() - interval '1 day', false, '["lg"]', '["79109:오지환","63123:강승호"]', 'team'), -- 96 두산 선수 섞임 → 제외
 ( 995, '$A1', 50, 45, now() - interval '1 day', false, '["lg","doosan"]', '[]', 'team'),           -- 95  다팀 → 제외
 ( 994, '$A1', 50, 44, now() - interval '1 day', false, '["doosan"]', '[]', 'team'),                -- 94  타팀 단독 → 제외
 ( 993, '$BAD', 50, 43, now() - interval '1 day', false, '["lg"]', '[]', 'team'),                   -- 93  차단 작성자
 ( 992, '$A1', 50, 42, now() - interval '9 day', false, '["lg"]', '[]', 'team'),                    -- 92  창 밖
 ( 991, '$A1', 50, 41, now() - interval '1 day', true,  '["lg"]', '[]', 'team'),                    -- 91  숨김
 ( 990, '$A1', 50, 40, now() - interval '1 day', false, '["lg"]', '[]', 'poll'),                    -- 90  투표글도 LG 단독
 ( 989, '$A1', 40, 40, now() - interval '1 day', false, '["lg"]', '[]', 'team'),                    -- 80  동점 tie-break 용
 ( 988, '$A1', 40, 40, now() - interval '1 day', false, '["lg"]', '[]', 'team'),                    -- 80
 ( 987, '$A1', 30, 30, now() - interval '1 day', false, '["lg","doosan","kt","ssg","nc","kia","lotte","samsung","hanwha","kiwoom"]', '[]', 'team'); -- 60 전체구단 → 제외
SQL

SINCE="now() - interval '7 day'"
OTHER="ARRAY['63123','50000']"   # 두산 강승호 + 임의 타팀 ID: 로스터 거부 목록 축약
q() { "${PSQL[@]}" -c "select string_agg(id::text, ',' order by popularity desc, id desc) from public.home_popular_posts($SINCE, $1, $2, $3, $4, $5)"; }

pass=0; fail=0
check() { if [[ "$2" == "$3" ]]; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  ❌ FAIL  $1 — got [$2] want [$3]"; fail=$((fail+1)); fi; }

echo "── P1~P3 LG 단독 첫 페이지(limit 6, 차단 없음)"
# 차단 없음 → 993(차단 후보 작성자)도 정상 노출. 996(두산 선수 섞임)·995(다팀)·994(타팀)·992(창 밖)·991(숨김)·987(전체구단) 제외.
check "P1 정렬 popularity desc·id desc / limit 6 (ID 판정: 공백 이름 998·로스터 밖 997 포함, 두산 섞임 996 제외)" "$(q 6 "'lg'" "$OTHER" "'{}'" "'{}'")" "1000,999,998,997,993,990"
echo "── P4 차단·제외"
check "P4 차단 작성자 제외(limit 20)" "$(q 20 "'lg'" "$OTHER" "ARRAY['$BAD']::uuid[]" "'{}'")" "1000,999,998,997,990,989,988"
check "P4 차단 없음이면 993 포함" "$(q 20 "'lg'" "$OTHER" "'{}'" "'{}'")" "1000,999,998,997,993,990,989,988"
check "P4 화면 id 제외(다음 페이지)" "$(q 6 "'lg'" "$OTHER" "'{}'" "ARRAY[1000,999,998,997,993]::bigint[]")" "990,989,988"
echo "── P5 순위 상승 반례"
"${PSQL[@]}" -c "update public.posts set like_count = 70, comment_count = 40 where id = 990" >/dev/null   # 90 → 110
check "P5 미노출 글 990 이 110 으로 상승 → 제외 목록 방식 다음 페이지 최상단" "$(q 6 "'lg'" "$OTHER" "'{}'" "ARRAY[1000,999,998,997,993]::bigint[]")" "990,989,988"
check "P5 커서 방식이면 누락(popularity<93 조건 재현)" "$("${PSQL[@]}" -c "select coalesce(string_agg(id::text, ','), '') from public.posts where team_tags = '[\"lg\"]' and is_hidden is not true and popularity < 93 and id = 990")" ""
"${PSQL[@]}" -c "update public.posts set like_count = 50, comment_count = 40 where id = 990" >/dev/null
echo "── P6 창·숨김·전체 보드"
check "P6 창 밖(992)·숨김(991) 제외" "$(q 50 "'lg'" "$OTHER" "'{}'" "'{}'" | tr ',' '\n' | grep -c -E '^(992|991)$' || true)" "0"
check "P6 전체(all) 보드는 팀 무관 board_type 4종·창·숨김만" "$(q 50 "null" "'{}'" "'{}'" "'{}'")" "1000,999,998,997,996,995,994,993,990,989,988,987"
echo "── P7 상한·grant"
"${PSQL[@]}" -c "insert into public.posts(id,author_id,team_tags) select i,'$A1','[\"lg\"]' from generate_series(10000,10124) i" >/dev/null
check "P7 limit 상한 100 (후보 125건 초과)" "$("${PSQL[@]}" -c "select count(*) from public.home_popular_posts($SINCE, 1000, null, '{}', '{}', '{}')")" "100"
check "P7 limit 음수 → 0" "$("${PSQL[@]}" -c "select count(*) from public.home_popular_posts($SINCE, -5, null, '{}', '{}', '{}')")" "0"
check "P7 anon·authenticated execute grant" "$("${PSQL[@]}" -c "select string_agg(r, ',' order by r) from (select unnest(array['anon','authenticated']) r) x where has_function_privilege(r, 'public.home_popular_posts(timestamptz,integer,text,text[],uuid[],bigint[])', 'execute')")" "anon,authenticated"
check "P7 security invoker(정의자 아님)" "$("${PSQL[@]}" -c "select prosecdef from pg_proc where proname = 'home_popular_posts'")" "f"

echo
if [[ $fail -gt 0 ]]; then echo "❌ home-popular-posts-rpc-pg17 FAIL — pass $pass / fail $fail"; exit 1; fi
echo "✅ home-popular-posts-rpc-pg17 PASS — $pass"
