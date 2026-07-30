-- 직관 다이어리 통계 S1b — 팀 부스트 시즌 집계 RPC (v1 신설 RPC 1개).
-- spec: Notion "[기획] 직관 다이어리 통계 v1" rev5 §4(B1·B2·B4 집계 RPC)·§11(runtime completeness)·
--       §12(canonical payload hash — PlayerGameLogRow 20필드 전체)
--
-- ⚠️ production 선적용 금지 — PR 리뷰·하린아빠 머지 승인 뒤 배포한다 (S1b는 migration 작성만).
--
-- 반환(jsonb):
--   games: 시즌 ledger 경기별 runtime 검증 결과 [{gameId, gameDate, complete}]
--          — E1 팀 일정·C 시즌 baseline coverage 공용 소스.
--   teams: complete 검증 통과 경기만으로 집계한 팀별 시즌 합계
--          [{teamId, completeGames, ab, h, hr, outs, er, hAllowed}]
--          — B1(AVG=ΣH/ΣAB)·B2(ERA=27×ΣER/Σouts)·B4(HR/피안타 per-game) 시즌 분모.
--
-- complete 판정 (§11 runtime completeness — ledger complete만으로 신뢰 금지):
--   ledger.status='complete' AND actual row count = expected_row_count AND
--   actual canonical payload hash = expected_payload_hash.
--   hash는 §12 canonical 직렬화와 byte-exact 동일해야 한다:
--   (kbo_id asc, player_type asc — COLLATE "C" byte order = TS 문자열 비교) 정렬,
--   20필드를 "," join, 행을 "|" join, null → '∅'(U+2205), boolean → 'true'/'false',
--   date → YYYY-MM-DD, sha256 hex (src/lib/game-logs/completeness.ts canonicalPayloadHash와 동치.
--   회귀: scripts/qa/venue-stats-s1b-db-integration.ts에서 TS hash와 exact 대조).

CREATE OR REPLACE FUNCTION public.venue_stats_season_team_aggregates(p_season integer)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
WITH ledger AS (
  SELECT game_id, game_date, status, expected_row_count, expected_payload_hash
  FROM player_game_log_ingestions
  WHERE game_date >= make_date(p_season, 1, 1)
    AND game_date < make_date(p_season + 1, 1, 1)
),
game_actual AS (
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
verified AS (
  SELECT
    l.game_id,
    l.game_date,
    (
      l.status = 'complete'
      AND l.expected_row_count IS NOT NULL
      AND l.expected_payload_hash IS NOT NULL
      AND a.actual_count = l.expected_row_count
      AND a.actual_hash = l.expected_payload_hash
    ) AS complete
  FROM ledger l
  JOIN game_actual a USING (game_id)
),
team_totals AS (
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
          'gameDate', game_date::text,
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
REVOKE ALL ON FUNCTION public.venue_stats_season_team_aggregates(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.venue_stats_season_team_aggregates(integer) TO service_role;
