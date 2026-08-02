-- 직관 다이어리 통계 S1b — 팀 부스트 시즌 집계 RPC: CTE MATERIALIZED 강제.
--
-- 배경(2026-08-01 사고):
--   20260730_venue_stats_team_boost_rpc.sql 은 **이미 production 에 적용되어 있다**.
--   그 파일을 직접 고치면 표준 migration runner 가 재실행하지 않아 schema drift 가 된다
--   (삼순 P0). 그래서 원본은 그대로 두고 이 파일에서 CREATE OR REPLACE 로 덮어쓴다.
--
-- 무엇을 고치나:
--   PG12+ 는 단일 참조 CTE 를 기본 inline 한다. 이 함수는 verified/team_totals 가
--   ledger→game_actual(17k 행 string_agg + sha256)을 재참조하므로, inline 되면
--   hash 집계가 매 참조마다 재실행되어 경기 수에 초선형으로 터진다.
--
--   실측(운영 DB, 동일 우주):
--     n=10   90ms / n=100 519ms / n=200 1.9s / n=300 4.1s
--     n=491  ERROR 57014 canceling statement due to statement timeout
--     → 전 CTE MATERIALIZED 후 n=491 157ms
--   결과는 byte-exact 동일(n=1/10/97/200/300 md5 대조 확인). 로직·반환 형태 무변경.
--
--   증상: 직관 통계 B1(팀 타율)·B2(팀 ERA)·B4(홈런)가 상시 attendance_only
--         (`비교 데이터 준비 중`)로 막혔다.
--
-- ⚠️ MATERIALIZED 힌트를 제거하지 말 것.
--   회귀: scripts/qa/venue-stats-rpc-scale.ts (정적 계약 + 실 DB 예산 + 결과 일관성),
--         CI 결속은 venue-stats-s2-gate.
--
-- 멱등: CREATE OR REPLACE — 재실행 안전. 권한/시그니처 변경 없음.

CREATE OR REPLACE FUNCTION public.venue_stats_season_team_aggregates(
  p_season integer,
  p_games jsonb
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
WITH universe AS MATERIALIZED (
  -- 권위 있는 정규 final 전체 경기 우주 (호출측 스케줄 소스). game_id 중복은 1개로.
  SELECT DISTINCT ON (g->>'gameId')
    g->>'gameId' AS game_id,
    g->>'gameDate' AS game_date
  FROM jsonb_array_elements(coalesce(p_games, '[]'::jsonb)) AS g
  WHERE jsonb_typeof(g) = 'object'
    AND coalesce(g->>'gameId', '') <> ''
    AND coalesce(g->>'gameDate', '') <> ''
  ORDER BY g->>'gameId'
),
ledger AS MATERIALIZED (
  -- 우주 → ledger LEFT JOIN: ledger 없는 경기도 우주에 남는다 (complete=false 강등 대상).
  SELECT
    u.game_id,
    u.game_date,
    l.status,
    l.expected_row_count,
    l.expected_payload_hash,
    (l.game_id IS NOT NULL) AS has_ledger
  FROM universe u
  LEFT JOIN player_game_log_ingestions l ON l.game_id = u.game_id
),
game_actual AS MATERIALIZED (
  SELECT
    l.game_id,
    count(r.id) AS actual_count,
    encode(
      sha256(
        convert_to(
          coalesce(
            string_agg(
              concat_ws(
                ',',
                coalesce(r.kbo_id, '∅'),
                coalesce(r.player_type, '∅'),
                coalesce(r.game_id, '∅'),
                coalesce(r.game_date::text, '∅'),
                coalesce(r.team_id::text, '∅'),
                coalesce(r.team_code, '∅'),
                coalesce(r.opponent_team_id::text, '∅'),
                coalesce(CASE WHEN r.is_home THEN 'true' ELSE 'false' END, '∅'),
                coalesce(r.result, '∅'),
                coalesce(r.ab::text, '∅'),
                coalesce(r.h::text, '∅'),
                coalesce(r.hr::text, '∅'),
                coalesce(r.rbi::text, '∅'),
                coalesce(r.bb::text, '∅'),
                coalesce(r.so::text, '∅'),
                coalesce(r.ip_outs::text, '∅'),
                coalesce(r.er::text, '∅'),
                coalesce(r.h_allowed::text, '∅'),
                coalesce(r.k::text, '∅'),
                coalesce(r.bb_allowed::text, '∅')
              ),
              '|'
              ORDER BY r.kbo_id COLLATE "C", r.player_type COLLATE "C"
            ) FILTER (WHERE r.id IS NOT NULL),
            ''
          ),
          'UTF8'
        )
      ),
      'hex'
    ) AS actual_hash
  FROM ledger l
  LEFT JOIN player_game_logs r ON r.game_id = l.game_id
  GROUP BY l.game_id
),
verified AS MATERIALIZED (
  SELECT
    l.game_id,
    l.game_date,
    coalesce(
      l.has_ledger
      AND l.status = 'complete'
      AND l.expected_row_count IS NOT NULL
      AND l.expected_payload_hash IS NOT NULL
      AND a.actual_count = l.expected_row_count
      AND a.actual_hash = l.expected_payload_hash,
      false
    ) AS complete
  FROM ledger l
  JOIN game_actual a USING (game_id)
),
team_totals AS MATERIALIZED (
  SELECT
    r.team_id,
    count(DISTINCT r.game_id) AS complete_games,
    sum(CASE WHEN r.player_type = 'batter' THEN r.ab ELSE 0 END) AS ab,
    sum(CASE WHEN r.player_type = 'batter' THEN r.h ELSE 0 END) AS h,
    sum(CASE WHEN r.player_type = 'batter' THEN r.hr ELSE 0 END) AS hr,
    sum(CASE WHEN r.player_type = 'pitcher' THEN r.ip_outs ELSE 0 END) AS outs,
    sum(CASE WHEN r.player_type = 'pitcher' THEN r.er ELSE 0 END) AS er,
    sum(CASE WHEN r.player_type = 'pitcher' THEN r.h_allowed ELSE 0 END) AS h_allowed
  FROM player_game_logs r
  JOIN verified v ON v.game_id = r.game_id AND v.complete
  GROUP BY r.team_id
)
SELECT jsonb_build_object(
  'season', p_season,
  'games', coalesce(
    (
      SELECT jsonb_agg(
        jsonb_build_object(
          'gameId', game_id,
          'gameDate', game_date,
          'complete', complete
        )
        ORDER BY game_date, game_id
      )
      FROM verified
    ),
    '[]'::jsonb
  ),
  'teams', coalesce(
    (
      SELECT jsonb_agg(
        jsonb_build_object(
          'teamId', team_id,
          'completeGames', complete_games,
          'ab', ab,
          'h', h,
          'hr', hr,
          'outs', outs,
          'er', er,
          'hAllowed', h_allowed
        )
        ORDER BY team_id
      )
      FROM team_totals
    ),
    '[]'::jsonb
  )
);
$$;

-- ledger는 service_role 전용(완료 판정 조작 방지) — RPC도 service_role만 실행한다.
-- SECURITY INVOKER 유지: service_role 호출은 RLS를 우회하고, anon/authenticated는 실행 자체가 차단된다.
REVOKE ALL ON FUNCTION public.venue_stats_season_team_aggregates(integer, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.venue_stats_season_team_aggregates(integer, jsonb) TO service_role;
