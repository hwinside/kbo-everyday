#!/usr/bin/env bash
# 계정삭제(공식 탈퇴) P0 회귀: SECURITY DEFINER 카운트 트리거 search_path 미고정.
#
# Production 재현: auth admin(GoTrue) 세션은 search_path 에 public 이 없다.
# auth.users 삭제 → comments/likes FK CASCADE → update_comment_count /
# update_like_count 트리거 발화 → unqualified `posts` 참조가 42P01 로 깨져
# 탈퇴 전체가 실패(500)했다.
#
# 임시 로컬 Postgres 17 클러스터에서:
#   RED  : 취약(구) 함수 정의(src/lib/supabase/functions.sql 동일) 상태에서
#          search_path=auth 세션으로 유저 삭제 → 42P01 재현.
#   GREEN: 20260730_fix_count_trigger_search_path.sql 적용 후 동일 시나리오 성공
#          — auth user/profile 삭제, comments/likes cascade, posts count 정합,
#          DM sender 익명화·대화 보존, pg_get_functiondef 에 search_path 고정 확인.
#
# 요구: PostgreSQL 17 (PATH 또는 /opt/homebrew/opt/postgresql@17/bin). 없으면 SKIP(exit 2).
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
MIGRATION="$ROOT/supabase/migrations/20260730_fix_count_trigger_search_path.sql"
[ -f "$MIGRATION" ] || { echo "migration not found: $MIGRATION" >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/del-user-qa.XXXXXX")"
DATADIR="$WORK/data"; SOCKDIR="$WORK/sock"; mkdir -p "$SOCKDIR"
cleanup() { "$PGBIN/pg_ctl" -D "$DATADIR" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATADIR" -A trust -U qa --locale=C --encoding=UTF8 >/dev/null
"$PGBIN/pg_ctl" -D "$DATADIR" -o "-p 59327 -k $SOCKDIR -c listen_addresses=''" -w start >/dev/null
PSQL=("$PGBIN/psql" -h "$SOCKDIR" -p 59327 -U qa -d postgres -v ON_ERROR_STOP=1 -qtA)

pass=0 fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "  ✅ $1"; else fail=$((fail+1)); echo "  ❌ $1 (got: $2 / want: $3)"; fi; }

# --- 스키마: production 계약의 최소 재현 (auth.users 루트 + cascade/anonymize FK) ---
"${PSQL[@]}" <<'SQL'
CREATE SCHEMA auth;
CREATE TABLE auth.users (id UUID PRIMARY KEY);

CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  nickname TEXT
);
CREATE TABLE public.posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users (id) ON DELETE CASCADE,
  like_count INT NOT NULL DEFAULT 0,
  comment_count INT NOT NULL DEFAULT 0
);
CREATE TABLE public.comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID NOT NULL REFERENCES public.posts (id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users (id) ON DELETE CASCADE
);
CREATE TABLE public.likes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID NOT NULL REFERENCES public.posts (id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users (id) ON DELETE CASCADE
);
-- 20260727_auth_user_delete_cascades.sql 계약: DM 은 보존 + 익명화(SET NULL)
CREATE TABLE public.dm_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user1_id UUID REFERENCES auth.users (id) ON DELETE SET NULL,
  user2_id UUID REFERENCES auth.users (id) ON DELETE SET NULL
);
CREATE TABLE public.dm_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES public.dm_conversations (id) ON DELETE CASCADE,
  sender_id UUID REFERENCES auth.users (id) ON DELETE SET NULL,
  content TEXT
);

-- 취약(현재 production) 함수 정의: src/lib/supabase/functions.sql 과 동일
CREATE OR REPLACE FUNCTION update_like_count()
RETURNS TRIGGER AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE posts SET like_count = like_count + 1 WHERE id = NEW.post_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE posts SET like_count = like_count - 1 WHERE id = OLD.post_id;
    RETURN OLD;
  END IF;
END;
$fn$ LANGUAGE plpgsql SECURITY DEFINER;
CREATE TRIGGER on_like_change AFTER INSERT OR DELETE ON public.likes
  FOR EACH ROW EXECUTE FUNCTION update_like_count();

