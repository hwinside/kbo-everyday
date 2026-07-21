-- 직관 라이브 (Venue Stories) — B+① 영상 즉시 검증용 private staging 버킷
--
-- ⚠️ prod 미적용 상태(머지 게이트 통과 후 적용). 선행 20260718_venue_stories.sql 도 아직 prod 미적용.
--
-- 아키텍처(하린아빠 확정 B+①, 삼순 09:44 #1):
--  1) 클라가 영상 원본을 **private** venue-staging 버킷의 본인 예약 경로에 업로드
--     (공개 URL 미부여 — pending 동안 원본 비노출).
--  2) 업로드 API 가 status=pending 으로 행 생성 후 같은 요청 안에서 ffprobe(구조·15초) 서버 권위 검증.
--  3) 통과 → 원본을 공개 videos 버킷으로 승격 + status pending→active CAS (즉시 공개).
--     실패 → status pending→removed CAS + staging 정리.
--  4) 720p 재인코딩은 GitHub Actions 30분 워커가 백그라운드 수행(복구 전용 강등).
--
-- venue_stories 테이블 스키마 변경은 없음 — status 'pending' 은 기존 CHECK 에 이미 포함,
-- game_ended_at/needs_transcode 도 기존 컬럼. RPC create_venue_story 시그니처 변경 없음.

-- ── private staging 버킷 ────────────────────────────────────────────
-- 60MB 상한 + 영상 MIME 만 허용(클라 업로드 시점 1차 방어 — 서버 ffprobe 가 최종 권위).
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'venue-staging',
  'venue-staging',
  false,
  62914560, -- 60MB
  ARRAY['video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v']
)
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ── storage RLS: authenticated 는 본인 예약 경로 INSERT 만 ──────────
-- 경로 규격: venue-stories/{gameId}/{userId}/{filename} — 3단 폴더의 3번째가 본인 uid.
-- SELECT/UPDATE/DELETE 정책 없음 = authenticated/anon 접근 불가(private).
-- 검증/승격/정리는 전부 service_role(API·워커, RLS bypass)이 수행.
DROP POLICY IF EXISTS "venue_staging_insert_own" ON storage.objects;
CREATE POLICY "venue_staging_insert_own" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'venue-staging'
    AND (storage.foldername(name))[1] = 'venue-stories'
    AND (storage.foldername(name))[3] = auth.uid()::text
    AND array_length(storage.foldername(name), 1) = 3
    AND name ~ '^venue-stories/[A-Za-z0-9_-]+/[0-9a-fA-F-]{36}/[A-Za-z0-9._-]+$'
  );

-- ── status 의미 갱신(주석) ─────────────────────────────────────────
COMMENT ON COLUMN venue_stories.status IS
  'pending=staging 즉시검증 대기(목록·원본 URL 미노출) / active=노출 / removed=정리 대상 / cleanup_failed=storage 삭제 재시도';

-- ── 만료 계약(주석) — 경기 종료+24h, terminal 전 삭제 금지 ─────────
COMMENT ON COLUMN venue_stories.expires_at IS
  '종료 확정 전: 시작+72h 안전상한(장애 정책·관제용, 정상 만료 아님). finalize cron 이 terminal CAS 성공 후 감지시각+24h 로 확정.';
COMMENT ON COLUMN venue_stories.game_ended_at IS
  '경기 terminal(final/cancelled) 첫 감지 시각. NULL 이면 cleanup 이 expiry 삭제 금지(안전상한 stale_cap 관제 제외).';
