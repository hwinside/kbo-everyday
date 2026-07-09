-- CS 원클릭 회신 초안 저장 테이블
-- 삼식이(LLM)가 회신 초안을 작성해 저장 → Slack 링크로 하린아빠가 확인/발송(룰베이스, LLM 미개입).
-- 발송 자체는 /api/cs/approve/<token> 의 POST에서 service_role 로 처리한다.
create table if not exists public.cs_reply_drafts (
  id uuid primary key default gen_random_uuid(),
  token text unique not null,                 -- 1회용 고엔트로피 토큰(링크 capability)
  cs_id text not null,                        -- feedback:<id> | dm:<conv>:<msg>
  kind text not null check (kind in ('feedback', 'dm')),
  user_id uuid not null,                      -- 수신 유저
  conversation_id uuid,                       -- dm 건의 대화 id (nullable)
  feedback_id bigint,                         -- feedback 건의 id (nullable)
  body text not null,                         -- 발송할 초안 본문
  status text not null default 'pending' check (status in ('pending', 'sent', 'canceled')),
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  expires_at timestamptz not null default (now() + interval '7 days')
);

create index if not exists cs_reply_drafts_cs_id_idx on public.cs_reply_drafts (cs_id);
create index if not exists cs_reply_drafts_status_idx on public.cs_reply_drafts (status);

-- service_role 전용: RLS on + 정책 없음 = 비 service_role 접근 전면 거부.
alter table public.cs_reply_drafts enable row level security;
