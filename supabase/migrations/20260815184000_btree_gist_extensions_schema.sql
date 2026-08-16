-- btree_gist 설치 위치 정본화: extensions 스키마 (삼순 #1202 P1 — repo↔Production drift 봉합).
--
-- 경위: 20260815173000 은 `CREATE EXTENSION IF NOT EXISTS btree_gist;` 로 **public** 에
--   설치한다. Production 적용 시에는 advisor `extension_in_public` 경고 재발을 피하려
--   수동으로 `WITH SCHEMA extensions` 를 붙여 적용했다 — 그 결과 repo 정본(public)과
--   Production(extensions)이 갈라졌고, 새로 부트스트랩하는 환경은 public 에 설치돼
--   경고가 재발한다. 이 migration 이 위치를 extensions 로 **정본화**한다.
--
-- 원본 파일을 고치지 않는 이유: 20260815173000 은 이미 Production 에 적용된 version 이라
--   내용을 바꿔도 재실행되지 않는다(적용 순서가 곧 상태인 migration 의 정합성 규칙).
--
-- 멱등성: 미설치 → extensions 에 설치 / public 등 다른 스키마 → extensions 로 이동 /
--   이미 extensions → no-op. 어떤 상태에서 재실행해도 같은 종착지다.
--   ALTER EXTENSION ... SET SCHEMA 는 확장이 소유한 객체(gist opclass 등)를 함께 옮기며,
--   EXCLUDE 제약(genius_motion_grants_cooldown_excl)은 opclass 를 oid 로 참조하므로
--   스키마 이동에 영향받지 않는다.

DO $$
DECLARE
  v_schema text;
BEGIN
  SELECT n.nspname INTO v_schema
  FROM pg_extension e
  JOIN pg_namespace n ON n.oid = e.extnamespace
  WHERE e.extname = 'btree_gist';

  IF v_schema IS NULL THEN
    -- 로컬/PGlite 등 extensions 스키마가 없는 환경도 있으므로 먼저 보장한다.
    EXECUTE 'CREATE SCHEMA IF NOT EXISTS extensions';
    EXECUTE 'CREATE EXTENSION btree_gist WITH SCHEMA extensions';
  ELSIF v_schema <> 'extensions' THEN
    EXECUTE 'CREATE SCHEMA IF NOT EXISTS extensions';
    EXECUTE 'ALTER EXTENSION btree_gist SET SCHEMA extensions';
  END IF;
END;
$$;
