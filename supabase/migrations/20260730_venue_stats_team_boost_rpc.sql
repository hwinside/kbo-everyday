-- 직관 다이어리 통계 S1b — 팀 부스트 시즌 집계 RPC (v1 신설 RPC 1개).
-- spec: Notion "[기획] 직관 다이어리 통계 v1" rev5 §4(B1·B2·B4 집계 RPC)·§11(runtime completeness)·
--       §12(canonical payload hash — PlayerGameLogRow 20필드 전체)
--
-- ⚠️ production 선적용 금지 — PR 리뷰·하린아빠 머지 승인 뒤 배포한다 (S1b는 migration 작성만).
--
-- 경기 우주 (§11 — ledger 없는 경기 누락 금지, 삼순 리뷰 P0 반영):
--   호출측(route)이 권위 있는 정규시즌 final 전체 경기 우주(p_games: [{gameId, gameDate}])를
--   먼저 구성해 넘기고, 이 RPC는 그 우주에 ledger/log를 LEFT JOIN한다.
--   ledger가 없는 우주 경기는 결과에서 빠지는 게 아니라 complete=false로 강등된다(fail-closed).
--   teams 합계도 이 우주 안에서 complete 검증을 통과한 경기만 산입한다 — 우주 밖 ledger는 무시.
--
-- 반환(jsonb):
--   games: 우주 전체 경기별 runtime 검증 결과 [{gameId, gameDate, complete}] (|games| = |우주|)
--          — E1 팀 시즌 일정·B/C 시즌 baseline coverage 공용 소스.
--   teams: complete 검증 통과 경기만으로 집계한 팀별 시즌 합계
--          [{teamId, completeGames, ab, h, hr, outs, er, hAllowed}]
--          — B1(AVG=ΣH/ΣAB)·B2(ERA=27×ΣER/Σouts)·B4(HR/피안타 per-game) 시즌 분모.
--
-- complete 판정 (§11 runtime completeness — ledger complete만으로 신뢰 금지):
--   ledger 행 존재 AND ledger.status='complete' AND actual row count = expected_row_count AND
--   actual canonical payload hash = expected_payload_hash. 어느 조건이든 미충족(ledger 부재 포함)이면
--   complete=false.
--   hash는 §12 canonical 직렬화와 byte-exact 동일해야 한다:
--   (kbo_id asc, player_type asc — COLLATE "C" byte order = TS 문자열 비교) 정렬,
--   20필드를 "," join, 행을 "|" join, null → '∅'(U+2205), boolean → 'true'/'false',
--   date → YYYY-MM-DD, sha256 hex (src/lib/game-logs/completeness.ts canonicalPayloadHash와 동치.
--   회귀: scripts/qa/venue-stats-s1b-db-route-integration.ts에서 TS hash와 exact 대조).
--
-- ⚠️ CTE 는 전부 MATERIALIZED 이어야 한다 (2026-08-01 사고 대응).
--   PG12+ 는 단일 참조 CTE 를 기본 inline 하는데, 이 쿼리는 verified/team_totals 가
--   ledger→game_actual 을 재참조해서 inline 되면 hash 집계(17k 행 string_agg+sha256)가
--   여러 번 재실행된다. 경기 수에 대해 초선형으로 터져 실측상 491경기에서
--   statement timeout(57014) 으로 죽었다(=직관 통계 B1·B2·B4 가 상시 attendance_only).
--   실측: 300경기 4.1s / 491경기 timeout → MATERIALIZED 후 491경기 157ms,
--   결과는 byte-exact 동일(md5 대조 확인). 이 힌트를 제거하지 말 것.
--   회귀: scripts/qa/venue-stats-rpc-scale.ts (491경기 예산 내 완료 + 결과 동일성).

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
