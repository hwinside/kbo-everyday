-- CS 원클릭 회신 초안에 '이관(escalate)' 지원 컬럼 추가.
-- 이관 = 그대로 답장이 아니라 팀 논의가 필요한 CS를 #cs(C0AKRDUGC2U)로 올리는 것.
-- cron이 draft 생성 시 title(#cs 톱레벨 제목) + cs_content(#cs 스레드에 붙일 CS 원문)를 함께 저장.
-- 하린아빠가 이관 링크를 누르면 escalate_requested_at 이 찍히고, cs-relay cron 이 다음 틱에
-- #cs 에 게시한 뒤 escalated_at 을 찍는다.
alter table public.cs_reply_drafts add column if not exists title text;
alter table public.cs_reply_drafts add column if not exists cs_content text;
alter table public.cs_reply_drafts add column if not exists escalate_requested_at timestamptz;
alter table public.cs_reply_drafts add column if not exists escalated_at timestamptz;

-- cron 픽업 대상(이관 요청됨 && 아직 미게시)만 인덱싱.
create index if not exists cs_reply_drafts_escalate_pending_idx
  on public.cs_reply_drafts (escalate_requested_at)
  where escalate_requested_at is not null and escalated_at is null;
