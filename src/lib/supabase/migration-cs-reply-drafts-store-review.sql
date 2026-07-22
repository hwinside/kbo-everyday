-- 공개 스토어 리뷰 원클릭 승인 큐.
-- GET은 확인 화면만, POST는 approved 마킹만 수행한다. 로컬 cs-relay가 원자적으로
-- processing 선점 후 실제 App Store/Google Play 답변을 게시하고 sent로 마감한다.
alter table public.cs_reply_drafts alter column user_id drop not null;

alter table public.cs_reply_drafts drop constraint if exists cs_reply_drafts_kind_check;
alter table public.cs_reply_drafts
  add constraint cs_reply_drafts_kind_check
  check (kind in ('feedback', 'dm', 'store_review'));

alter table public.cs_reply_drafts drop constraint if exists cs_reply_drafts_status_check;
alter table public.cs_reply_drafts
  add constraint cs_reply_drafts_status_check
  check (status in ('pending', 'approved', 'processing', 'sent', 'canceled'));

alter table public.cs_reply_drafts add column if not exists approved_at timestamptz;
alter table public.cs_reply_drafts add column if not exists processing_at timestamptz;

alter table public.cs_reply_drafts drop constraint if exists cs_reply_drafts_target_shape_check;
alter table public.cs_reply_drafts
  add constraint cs_reply_drafts_target_shape_check
  check (
    (kind = 'store_review' and user_id is null and conversation_id is null and feedback_id is null)
    or (kind in ('feedback', 'dm') and user_id is not null)
  );

create index if not exists cs_reply_drafts_store_approved_idx
  on public.cs_reply_drafts (approved_at)
  where kind = 'store_review' and status = 'approved';