CREATE OR REPLACE FUNCTION update_comment_count()
RETURNS TRIGGER AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE posts SET comment_count = comment_count + 1 WHERE id = NEW.post_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE posts SET comment_count = comment_count - 1 WHERE id = OLD.post_id;
    RETURN OLD;
  END IF;
END;
$fn$ LANGUAGE plpgsql SECURITY DEFINER;
CREATE TRIGGER on_comment_change AFTER INSERT OR DELETE ON public.comments
  FOR EACH ROW EXECUTE FUNCTION update_comment_count();
SQL

seed() {
  "${PSQL[@]}" <<'SQL'
TRUNCATE auth.users, public.profiles, public.posts, public.comments, public.likes,
         public.dm_conversations, public.dm_messages CASCADE;
INSERT INTO auth.users VALUES
  ('00000000-0000-0000-0000-000000000001'),  -- 탈퇴 유저
  ('00000000-0000-0000-0000-000000000002');  -- 상대(생존) 유저
INSERT INTO public.profiles VALUES
  ('00000000-0000-0000-0000-000000000001', 'leaver'),
  ('00000000-0000-0000-0000-000000000002', 'stayer');
-- 생존 유저의 글에 탈퇴 유저가 댓글 2 + 좋아요 1 (트리거 경유로 카운트 적재)
INSERT INTO public.posts (id, user_id) VALUES
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002');
INSERT INTO public.comments (post_id, user_id)
  SELECT '10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001' FROM generate_series(1,2);
INSERT INTO public.comments (post_id, user_id) VALUES
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002');
INSERT INTO public.likes (post_id, user_id) VALUES
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001'),
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002');
-- DM 대화 (탈퇴 유저 ↔ 생존 유저)
INSERT INTO public.dm_conversations (id, user1_id, user2_id) VALUES
  ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002');
INSERT INTO public.dm_messages (conversation_id, sender_id, content) VALUES
  ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'hi from leaver'),
  ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'hi from stayer');
SQL
}

# GoTrue(auth admin) 세션 재현: search_path 에 public 없음
DELETE_AS_AUTH_ADMIN="SET search_path = auth; DELETE FROM auth.users WHERE id = '00000000-0000-0000-0000-000000000001';"

echo "[사전 정합] 트리거 경유 카운트 적재"
seed
check "comment_count=3" "$("${PSQL[@]}" -c "SELECT comment_count FROM public.posts WHERE id='10000000-0000-0000-0000-000000000001'")" "3"
check "like_count=2" "$("${PSQL[@]}" -c "SELECT like_count FROM public.posts WHERE id='10000000-0000-0000-0000-000000000001'")" "2"

echo "[RED] search_path=auth 세션에서 탈퇴 유저 삭제 → 42P01 재현"
set +e
RED_ERR=$("${PSQL[@]}" -c "$DELETE_AS_AUTH_ADMIN" 2>&1)
RED_RC=$?
set -e
check "삭제 실패(비정상 종료)" "$([ $RED_RC -ne 0 ] && echo fail)" "fail"
check "42P01 relation posts" "$(echo "$RED_ERR" | grep -c 'relation "posts" does not exist')" "1"
check "유저 잔존(롤백)" "$("${PSQL[@]}" -c "SELECT count(*) FROM auth.users WHERE id='00000000-0000-0000-0000-000000000001'")" "1"

