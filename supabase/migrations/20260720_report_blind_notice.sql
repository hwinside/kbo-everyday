-- 신고 3회 누적 시 자동 블라인드 + 작성자 안내 쪽지 (채팅/게시글/댓글 통합)
-- ------------------------------------------------------------------------
-- 배경: 기존 auto_blind_on_report 트리거는 post/comment의 is_hidden 을
--       AFTER INSERT 시점에 직접 전환했다. 이 구조에서는 "블라인드로 전환되는
--       바로 그 순간"을 애플리케이션이 포착할 수 없어, 작성자에게 안내 쪽지를
--       정확히 1회 발송하기 어렵다(트리거가 이미 숨김 처리해버림).
-- 변경: 트리거는 report_count 집계만 담당하도록 축소하고, 실제 블라인드
--       (is_hidden / chat_messages.deleted_at)와 안내 쪽지 발송은 /api/report
--       라우트가 원자적 가드(is_hidden=false / deleted_at IS NULL)로 소유한다.
--       임계값 3회는 동일 — 블라인드 동작은 동등하며 "쪽지 안내"만 추가된다.
--       채팅은 report_count 컬럼이 없으므로 라우트가 reports 행 수로 판정한다.

CREATE OR REPLACE FUNCTION auto_blind_on_report()
RETURNS TRIGGER AS $$
BEGIN
  -- report_count 집계만 유지(어드민 노출용). is_hidden 자동 전환은 라우트로 이관.
  IF NEW.target_type = 'post' THEN
    UPDATE posts SET report_count = report_count + 1 WHERE id = NEW.target_id;
  ELSIF NEW.target_type = 'comment' THEN
    UPDATE comments SET report_count = report_count + 1 WHERE id = NEW.target_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 트리거(trg_auto_blind)는 그대로 유지 — 함수 본문만 교체한다.
