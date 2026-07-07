-- Engaged User 일별 추이: 글/댓글/크관 채팅(사진 글 포함) 중 하나 이상 "작성"한
-- 유저 수. 좋아요는 작성이 아니므로 제외. 전 기간을 DB에서 집계해야 하므로
-- (누적 토글) row 페이지네이션 대신 RPC 한 방으로 내린다.
--   engaged        = 그날 1건 이상 작성한 distinct 유저 수 (일별 막대)
--   first_engaged  = 첫 작성이 그날인 유저 수 (누적 곡선 = running sum,
--                    일별 distinct 합산의 중복 계상을 피한다)
-- service_role 전용, 어드민 PIN 게이트 뒤에서만 호출.
CREATE OR REPLACE FUNCTION admin_engaged_users_daily()
RETURNS TABLE(day date, engaged bigint, first_engaged bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH events AS (
    -- 새소식 댓글용 브리지 포스트 제외 (/api/admin/content와 동일 기준,
    -- board_type은 NOT NULL이라 <> 비교 안전)
    SELECT author_id AS user_id,
           (created_at AT TIME ZONE 'Asia/Seoul')::date AS day
    FROM posts
    WHERE author_id IS NOT NULL
      AND board_type <> 'announcement'
    UNION ALL
    SELECT author_id, (created_at AT TIME ZONE 'Asia/Seoul')::date
    FROM comments
    WHERE author_id IS NOT NULL
    UNION ALL
    SELECT user_id, (created_at AT TIME ZONE 'Asia/Seoul')::date
    FROM chat_messages
    WHERE user_id IS NOT NULL
      AND room_id LIKE 'game:%'
  ),
  daily AS (
    SELECT events.day, count(DISTINCT user_id) AS engaged
    FROM events
    GROUP BY events.day
  ),
  firsts AS (
    SELECT min_day AS day, count(*) AS first_engaged
    FROM (SELECT user_id, min(events.day) AS min_day FROM events GROUP BY user_id) f
    GROUP BY min_day
  )
  SELECT d.day, d.engaged, COALESCE(fs.first_engaged, 0) AS first_engaged
  FROM daily d
  LEFT JOIN firsts fs ON fs.day = d.day
  ORDER BY d.day;
$$;

REVOKE EXECUTE ON FUNCTION admin_engaged_users_daily() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION admin_engaged_users_daily() TO service_role;
