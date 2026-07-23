-- 2026-07-22 Supabase 장애(conn pool 고갈·CPU 100%) 후속: 쿼리 최적화 인덱스
-- 근거: pg_stat_statements 분석 (2026-07-23)
--
-- 1) profiles nickname ILIKE (닉네임 중복 체크 — check-nickname/setup/me/nickname):
--    mean ~25ms × 2.8k calls. ILIKE는 btree(profiles_nickname_unique)를 못 타고
--    profiles 풀스캔(seq_tup_read 1.2억 누적 기여). pg_trgm GIN으로 ILIKE 인덱스화.
create extension if not exists pg_trgm;

create index if not exists idx_profiles_nickname_trgm
  on public.profiles using gin (nickname gin_trgm_ops);

-- 2) videos player_ids && 조회 (선수 쇼츠 탭 — mean ~11ms × 15k calls, 총 실행시간 5위):
--    기존 idx_videos_player_ids는 partial(WHERE array_length(player_ids,1) > 0)이라
--    planner가 && 조건만으로는 predicate 함의를 증명 못해 미사용(idx_scan 통계상 사용 안 됨).
--    플래너가 published_at 인덱스와 BitmapAnd 조합할 수 있도록 non-partial GIN 추가.
--    (기존 partial 인덱스 제거는 이 PR 범위 밖 — 관측 후 별도 처리)
create index if not exists idx_videos_player_ids_gin
  on public.videos using gin (player_ids);
