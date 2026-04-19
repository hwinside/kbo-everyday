-- 2026-04-19 닉네임 중복 정리 + UNIQUE constraint 추가 (v2)
-- 작성: 삼식이 / 리뷰: 삼순이 / 승인 대기: 하린아빠
--
-- 배경:
--   - public.profiles에 nickname UNIQUE constraint 부재
--   - 현재 4개 닉네임 8명 중복: 무적LG×4, 정현준×2, 최강기아×2
--   - /api/setup의 23505 가드는 dead code (constraint 없으니 영원히 안 잡힘)
--   - WAU 25K, 가입자/일 100+ 시점에 식별 신뢰 즉시 차단 필요
--
-- v2 변경 (삼순이 NO-GO P0 2건 반영):
--   P0-1) UPDATE 전 snapshot을 임시 테이블로 고정 → 이력 insert 누락 방지
--   P0-2) 목표 suffix 닉이 전역에서 이미 사용 중이면 다음 N으로 자동 증가
--         (`무적LG_2`가 이미 있으면 `무적LG_3` 시도, 그것도 있으면 `_4` ...)
--
-- 정책 (삼순이 추천안):
--   1. 가장 먼저 가입한 1명만 원본 닉 유지
--   2. 나머지는 `닉네임_N` (전역에서 비어있는 가장 작은 N)
--   3. profile_nickname_changes 이력 기록
--   4. exact-match UNIQUE constraint 추가
--
-- 안전:
--   - BEGIN/COMMIT 트랜잭션
--   - 1단계 SELECT로 사전 dry-run 가능
--   - 트랜잭션 내 ON COMMIT DROP 임시 테이블 사용 → 충돌 위험 0
--   - constraint 추가 직전 사후 검증 → 위반 시 자동 ROLLBACK

BEGIN;

-- ========================================================================
-- 1단계: 변경 대상 snapshot을 임시 테이블에 고정
--        (UPDATE 후 원본 닉으로 재조회하면 missing → 이력 누락 P0 방지)
-- ========================================================================
CREATE TEMP TABLE nickname_cleanup_targets ON COMMIT DROP AS
WITH ranked AS (
  SELECT
    p.id,
    p.nickname AS original_nickname,
    p.joined_at,
    ROW_NUMBER() OVER (PARTITION BY p.nickname ORDER BY p.joined_at ASC, p.id ASC) AS join_rank
  FROM public.profiles p
  WHERE p.nickname IN ('무적LG', '정현준', '최강기아')
)
SELECT
  id,
  original_nickname,
  joined_at,
  join_rank,
  -- target_nickname은 2단계에서 동적으로 채움
  NULL::text AS target_nickname
FROM ranked
WHERE join_rank > 1;  -- rank=1(원본 유지)는 제외

-- 1.5단계: 사전 검증 — 변경 대상 확인
SELECT 'BEFORE' AS phase, original_nickname, COUNT(*) AS to_change
FROM nickname_cleanup_targets
GROUP BY original_nickname
ORDER BY original_nickname;
-- 기대: 무적LG=3, 정현준=1, 최강기아=1

-- ========================================================================
-- 2단계: 각 row마다 전역에서 비어있는 가장 작은 N을 찾아 target_nickname 결정
--        candidate가 (a) profiles 전역에 있거나 (b) 다른 cleanup row가 이미 점유했으면 다음 N 시도
-- ========================================================================
DO $$
DECLARE
  rec RECORD;
  candidate_n INT;
  candidate_nick TEXT;
BEGIN
  FOR rec IN
    SELECT id, original_nickname, join_rank
    FROM nickname_cleanup_targets
    ORDER BY original_nickname, join_rank ASC
  LOOP
    candidate_n := rec.join_rank;  -- 시작값: 가입순서 (2,3,4)

    LOOP
      candidate_nick := rec.original_nickname || '_' || candidate_n;

      -- (a) profiles 전역 충돌 확인 (단, 자기 자신은 제외)
      IF EXISTS (
        SELECT 1 FROM public.profiles
        WHERE nickname = candidate_nick AND id <> rec.id
      ) THEN
        candidate_n := candidate_n + 1;
        CONTINUE;
      END IF;

      -- (b) 다른 cleanup target이 이미 같은 candidate 잡았는지 확인
      IF EXISTS (
        SELECT 1 FROM nickname_cleanup_targets
        WHERE target_nickname = candidate_nick
      ) THEN
        candidate_n := candidate_n + 1;
        CONTINUE;
      END IF;

      EXIT;  -- 안전한 candidate 발견
    END LOOP;

    UPDATE nickname_cleanup_targets
    SET target_nickname = candidate_nick
    WHERE id = rec.id;
  END LOOP;
END $$;

-- 2.5단계: 결정된 매핑 확인
SELECT 'MAPPING' AS phase, original_nickname, target_nickname, id, joined_at
FROM nickname_cleanup_targets
ORDER BY original_nickname, joined_at;

-- ========================================================================
-- 3단계: profiles UPDATE (snapshot 기준)
-- ========================================================================
UPDATE public.profiles p
SET
  nickname = t.target_nickname,
  updated_at = NOW()
FROM nickname_cleanup_targets t
WHERE p.id = t.id;

-- ========================================================================
-- 4단계: 변경 이력 기록 (snapshot 기준 → 누락 0)
-- ========================================================================
INSERT INTO public.profile_nickname_changes (user_id, old_nickname, new_nickname, changed_at)
SELECT id, original_nickname, target_nickname, NOW()
FROM nickname_cleanup_targets;

-- ========================================================================
-- 5단계: 사후 검증 — 중복 0건 확인 (위반 시 ERROR + 자동 ROLLBACK)
-- ========================================================================
DO $$
DECLARE
  dup_count INT;
BEGIN
  SELECT COUNT(*)
  INTO dup_count
  FROM (
    SELECT nickname
    FROM public.profiles
    WHERE nickname IS NOT NULL
    GROUP BY nickname
    HAVING COUNT(*) > 1
  ) sub;

  IF dup_count > 0 THEN
    RAISE EXCEPTION '중복 닉네임 % 건 잔존 — 마이그레이션 중단', dup_count;
  END IF;
END $$;

-- ========================================================================
-- 6단계: UNIQUE constraint 추가 (exact-match)
-- ========================================================================
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_nickname_unique UNIQUE (nickname);

-- 6.5단계: 최종 확인
SELECT 'AFTER' AS phase, COUNT(*) AS total_profiles,
       COUNT(DISTINCT nickname) AS unique_nicknames
FROM public.profiles
WHERE nickname IS NOT NULL;
-- 기대: total = unique

COMMIT;
