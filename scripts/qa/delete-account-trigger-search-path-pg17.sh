#!/usr/bin/env bash
# 계정삭제 실패 P0 회귀 (feedback:0563cc52, 2026-07-30)
#
# 근본원인 재현: count 트리거 함수(update_comment_count 등)가 SECURITY DEFINER인데
# SET search_path 미설정 → GoTrue(supabase_auth_admin) 세션(search_path에 public 없음)에서
# auth.users 삭제 → comments cascade DELETE → 트리거의 unqualified `posts` 참조가
# `relation "posts" does not exist`로 실패 → 계정 삭제 전체 롤백.
#
# 시나리오 (임시 로컬 PG17, 실제 cascade 경로):
#   RED  : 프로덕션과 동일한 함수 정의(search_path 없음) + auth 유사 롤(search_path=auth)로
#          유저 삭제 → 반드시 실패해야 함 (재현 확인)
#   GREEN: 20260730 migration(ALTER FUNCTION ... SET search_path=public) 적용 후
#          동일 삭제 → 성공 + cascade 정리 + 남은 게시글 count 무결성 확인
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

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
MIGRATION="$REPO/supabase/migrations/20260730_fix_count_trigger_search_path.sql"
[ -f "$MIGRATION" ] || { echo "migration not found: $MIGRATION" >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/del-acct-qa.XXXXXX")"
DATADIR="$WORK/data"; SOCKDIR="$WORK/sock"; mkdir -p "$SOCKDIR"
cleanup() { "$PGBIN/pg_ctl" -D "$DATADIR" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATADIR" -A trust -U postgres >/dev/null
"$PGBIN/pg_ctl" -D "$DATADIR" -o "-k $SOCKDIR -c listen_addresses=''" -w start >/dev/null
PSQL=("$PGBIN/psql" -h "$SOCKDIR" -U postgres -d postgres -v ON_ERROR_STOP=1 -qAt)

fail() { echo "FAIL: $1" >&2; exit 1; }
PASS=0

# ── 스키마: 프로덕션 최소 재현 (auth.users → profiles/posts/comments/likes cascade) ──
"${PSQL[@]}" <<'SQL'
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE TABLE public.posts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  author_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  comment_count int NOT NULL DEFAULT 0,
  like_count int NOT NULL DEFAULT 0
);
CREATE TABLE public.comments (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  post_id bigint NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  author_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  like_count int NOT NULL DEFAULT 0
);
CREATE TABLE public.likes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  post_id bigint NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE
);

-- 프로덕션과 동일 정의 (pg_get_functiondef 스냅샷, search_path 미설정 = RED 전제)
CREATE OR REPLACE FUNCTION public.update_comment_count()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
AS $function$
BEGIN
IF TG_OP = 'INSERT' THEN
UPDATE posts SET comment_count = comment_count + 1 WHERE id = NEW.post_id;
RETURN NEW;
ELSIF TG_OP = 'DELETE' THEN
UPDATE posts SET comment_count = comment_count - 1 WHERE id = OLD.post_id;
RETURN OLD;
END IF;
END;
$function$;
CREATE OR REPLACE FUNCTION public.update_like_count()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
AS $function$
BEGIN
IF TG_OP = 'INSERT' THEN
UPDATE posts SET like_count = like_count + 1 WHERE id = NEW.post_id;
RETURN NEW;
ELSIF TG_OP = 'DELETE' THEN
UPDATE posts SET like_count = like_count - 1 WHERE id = OLD.post_id;
RETURN OLD;
END IF;
END;
$function$;
CREATE OR REPLACE FUNCTION public.update_comment_like_count()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE comments SET like_count = like_count + 1 WHERE id = NEW.comment_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE comments SET like_count = like_count - 1 WHERE id = OLD.comment_id;
    RETURN OLD;
  END IF;
END;
$function$;
CREATE TRIGGER on_comment_change AFTER INSERT OR DELETE ON public.comments
  FOR EACH ROW EXECUTE FUNCTION public.update_comment_count();
CREATE TRIGGER on_like_change AFTER INSERT OR DELETE ON public.likes
  FOR EACH ROW EXECUTE FUNCTION public.update_like_count();

