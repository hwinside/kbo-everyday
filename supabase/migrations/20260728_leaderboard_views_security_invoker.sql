-- 리더보드 뷰 SECURITY DEFINER → security_invoker 전환
-- (Supabase Security Advisor CRITICAL 3건 해소: "Security Definer View")
--
-- 배경(2026-07-28):
--   v_leaderboard_writing / v_leaderboard_writing_monthly / v_leaderboard_invite 이
--   owner(postgres) 권한으로 실행되어 조회자의 RLS 를 우회 → Advisor CRITICAL.
--   프로젝트 전체 스캔 결과 대상은 정확히 이 3개 뷰뿐.
--
-- 목표: 세 뷰를 security_invoker=on 으로 전환하되 *공개 리더보드 동작/노출 데이터 불변*.
--
-- 안전 설계(라이브 RLS 실측 기반):
--   * monthly — 소스(chat_messages/comments/posts/profiles) 전부 공개 SELECT USING(true)
--     + leaderboard_internal_user_ids() 는 anon/authenticated EXECUTE 가능 → 플립만.
--   * writing — leaderboard_writing_rollup(RLS on, 공개정책 0)에 공개 SELECT 정책 추가
--     (집계 컬럼 user_id/점수/날짜만, 뷰가 이미 공개하던 데이터라 신규 노출 0) + 플립.
--   * invite — invitations RLS="본인 초대만"(inviter/invitee) → invoker 로 뒤집으면 집계가
--     붕괴하고 원본 초대관계가 노출됨. writing 과 동일하게 *공개 집계 rollup*
--     (leaderboard_invite_rollup) 신설 → 그 위 security_invoker 뷰. 원본 invitations 는
--     계속 잠금 유지. 내부자 제외는 뷰 read 시점 적용(동적, 함수 교체 즉시 반영 유지).
--
-- 파리티 검증(prod read-only, 2026-07-28): 제안 rollup 집계 결과가 현행 v_leaderboard_invite
--   와 완전 동일(12행, 양방향 except 0).

BEGIN;

-- ============================================================
-- 1. monthly — 소스 전부 공개, 플립만
-- ============================================================
ALTER VIEW public.v_leaderboard_writing_monthly SET (security_invoker = on);

-- ============================================================
-- 2. writing — rollup 공개 read 정책 + 플립
-- ============================================================
-- rollup 은 user_id / 합산점수 / 마지막활동일만 보유(민감정보 없음).
-- 뷰가 이미 SELECT r.user_id 로 공개하던 집계라 정책 추가로 인한 신규 노출 0.
DROP POLICY IF EXISTS leaderboard_writing_rollup_public_read ON public.leaderboard_writing_rollup;
CREATE POLICY leaderboard_writing_rollup_public_read
  ON public.leaderboard_writing_rollup
  FOR SELECT TO anon, authenticated
  USING (true);
-- RLS 정책 + 테이블 GRANT 둘 다 필요(정책만으론 anon 권한 부족). 명시 GRANT 로
-- Supabase 암묵 default privilege 에 의존하지 않고 보안 계약을 자립적으로 고정.
GRANT SELECT ON public.leaderboard_writing_rollup TO anon, authenticated;

ALTER VIEW public.v_leaderboard_writing SET (security_invoker = on);

-- ============================================================
-- 3. invite — 공개 집계 rollup 신설 + security_invoker 뷰
-- ============================================================
CREATE TABLE IF NOT EXISTS public.leaderboard_invite_rollup (
  user_id           uuid PRIMARY KEY,
  invite_count      integer NOT NULL CHECK (invite_count >= 0),
  last_activated_at timestamptz,
  refreshed_at      timestamptz NOT NULL DEFAULT now()
);

-- 직접 접근 차단 (읽기는 v_leaderboard_invite 뷰 경유, 갱신은 service_role RPC 경유).
-- 공개 read 정책은 집계 컬럼만 노출 — 원본 invitations(inviter/invitee 관계)는 노출 아님.
ALTER TABLE public.leaderboard_invite_rollup ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS leaderboard_invite_rollup_public_read ON public.leaderboard_invite_rollup;
CREATE POLICY leaderboard_invite_rollup_public_read
  ON public.leaderboard_invite_rollup
  FOR SELECT TO anon, authenticated
  USING (true);
-- RLS 정책 + 테이블 GRANT 둘 다 필요(정책만으론 anon 권한 부족).
GRANT SELECT ON public.leaderboard_invite_rollup TO anon, authenticated;

-- 갱신 함수 — service_role 전용, idempotent, advisory try-lock
-- (writing rollup 패턴 동일: 중복/수동 refresh 겹침 시 DELETE+INSERT PK 충돌 차단)
CREATE OR REPLACE FUNCTION public.leaderboard_invite_rollup_refresh()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('leaderboard_invite_rollup_refresh')) THEN
    RETURN 'skipped_lock_busy';
  END IF;

  -- 단일 트랜잭션 내 스냅샷 교체 — 리더는 커밋 전까지 이전 스냅샷 조회.
  -- 내부자 제외는 여기서 적용하지 않음(뷰 read 시점 <> ALL 로 동적 적용).
  -- public-qualified + 명시 WHERE TRUE — writing rollup(20260727_rpc_error_fixes) 동일 패턴
  -- (#890 safe-update 400 재도입 방지).
  DELETE FROM public.leaderboard_invite_rollup WHERE TRUE;

  INSERT INTO leaderboard_invite_rollup (user_id, invite_count, last_activated_at)
  SELECT
    inv.inviter_id,
    COUNT(*)::int,
    MAX(inv.activated_at)
  FROM invitations inv
  WHERE inv.activated_at IS NOT NULL
    AND (inv.flagged IS NULL OR inv.flagged = FALSE)
    AND inv.inviter_id IS NOT NULL
  GROUP BY inv.inviter_id;

  RETURN 'refreshed';
END;
$$;

REVOKE EXECUTE ON FUNCTION public.leaderboard_invite_rollup_refresh()
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.leaderboard_invite_rollup_refresh() TO service_role;

-- 최초 1회 채우기(뷰 전환 전에 rollup 이 비어있지 않도록)
SELECT public.leaderboard_invite_rollup_refresh();

-- 뷰 재정의 — rollup 읽기 + 내부자 제외 read 시점 적용.
-- invite_count 타입이 bigint(count) → integer(rollup) 로 바뀌므로 CREATE OR REPLACE 불가 → DROP 후 재생성.
-- (DB 의존 객체 없음: API 는 런타임 이름 참조. 예기치 않은 의존 시 CASCADE 없이 실패하도록 둔다.)
DROP VIEW IF EXISTS public.v_leaderboard_invite;
CREATE VIEW public.v_leaderboard_invite
WITH (security_invoker = on) AS
SELECT
  r.user_id,
  p.nickname,
  p.team_id,
  r.invite_count,
  r.last_activated_at
FROM leaderboard_invite_rollup r
JOIN profiles p ON p.id = r.user_id
WHERE r.user_id <> ALL (leaderboard_internal_user_ids())
ORDER BY r.invite_count DESC, r.last_activated_at ASC;

GRANT SELECT ON public.v_leaderboard_invite TO anon, authenticated;

COMMIT;
