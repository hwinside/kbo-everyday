-- Deactivate dead RSS channel "오늘의야구" (UCYJ2XGzgpJ4X9rtxjxdbO1Q).
--
-- 이 채널은 YouTube에서 삭제되어 RSS가 지속적으로 404를 반환한다. videos-rss
-- 크론이 매 실행마다 이 한 채널의 RSS 실패를 fallback(no uploads)로 남겨 job
-- 노이즈를 유발하므로 수집 대상에서 제외한다.
--
-- 주의: channel_name "오늘의야구" 를 쓰는 다른 채널(UCSK10dkHVDCPYGqk3NrXYCg)이
-- 별도로 존재하므로 반드시 channel_id 로만 타겟한다. 이름으로 매칭 금지.
--
-- 기존 수집 영상(약 175건)은 보존한다. UPDATE 만 수행, DELETE 하지 않는다.
UPDATE public.channel_pool
SET is_active = false
WHERE channel_id = 'UCYJ2XGzgpJ4X9rtxjxdbO1Q'
  AND channel_name = '오늘의야구';
