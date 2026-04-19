-- 2026-04-19 닉네임 중복 정리 + UNIQUE constraint 추가
-- 작성: 삼식이 / 리뷰: 삼순이 (조건부 GO) / 승인 대기: 하린아빠
--
-- 배경:
--   - 현재 public.profiles에 nickname UNIQUE constraint 부재
--   - 4개 닉네임 8명 중복: 무적LG×4, 정현준×2, 최강기아×2
--   - /api/setup의 23505 가드는 unique constraint 부재로 영원히 안 잡힘 (검증 안 된 dead code)
--   - WAU 25K, 가입자/일 100+ 시점에 식별 신뢰 이슈는 즉시 닫아야 함
--
-- 정책 (삼순이 추천안):
--   1. 가장 먼저 가입한 1명만 원본 닉네임 유지
--   2. 나머지는 임시로 `닉네임_2`, `닉네임_3` ... suffix 부여
--   3. 마이페이지 진입 시 변경 유도는 별도 작업
--   4. exact-match UNIQUE constraint 추가 (대소문자 무시는 한국어 서비스 우선순위 낮음)
--
-- 안전:
--   - BEGIN/COMMIT 트랜잭션
--   - SELECT 사전 확인 가능
--   - 8명만 영향, 다른 row 무영향
--   - profile_nickname_changes 테이블에 변경 이력 기록

BEGIN;

-- 1. 변경 대상 미리 확인 (DRY RUN)
SELECT
  p.nickname AS old_nickname,
  p.nickname || '_' || ROW_NUMBER() OVER (PARTITION BY p.nickname ORDER BY p.joined_at ASC) AS new_nickname,
  p.id,
  p.joined_at
FROM public.profiles p
WHERE p.nickname IN ('무적LG', '정현준', '최강기아')
ORDER BY p.nickname, p.joined_at ASC;

-- 2. 후순위 가입자 닉네임에 suffix 부여
--    가장 먼저 가입한 1명(rank=1)은 원본 유지 → UPDATE 제외
WITH ranked AS (
  SELECT
    p.id,
    p.nickname,
    ROW_NUMBER() OVER (PARTITION BY p.nickname ORDER BY p.joined_at ASC) AS rn
  FROM public.profiles p
  WHERE p.nickname IN ('무적LG', '정현준', '최강기아')
)
UPDATE public.profiles
SET
  nickname = ranked.nickname || '_' || ranked.rn,
  updated_at = NOW()
FROM ranked
WHERE public.profiles.id = ranked.id
  AND ranked.rn > 1;

-- 3. 변경 이력 기록 (profile_nickname_changes)
INSERT INTO public.profile_nickname_changes (user_id, old_nickname, new_nickname, changed_at)
SELECT
  p.id,
  ranked.original_nickname,
  p.nickname,
  NOW()
FROM public.profiles p
JOIN (
  SELECT
    id,
    nickname AS original_nickname,
    ROW_NUMBER() OVER (PARTITION BY nickname ORDER BY joined_at ASC) AS rn
  FROM public.profiles
  WHERE nickname IN ('무적LG', '정현준', '최강기아')
) ranked ON ranked.id = p.id
WHERE ranked.rn > 1;

-- 4. UNIQUE constraint 추가 (exact-match)
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_nickname_unique UNIQUE (nickname);

-- 5. 사후 검증
SELECT nickname, COUNT(*) AS cnt
FROM public.profiles
WHERE nickname IS NOT NULL
GROUP BY nickname
HAVING COUNT(*) > 1;
-- 기대: 0행

COMMIT;
