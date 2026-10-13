-- Isolated test database only. RLS-only sentinels distinguish SQL filtering from RLS bypass.
create role anon nologin;
create role authenticated nologin;
create role authenticator login noinherit;
grant anon, authenticated to authenticator;
create table public.profiles (
  id uuid primary key, nickname text, team_id integer, grade text, points integer, avatar_url text
);
create table public.posts (
  id bigint primary key, author_id uuid not null references public.profiles(id),
  board_type text not null default 'team', board_id text default 'lg',
  content_type text default 'general', title text default 'fixture', content text default '',
  image_urls text[] default '{}', video_urls text[] default '{}',
  like_count integer default 0, comment_count integer default 0,
  created_at timestamptz not null default now(), is_hidden boolean default false,
  game_id text, player_tags jsonb default '[]', team_tags jsonb default '["lg"]',
  hashtags text[] default '{}', author_team_id_snapshot integer default 1,
  click_view_count integer default 0, impression_view_count integer default 0,
  qa_private boolean default false
);
alter table public.posts enable row level security;
alter table public.profiles enable row level security;
grant usage on schema public to anon, authenticated;
grant select on public.posts, public.profiles to anon, authenticated;
create policy public_posts on public.posts for select to anon, authenticated using (not qa_private);
create policy own_posts on public.posts for select to authenticated using (
  author_id::text = (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')
);
create policy public_profiles on public.profiles for select to anon, authenticated using (true);
insert into public.profiles values
 ('00000000-0000-4000-8000-000000000001', 'fixture-A', 1, 'bronze', 0, null),
 ('00000000-0000-4000-8000-000000000002', 'fixture-B', 3, 'bronze', 0, null);
insert into public.posts(id, author_id, like_count, comment_count)
 select i, '00000000-0000-4000-8000-000000000001', i, 1 from generate_series(1,125) i;
insert into public.posts(id, author_id, like_count, qa_private) values
 (200, '00000000-0000-4000-8000-000000000001', 500, true),
 (201, '00000000-0000-4000-8000-000000000002', 501, true);
