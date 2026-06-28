-- ============================================================
-- 크관(GameChat) 1-depth 답글(댓글) v1 — DB migration
-- ------------------------------------------------------------
-- 고객 요청(#cs 1782638446): 라이브 경기 채팅에서 특정 메시지에 답글.
-- 스펙(하린아빠 확정): 1-depth만, 원글당 복수 답글, 전부 노출(접기 X),
--                     작성자 알림 없음.
-- reply_to_id: 답글이 가리키는 원글(루트) 메시지 id. NULL이면 루트 메시지.
-- ============================================================

-- 1. 컬럼 추가 (idempotent). 루트 메시지가 hard-delete 되면 답글은 루트로 승격
--    되도록 ON DELETE SET NULL. (실서비스는 soft-delete만 사용하므로 거의 발생 X)
ALTER TABLE chat_messages
  ADD COLUMN IF NOT EXISTS reply_to_id BIGINT
    REFERENCES chat_messages(id) ON DELETE SET NULL;

-- 2. 답글 조회 인덱스 (원글 기준 그룹핑/missing-parent fetch 가속)
CREATE INDEX IF NOT EXISTS idx_chat_messages_reply_to
  ON chat_messages(reply_to_id) WHERE reply_to_id IS NOT NULL;

-- 3. 1-depth 강제 트리거.
--    답글의 대상(reply_to_id)은 반드시 "루트 메시지(reply_to_id IS NULL)"여야 한다.
--    답글에 답글(2-depth)을 서버에서 차단 — 클라 가드 우회 방지.
CREATE OR REPLACE FUNCTION enforce_chat_reply_one_depth()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.reply_to_id IS NOT NULL THEN
    -- 자기 자신 참조 금지
    IF NEW.reply_to_id = NEW.id THEN
      RAISE EXCEPTION 'chat reply cannot reference itself' USING ERRCODE = '23514';
    END IF;
    -- 대상이 존재하고 루트여야 함 (1-depth)
    IF NOT EXISTS (
      SELECT 1 FROM chat_messages p
       WHERE p.id = NEW.reply_to_id
         AND p.reply_to_id IS NULL
    ) THEN
      RAISE EXCEPTION 'chat reply target must be a root message (1-depth only)'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_chat_reply_one_depth ON chat_messages;
CREATE TRIGGER trg_chat_reply_one_depth
  BEFORE INSERT OR UPDATE OF reply_to_id ON chat_messages
  FOR EACH ROW EXECUTE FUNCTION enforce_chat_reply_one_depth();

-- ============================================================
-- 배포 후 검증
-- ------------------------------------------------------------
-- ✅ #1 컬럼/인덱스/트리거 존재 확인
-- ✅ #2 루트 메시지에 답글 insert 성공 (reply_to_id = 루트 id)
-- ✅ #3 답글에 답글 insert → 23514 에러 (2-depth 차단)
-- ✅ #4 존재하지 않는 id 참조 insert → 23514 에러
-- ✅ #5 기존 SELECT/INSERT RLS 영향 없음 (reply_to_id는 데이터 컬럼)
-- ============================================================
