-- 팀별 뉴스클리핑 (2026-07-11 하린아빠 스펙)
-- 매일 07:00 KST cron이 어제 팀 기사 상위 5개(중복 제외 + Gemini 3줄 요약)를 쪽지로 발송.

-- ① 수신 토글 — 기본 ON(옵트아웃, 하린아빠 확정). OFF면 쪽지 생성·푸시 둘 다 안 함
--    (cron이 발송 전에 필터 + 디스패처 prefKey 이중 방어).
ALTER TABLE notification_prefs
  ADD COLUMN IF NOT EXISTS news_clipping BOOLEAN NOT NULL DEFAULT true;

-- ② 쪽지 구조화 payload — 뉴스클리핑 카드 렌더용 (payload->>'type' = 'news_clipping').
--    일반 쪽지는 NULL. select("*") 경로라 클라 변경 없이 함께 내려간다.
ALTER TABLE dm_messages
  ADD COLUMN IF NOT EXISTS payload JSONB;

-- ③ 발송 idempotency — (발송일, 유저) 단위 선점 키(news_clipping:{date}:{team}:{user} 스펙).
--    cron 재실행/중복 틱에도 유저당 1일 1회를 보장. 발송 직전 upsert(ignoreDuplicates)로
--    선점된 유저에게만 쪽지를 만든다.
CREATE TABLE IF NOT EXISTS news_clipping_sends (
  clip_date DATE NOT NULL,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  team_id INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (clip_date, user_id)
);

-- 서버(cron, service_role) 전용 테이블 — RLS on + 정책 0개 = 일반 클라 접근 전부 거부(의도).
ALTER TABLE news_clipping_sends ENABLE ROW LEVEL SECURITY;
