-- 뉴스클리핑 쪽지 payload 정규화 — 같은 기사 묶음을 수신자 수만큼 복제하던 구조를 참조로 바꾼다.
--
-- 배경(2026-08-20 실측):
--   dm_messages 2,110MB 중 TOAST 가 1,592MB. content 는 평균 60바이트인데 payload 가 평균
--   2,025바이트이고 전체 행의 96.7%에 들어있다. 내용을 보니:
--     8/18 KIA  — 6,102행인데 서로 다른 payload 는 120개
--     8/18 삼성 — 4,196행 / 45개
--   즉 **같은 기사 묶음(articles 평균 3,505바이트)을 수신자 수만큼 통째로 복제**하고 있었다.
--   distinct 가 1이 아닌 이유는 첫 수신 유저에게만 붙는 intro(닉네임 치환) 때문이다.
--   하루 27,208건 × 2KB ≈ 55MB/일이 전부 이 복제다.
--
-- 구조:
--   (clip_date, team_id) 당 1행의 digest 테이블에 기사 묶음을 저장하고, 쪽지 payload 는
--   digest_id + 유저 고유 필드(intro)만 갖는다. 하루 10개 팀 = 10행.
--
-- 호환(중요):
--   과거 쪽지 수백만 건은 **건드리지 않는다**(대량 UPDATE 금지 — WAL/dead tuple 급증 방지).
--   과거 payload 는 articles 를 그대로 들고 있고, 신규 payload 는 digest_id 를 갖는다.
--   클라이언트는 둘 다 읽는다(dual-read). 과거분 정리는 별도 배치 트랙.

create table if not exists public.news_clipping_digests (
  id bigserial primary key,
  clip_date date not null,
  team_id int not null,
  team_name text not null,
  overview text not null default '',
  articles jsonb not null,
  created_at timestamptz not null default now(),
  unique (clip_date, team_id)
);

comment on table public.news_clipping_digests is
  '뉴스클리핑 기사 묶음 SSOT — (clip_date, team_id) 당 1행. 쪽지 payload 는 이 행을 참조만 한다.';
comment on column public.news_clipping_digests.articles is
  'NewsClippingArticle[] 원문. 과거에는 수신자마다 dm_messages.payload 에 복제 저장됐다.';

create index if not exists idx_news_clipping_digests_date
  on public.news_clipping_digests (clip_date desc);

-- 서버(cron, service_role) 쓰기 전용. 읽기는 로그인 유저에게 열어야 쪽지 카드가 렌더된다.
-- ⚠️ 쪽지 본문(conversation)과 달리 digest 는 **팀 단위 공개 기사 묶음**이라 유저별 비밀이 없다.
--    (그래서 authenticated SELECT 를 허용해도 타인 쪽지 내용이 새지 않는다. intro 등 유저 고유
--     필드는 digest 가 아니라 각 쪽지 payload 에 남는다 — 이 분리가 이 설계의 전제다.)
alter table public.news_clipping_digests enable row level security;

drop policy if exists "news_clipping_digests read" on public.news_clipping_digests;
create policy "news_clipping_digests read" on public.news_clipping_digests
  for select
  to authenticated
  using (true);

drop policy if exists "news_clipping_digests service write" on public.news_clipping_digests;
create policy "news_clipping_digests service write" on public.news_clipping_digests
  for all
  to service_role
  using (true)
  with check (true);

revoke all on public.news_clipping_digests from public, anon;
grant select on public.news_clipping_digests to authenticated;
grant select, insert, update, delete on public.news_clipping_digests to service_role;
grant usage, select on sequence public.news_clipping_digests_id_seq to service_role;

-- ── digest 확보(insert-once): 같은 (clip_date, team_id) 는 **덮어쓰지 않는다** ──
--
-- ⚠️ 삼순 blocker 3 (2026-08-20): 1차는 `do update set articles = excluded.articles` 였다.
--    cron 이 재실행되면 같은 (날짜, 팀) digest 의 기사·요약이 갱신되는데, **이미 발송된
--    과거 쪽지들이 전부 그 digest 를 참조**하므로 유저가 어제 읽은 쪽지 내용이 소급 변경된다.
--    복제 저장에는 없던 부작용이다(각자 사본을 갖고 있었으므로).
--    → 존재하면 그대로 두고 기존 id 만 돌려준다. 발송 시점 사실을 보존한다.
-- ⚠️ 삼순 blocker 3 (2026-08-20, 3차): 1차 수정은 id 만 돌려줘서, 충돌(이미 존재) 시
--    카드는 **저장된 A** 를 보여주는데 푸시 preview 는 **이번에 생성한 B** 에서 만들어졌다.
--    cron 재실행·샘플 선점·부분 재시도면 카드와 푸시가 서로 다른 기사를 가리킨다.
--    → **저장된 overview 와 id 를 함께 반환**하고, 호출부는 그 값으로 preview 를 만든다.
--    그러면 "푸시는 항상 그 digest 의 내용"이 구조적으로 보장된다.
--
-- 구(bigint) 시그니처는 남기지 않는다 — 배포 직후 구코드가 그걸 부르면 카드/푸시 불일치가
-- 그대로 살아남는다. 반환형이 바뀌면 구코드는 즉시 실패하고 legacy 폴백으로 떨어진다(안전).
drop function if exists public.upsert_news_clipping_digest(date, int, text, text, jsonb);

create or replace function public.upsert_news_clipping_digest(
  p_clip_date date,
  p_team_id int,
  p_team_name text,
  p_overview text,
  p_articles jsonb
)
-- stored_articles 까지 돌려주는 이유(삼순 4차): 샘플 발송 응답이 "실제 전송된 내용"을 보고해야
-- E2E 증거로 쓸 수 있다. 충돌이면 전송된 건 저장된 A 인데 호출부가 방금 만든 B 의 titles 를
-- 보고하면, 검수자가 화면과 다른 목록을 보고 "맞다"고 판정하게 된다.
returns table (digest_id bigint, stored_overview text, stored_articles jsonb)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_articles is null or jsonb_typeof(p_articles) <> 'array' or jsonb_array_length(p_articles) = 0 then
    -- 기사 0건 digest 는 만들지 않는다. 만들면 쪽지가 "기사 없음" 카드를 참조하게 되고,
    -- 클라의 dual-read 가 과거 payload 폴백으로 떨어지지도 못한다(digest_id 는 있는데 내용이 빔).
    raise exception 'articles must be a non-empty jsonb array';
  end if;

  -- insert-once: 충돌 시 아무 컬럼도 바꾸지 않는다. (do nothing 은 행을 못 돌려주므로
  -- 자기 자신 대입으로 RETURNING 만 얻는다 — 값은 그대로다.)
  -- 반환되는 overview 는 **저장된 값**이다: 신규면 방금 넣은 값, 충돌이면 기존 값.
  return query
  insert into public.news_clipping_digests as d (clip_date, team_id, team_name, overview, articles)
  values (p_clip_date, p_team_id, p_team_name, coalesce(p_overview, ''), p_articles)
  on conflict (clip_date, team_id) do update set
    clip_date = d.clip_date
  returning d.id, d.overview, d.articles;
end;
$$;

revoke all on function public.upsert_news_clipping_digest(date, int, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.upsert_news_clipping_digest(date, int, text, text, jsonb) to service_role;
