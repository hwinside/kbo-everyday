-- Fix two RPCs that were returning a 400 on every production invocation.

-- Supabase's safe-update guard rejects DELETE without a WHERE clause, including
-- inside SECURITY DEFINER functions. Keep the full snapshot replacement but
-- make the intentional all-row delete explicit.
CREATE OR REPLACE FUNCTION public.leaderboard_writing_rollup_refresh()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('leaderboard_writing_rollup_refresh')) THEN
    RETURN 'skipped_lock_busy';
  END IF;

  DELETE FROM public.leaderboard_writing_rollup WHERE TRUE;

  INSERT INTO public.leaderboard_writing_rollup (user_id, total_points, last_active_day)
  WITH
    chat_daily AS (
      SELECT
        user_id,
        (created_at AT TIME ZONE 'Asia/Seoul')::date AS day,
        LEAST(COUNT(*), 30) AS pts
      FROM public.chat_messages
      WHERE user_id IS NOT NULL
      GROUP BY user_id, day
    ),
    comment_daily AS (
      SELECT
        author_id AS user_id,
        (created_at AT TIME ZONE 'Asia/Seoul')::date AS day,
        LEAST(COUNT(*) * 2, 40) AS pts
      FROM public.comments
      WHERE is_hidden = FALSE
        AND author_id IS NOT NULL
      GROUP BY author_id, day
    ),
    post_general_daily AS (
      SELECT
        author_id AS user_id,
        (created_at AT TIME ZONE 'Asia/Seoul')::date AS day,
        LEAST(COUNT(*) * 3, 30) AS pts
      FROM public.posts
      WHERE is_hidden = FALSE
        AND (content_type IS NULL OR content_type <> 'photo')
        AND author_id IS NOT NULL
      GROUP BY author_id, day
    ),
    post_photo_daily AS (
      SELECT
        author_id AS user_id,
        (created_at AT TIME ZONE 'Asia/Seoul')::date AS day,
        LEAST(COUNT(*) * 5, 50) AS pts
      FROM public.posts
      WHERE is_hidden = FALSE
        AND content_type = 'photo'
        AND author_id IS NOT NULL
      GROUP BY author_id, day
    ),
    stadium_seat_tip_bonus_daily AS (
      SELECT
        author_id AS user_id,
        (created_at AT TIME ZONE 'Asia/Seoul')::date AS day,
        LEAST(COUNT(*) * 10, 20) AS pts
      FROM public.posts
      WHERE is_hidden = FALSE
        AND board_type = 'stadium'
        AND board_id LIKE 'stadium:%:seats'
        AND author_id IS NOT NULL
      GROUP BY author_id, day
    ),
    ticket_transfer_bonus_daily AS (
      SELECT
        author_id AS user_id,
        (created_at AT TIME ZONE 'Asia/Seoul')::date AS day,
        LEAST(COUNT(*) * 30, 30) AS pts
      FROM public.ticket_transfers
      WHERE author_id IS NOT NULL
      GROUP BY author_id, day
    ),
    all_daily AS (
      SELECT user_id, day, pts FROM chat_daily
      UNION ALL SELECT user_id, day, pts FROM comment_daily
      UNION ALL SELECT user_id, day, pts FROM post_general_daily
      UNION ALL SELECT user_id, day, pts FROM post_photo_daily
      UNION ALL SELECT user_id, day, pts FROM stadium_seat_tip_bonus_daily
      UNION ALL SELECT user_id, day, pts FROM ticket_transfer_bonus_daily
    ),
    capped_daily AS (
      SELECT user_id, day, LEAST(SUM(pts), 200) AS day_pts
      FROM all_daily
      GROUP BY user_id, day
    )
  SELECT
    user_id,
    SUM(day_pts)::int AS total_points,
    MAX(day) AS last_active_day
  FROM capped_daily
  GROUP BY user_id;

  RETURN 'refreshed';
END;
$$;

REVOKE EXECUTE ON FUNCTION public.leaderboard_writing_rollup_refresh()
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.leaderboard_writing_rollup_refresh() TO service_role;

-- auth.identities.email became a generated column. Supplying it explicitly now
-- raises 428C9, so let Postgres generate both id and normalized email.
CREATE OR REPLACE FUNCTION public.upsert_naver_identity(
  p_user_id uuid,
  p_provider_id text,
  p_identity_data jsonb,
  p_created_at timestamptz DEFAULT now()
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM auth.identities
    WHERE provider = 'naver'
      AND provider_id = p_provider_id
  ) THEN
    UPDATE auth.identities
    SET identity_data = p_identity_data,
        updated_at = now(),
        last_sign_in_at = now()
    WHERE provider = 'naver'
      AND provider_id = p_provider_id;
  ELSE
    INSERT INTO auth.identities (
      user_id,
      identity_data,
      provider,
      provider_id,
      last_sign_in_at,
      created_at,
      updated_at
    ) VALUES (
      p_user_id,
      p_identity_data,
      'naver',
      p_provider_id,
      p_created_at,
      p_created_at,
      now()
    );
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_naver_identity(uuid, text, jsonb, timestamptz)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_naver_identity(uuid, text, jsonb, timestamptz)
  TO service_role;
