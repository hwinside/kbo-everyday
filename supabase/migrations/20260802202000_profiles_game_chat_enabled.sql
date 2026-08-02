alter table public.profiles
  add column if not exists game_chat_enabled boolean not null default true;

comment on column public.profiles.game_chat_enabled is
  '경기 상세 전체 채팅 노출 여부. false면 채팅 UI와 모든 채팅 focus target을 렌더하지 않는다.';
