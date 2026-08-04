-- 커뮤니티 영상 재인코딩 백필 전진성(progress) 마커
--
-- 문제: scripts/transcode-videos.mjs --reencode 는 대상을 `status='done'` 만으로 골라
--       optimized_bytes DESC LIMIT N 으로 잘랐다. "이 job 을 새 프로필로 이미 돌렸다"는
--       영속 상태가 없어 매 실행이 같은 상위 N 건을 재선택했다(특히 절감 미미로 keep 한 건).
--       → 배치 간 전진이 없고, 전체 완료·중단 후 재개·멱등 rerun 을 보장할 수 없다.
--
-- 해법: 처리된 프로필 세대를 행에 기록한다.
--   profile_version = scripts/video-profiles.mjs 의 COMMUNITY_PROFILE_VERSION 과 대응.
--     0 = 구 프로필(crf27/1280/128k)로 처리된 기존 done 건 = 백필 대상
--     2 = 현재 프로필(crf30/720/64k mono)로 처리 완료 = 대상 아님
--   재인코딩 대상 = status='done' AND profile_version < COMMUNITY_PROFILE_VERSION.
--   교체(replaced)뿐 아니라 절감 미미로 유지(kept)한 건도 현재값으로 마킹해야 전진한다.
--   실패 건만 미갱신 → 다음 실행에서 자연 재시도.
--
-- default 0: 기존 182건이 자동으로 "구 프로필 처리됨" = 백필 대상으로 분류된다.

ALTER TABLE video_transcode_jobs
  ADD COLUMN IF NOT EXISTS profile_version INT NOT NULL DEFAULT 0;

COMMENT ON COLUMN video_transcode_jobs.profile_version IS
  '이 job 을 처리한 인코딩 프로필 세대(scripts/video-profiles.mjs COMMUNITY_PROFILE_VERSION). 이 값 미만 = 재인코딩 백필 대상.';

-- 백필 배치 선택 인덱스: status='done' 중 미처리 세대를 용량 큰 순으로 뽑는 경로.
CREATE INDEX IF NOT EXISTS idx_video_transcode_jobs_reencode
  ON video_transcode_jobs (status, profile_version, optimized_bytes DESC);
