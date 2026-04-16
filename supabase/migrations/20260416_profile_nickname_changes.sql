create table if not exists public.profile_nickname_changes (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  old_nickname text not null,
  new_nickname text not null,
  changed_at timestamptz not null default now()
);

create index if not exists idx_profile_nickname_changes_user_changed_at
  on public.profile_nickname_changes (user_id, changed_at desc);

alter table public.profile_nickname_changes enable row level security;

drop policy if exists "Users read own nickname changes" on public.profile_nickname_changes;
create policy "Users read own nickname changes"
  on public.profile_nickname_changes
  for select
  using (auth.uid() = user_id);