-- GoTrue 유사 롤: auth 소유 아님이 중요한 게 아니라 search_path에 public이 없는 것이 재현 조건
CREATE ROLE auth_admin_sim LOGIN;
ALTER ROLE auth_admin_sim SET search_path = auth;
GRANT USAGE ON SCHEMA auth TO auth_admin_sim;
GRANT DELETE, SELECT ON auth.users TO auth_admin_sim;

-- 데이터: 삭제 대상 유저(u1)가 타인 게시글(p2)에 댓글/좋아요 보유 → cascade 시 트리거 발화
INSERT INTO auth.users VALUES ('11111111-1111-1111-1111-111111111111'), ('22222222-2222-2222-2222-222222222222');
INSERT INTO public.posts (author_id) VALUES ('11111111-1111-1111-1111-111111111111'), ('22222222-2222-2222-2222-222222222222');
INSERT INTO public.comments (post_id, author_id) SELECT id, '11111111-1111-1111-1111-111111111111' FROM public.posts WHERE author_id = '22222222-2222-2222-2222-222222222222';
INSERT INTO public.likes (post_id, user_id) SELECT id, '11111111-1111-1111-1111-111111111111' FROM public.posts WHERE author_id = '22222222-2222-2222-2222-222222222222';
SQL

# ── RED: search_path 미설정 상태에서 auth 세션 삭제 → 반드시 실패 ──
set +e
RED_OUT=$("$PGBIN/psql" -h "$SOCKDIR" -U auth_admin_sim -d postgres -qAt \
  -c "DELETE FROM auth.users WHERE id = '11111111-1111-1111-1111-111111111111'" 2>&1)
RED_RC=$?
set -e
[ "$RED_RC" -ne 0 ] || fail "RED: 삭제가 성공하면 재현 실패 (프로덕션 결함이 재현되어야 함)"
echo "$RED_OUT" | grep -q 'relation "posts" does not exist' || fail "RED: 기대 에러(relation posts does not exist)와 다름: $RED_OUT"
USERS_LEFT=$("${PSQL[@]}" -c "SELECT count(*) FROM auth.users")
[ "$USERS_LEFT" = "2" ] || fail "RED: 롤백돼야 하는데 users=$USERS_LEFT"
PASS=$((PASS+2)); echo "PASS RED: search_path 미설정 → 'relation posts does not exist'로 삭제 롤백 재현"

# ── GREEN: migration 적용 후 동일 삭제 → 성공 + cascade + count 무결성 ──
"${PSQL[@]}" -f "$MIGRATION" >/dev/null
"$PGBIN/psql" -h "$SOCKDIR" -U auth_admin_sim -d postgres -qAt -v ON_ERROR_STOP=1 \
  -c "DELETE FROM auth.users WHERE id = '11111111-1111-1111-1111-111111111111'" >/dev/null \
  || fail "GREEN: migration 적용 후에도 삭제 실패"
read -r USERS POSTS COMMENTS LIKES CC LC <<EOF2
$("${PSQL[@]}" -F' ' -c "SELECT (SELECT count(*) FROM auth.users), (SELECT count(*) FROM public.posts), (SELECT count(*) FROM public.comments), (SELECT count(*) FROM public.likes), (SELECT comment_count FROM public.posts LIMIT 1), (SELECT like_count FROM public.posts LIMIT 1)")
EOF2
[ "$USERS" = "1" ] || fail "GREEN: users=$USERS (기대 1)"
[ "$POSTS" = "1" ] || fail "GREEN: posts=$POSTS (기대 1 — 본인 글 cascade 삭제)"
[ "$COMMENTS" = "0" ] || fail "GREEN: comments=$COMMENTS (기대 0)"
[ "$LIKES" = "0" ] || fail "GREEN: likes=$LIKES (기대 0)"
[ "$CC" = "0" ] || fail "GREEN: 남은 게시글 comment_count=$CC (기대 0 — 트리거 감산 정상)"
[ "$LC" = "0" ] || fail "GREEN: 남은 게시글 like_count=$LC (기대 0 — 트리거 감산 정상)"
PASS=$((PASS+6)); echo "PASS GREEN: migration 후 삭제 성공 + cascade 정리 + count 무결성"

# ── 멱등성: migration 재적용 무해 ──
"${PSQL[@]}" -f "$MIGRATION" >/dev/null || fail "IDEMPOTENT: 재적용 실패"
PASS=$((PASS+1)); echo "PASS IDEMPOTENT: migration 재적용 무해"

echo "ALL PASS ($PASS assertions)"
