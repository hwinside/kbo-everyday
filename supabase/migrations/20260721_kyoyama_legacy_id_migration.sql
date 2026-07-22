-- 쿄야마 중복 항목 통합 후속: 레거시 합성 ID(AQ008) → 현행 숫자 ID(56548) forward-only 이관
-- (2026-07-21, PR #743 삼순 리뷰 반영 — 게시글 2422 중복 선수 정리)
--
-- 배경: 로스터에서 stale '교야마 마사야'(AQ008)를 제거하고 실제 등록명 '쿄야마'(56548)로
-- 단일화했으나, prod에 구 ID 참조가 잔존: favorite_players.playerId=AQ008 3계정,
-- posts(board_type=player, board_id=AQ008) 2건. 그대로 두면 최애 카드/상세가 깨지고
-- 구 게시판 글이 56548 피드에서 고립됨.
--
-- 멱등성: 재실행 시 AQ008 참조가 이미 없으므로 no-op (forward-only).
-- 배포 순서: 코드 배포 *이전* 적용 안전 — 구 코드 로스터에는 56548 항목도 존재하므로
-- 이관된 참조를 정상 해석함.

-- 1) 게시판 글 이관: 교야마(AQ008) 게시판 → 쿄야마(56548) 게시판 합류
UPDATE posts
SET board_id = '56548'
WHERE board_type = 'player'
  AND board_id = 'AQ008';

-- 2) 최애선수 이관: favorite_players JSONB 배열에서 AQ008 요소를 56548로 교체
--    - 배열 순서 보존 (WITH ORDINALITY 원 위치 유지)
--    - 타 선수 요소 불변
--    - name/number도 현행 등록 정보(쿄야마/48)로 갱신
--    - 방어적 dedupe: 같은 배열에 56548이 이미 있으면 첫 등장만 유지(현 prod 해당 0건)
DO $$
DECLARE
  r RECORD;
  new_arr jsonb;
BEGIN
  FOR r IN
    SELECT id, favorite_players
    FROM profiles
    WHERE favorite_players @> '[{"playerId":"AQ008"}]'::jsonb
  LOOP
    SELECT jsonb_agg(elem ORDER BY ord) INTO new_arr
    FROM (
      SELECT DISTINCT ON (mapped ->> 'playerId')
             mapped AS elem,
             ord
      FROM (
        SELECT CASE
                 WHEN t.elem ->> 'playerId' = 'AQ008'
                   THEN t.elem || '{"playerId":"56548","name":"쿄야마","number":48}'::jsonb
                 ELSE t.elem
               END AS mapped,
               t.ord
        FROM jsonb_array_elements(r.favorite_players) WITH ORDINALITY AS t(elem, ord)
      ) m
      ORDER BY mapped ->> 'playerId', ord
    ) d;

    UPDATE profiles
    SET favorite_players = COALESCE(new_arr, '[]'::jsonb)
    WHERE id = r.id;
  END LOOP;
END $$;
