-- Runs after the exclusive-badge migration inside a caller-owned transaction.
-- The runner always ROLLBACKs, so test rows and policy DDL never persist.
DO $$
DECLARE
  test_user_id uuid;
  ordinary_badge_id text;
BEGIN
  SELECT p.id, candidate.badge_id
    INTO test_user_id, ordinary_badge_id
  FROM public.profiles p
  CROSS JOIN (
    VALUES ('debut'), ('writer-1'), ('popular-1'), ('inviter-1')
  ) AS candidate(badge_id)
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.user_badges ub
    WHERE ub.user_id = p.id
      AND ub.badge_id = candidate.badge_id
  )
    AND NOT EXISTS (
      SELECT 1
      FROM public.user_badges ub
      WHERE ub.user_id = p.id
        AND ub.badge_id IN ('chairman', 'chairman-spouse')
    )
  LIMIT 1;

  ASSERT test_user_id IS NOT NULL, 'no profile available for exclusive badge RLS regression';
  PERFORM set_config('test.exclusive_badge_user_id', test_user_id::text, true);
  PERFORM set_config('test.ordinary_badge_id', ordinary_badge_id, true);
END $$;

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claim.sub',
  current_setting('test.exclusive_badge_user_id'),
  true
);

DO $$
DECLARE
  test_user_id uuid := current_setting('test.exclusive_badge_user_id')::uuid;
  ordinary_badge_id text := current_setting('test.ordinary_badge_id');
  rejected boolean;
BEGIN
  ASSERT auth.uid() = test_user_id, 'authenticated test identity was not installed';

  rejected := false;
  BEGIN
    INSERT INTO public.user_badges (user_id, badge_id)
    VALUES (test_user_id, 'chairman');
  EXCEPTION WHEN insufficient_privilege THEN
    rejected := true;
  END;
  ASSERT rejected, 'authenticated user self-awarded chairman';

  rejected := false;
  BEGIN
    INSERT INTO public.user_badges (user_id, badge_id)
    VALUES (test_user_id, 'chairman-spouse');
  EXCEPTION WHEN insufficient_privilege THEN
    rejected := true;
  END;
  ASSERT rejected, 'authenticated user self-awarded chairman-spouse';

  rejected := false;
  BEGIN
    INSERT INTO public.user_badges (user_id, badge_id)
    VALUES (test_user_id, ordinary_badge_id);
  EXCEPTION WHEN insufficient_privilege THEN
    rejected := true;
  END;
  ASSERT rejected, 'authenticated user directly inserted an ordinary badge';
END $$;

RESET ROLE;
SET LOCAL ROLE service_role;

DO $$
DECLARE
  test_user_id uuid := current_setting('test.exclusive_badge_user_id')::uuid;
BEGIN
  INSERT INTO public.user_badges (user_id, badge_id) VALUES
    (test_user_id, 'chairman'),
    (test_user_id, 'chairman-spouse'),
    (test_user_id, current_setting('test.ordinary_badge_id'));

  ASSERT (
    SELECT count(*) FROM public.user_badges
    WHERE user_id = test_user_id
      AND badge_id IN ('chairman', 'chairman-spouse')
  ) = 2, 'service role could not grant both exclusive badges';
  ASSERT EXISTS (
    SELECT 1 FROM public.user_badges
    WHERE user_id = test_user_id
      AND badge_id = current_setting('test.ordinary_badge_id')
  ), 'service-role ordinary badge path regressed';
END $$;

RESET ROLE;