echo "[GREEN] 20260730 migration 적용 후 동일 시나리오"
"${PSQL[@]}" -f "$MIGRATION" >/dev/null
"${PSQL[@]}" -c "$DELETE_AS_AUTH_ADMIN"
check "auth user 삭제" "$("${PSQL[@]}" -c "SELECT count(*) FROM auth.users WHERE id='00000000-0000-0000-0000-000000000001'")" "0"
check "profile cascade 삭제" "$("${PSQL[@]}" -c "SELECT count(*) FROM public.profiles WHERE id='00000000-0000-0000-0000-000000000001'")" "0"
check "탈퇴 유저 comments cascade" "$("${PSQL[@]}" -c "SELECT count(*) FROM public.comments WHERE user_id='00000000-0000-0000-0000-000000000001'")" "0"
check "탈퇴 유저 likes cascade" "$("${PSQL[@]}" -c "SELECT count(*) FROM public.likes WHERE user_id='00000000-0000-0000-0000-000000000001'")" "0"
check "생존 유저 댓글 보존" "$("${PSQL[@]}" -c "SELECT count(*) FROM public.comments")" "1"
check "comment_count 정합(3→1)" "$("${PSQL[@]}" -c "SELECT comment_count FROM public.posts WHERE id='10000000-0000-0000-0000-000000000001'")" "1"
check "like_count 정합(2→1)" "$("${PSQL[@]}" -c "SELECT like_count FROM public.posts WHERE id='10000000-0000-0000-0000-000000000001'")" "1"
check "DM 대화 보존" "$("${PSQL[@]}" -c "SELECT count(*) FROM public.dm_conversations WHERE id='20000000-0000-0000-0000-000000000001'")" "1"
check "DM 메시지 보존(2건)" "$("${PSQL[@]}" -c "SELECT count(*) FROM public.dm_messages")" "2"
check "탈퇴 유저 sender 익명화" "$("${PSQL[@]}" -c "SELECT count(*) FROM public.dm_messages WHERE sender_id IS NULL")" "1"
check "대화 participant 익명화" "$("${PSQL[@]}" -c "SELECT (user1_id IS NULL) FROM public.dm_conversations WHERE id='20000000-0000-0000-0000-000000000001'")" "t"

echo "[functiondef] search_path 고정 + public. 한정 확인"
for fn in update_comment_count update_like_count; do
  DEF="$("${PSQL[@]}" -c "SELECT pg_get_functiondef('public.$fn()'::regprocedure)")"
  check "$fn: SET search_path" "$(echo "$DEF" | grep -c "SET search_path TO 'public', 'pg_temp'")" "1"
  check "$fn: public.posts 한정" "$(echo "$DEF" | grep -c 'UPDATE public.posts')" "2"
done

echo "[bootstrap 정합] src/lib/supabase/functions.sql 이 migration 과 동일하게 안전"
# 재설치/수동 적용 시 취약 정의 재유입 방지: bootstrap 파일도 search_path 고정 +
# public. qualified 여야 한다. functions.sql 을 임시 스키마에 로드해 catalog 로 검사.
BOOT="$ROOT/src/lib/supabase/functions.sql"
check "functions.sql 존재" "$([ -f "$BOOT" ] && echo ok)" "ok"
# functions.sql 은 tail 에서 publication ALTER / 다른 트리거를 참조하므로, 두 함수
# 정의 블록만 뽑아 clean DB 에 적용해 pg_get_functiondef 로 정합 판정.
awk '/CREATE OR REPLACE FUNCTION update_(like|comment)_count\(\)/{c=1} c{print} /LANGUAGE plpgsql SECURITY DEFINER/{if(c){print ";"; c=0}}' "$BOOT" > "$WORK/boot_fns.sql"
"${PSQL[@]}" <<'SQL'
CREATE SCHEMA IF NOT EXISTS boot;
SQL
# posts 는 이미 public 에 존재. 함수를 boot 스키마 아래로 재로드하지 않고 public 재정의
# (migration 과 동일 시그니처) 후 catalog 검사 — 정의가 정합이면 GREEN 상태 그대로 유지.
"${PSQL[@]}" -f "$WORK/boot_fns.sql" >/dev/null
for fn in update_comment_count update_like_count; do
  BDEF="$("${PSQL[@]}" -c "SELECT pg_get_functiondef('public.$fn()'::regprocedure)")"
  check "boot $fn: SET search_path" "$(echo "$BDEF" | grep -c "SET search_path TO 'public', 'pg_temp'")" "1"
  check "boot $fn: unqualified posts 없음" "$(echo "$BDEF" | grep -Ec 'UPDATE[[:space:]]+posts[[:space:]]')" "0"
  check "boot $fn: public.posts 한정" "$(echo "$BDEF" | grep -c 'UPDATE public.posts')" "2"
done
# bootstrap 재적용 후에도 auth-admin 세션 삭제가 여전히 성공하는지 재확인
seed
"${PSQL[@]}" -c "$DELETE_AS_AUTH_ADMIN"
check "boot 정의로도 탈퇴 성공" "$("${PSQL[@]}" -c "SELECT count(*) FROM auth.users WHERE id='00000000-0000-0000-0000-000000000001'")" "0"

echo
echo "PASS=$pass FAIL=$fail"
[ "$fail" -eq 0 ]
