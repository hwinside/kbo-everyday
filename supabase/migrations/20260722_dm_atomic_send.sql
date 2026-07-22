-- 첫 쪽지 전송은 방 생성 + 메시지 INSERT를 한 트랜잭션으로 처리한다.
-- 모든 dm_messages INSERT는 같은 트랜잭션의 trigger로 목록 preview를 갱신한다.

create or replace function public.sync_dm_conversation_preview()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_preview text;
begin
  v_preview := coalesce(
    nullif(btrim(new.content), ''),
    case when coalesce(cardinality(new.image_urls), 0) > 0 then '[사진]' else '[메시지]' end
  );

  update public.dm_conversations
  set last_message = v_preview,
      last_message_at = new.created_at
  where id = new.conversation_id
    and (last_message_at is null or last_message_at <= new.created_at);

  return new;
end;
$$;

revoke all on function public.sync_dm_conversation_preview() from public, anon, authenticated;

drop trigger if exists trg_sync_dm_conversation_preview on public.dm_messages;
create trigger trg_sync_dm_conversation_preview
after insert on public.dm_messages
for each row execute function public.sync_dm_conversation_preview();

create or replace function public.send_dm_message_atomic(
  p_target_user_id uuid,
  p_content text default '',
  p_image_urls text[] default '{}'
)
returns table(conversation_id uuid, message_id bigint)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_sender_id uuid := auth.uid();
  v_user1_id uuid;
  v_user2_id uuid;
  v_conversation_id uuid;
  v_message_id bigint;
  v_content text := btrim(coalesce(p_content, ''));
  v_image_urls text[];
begin
  if v_sender_id is null then
    raise exception using errcode = '42501', message = 'authentication required';
  end if;
  if p_target_user_id is null or p_target_user_id = v_sender_id then
    raise exception using errcode = '22023', message = 'invalid recipient';
  end if;

  select coalesce(array_agg(url), '{}')
  into v_image_urls
  from unnest(coalesce(p_image_urls, '{}')) as url
  where nullif(btrim(url), '') is not null;

  if v_content = '' and coalesce(cardinality(v_image_urls), 0) = 0 then
    raise exception using errcode = '22023', message = 'empty message';
  end if;

  if exists (
    select 1
    from public.user_blocks
    where (blocker_id = v_sender_id and blocked_id = p_target_user_id)
       or (blocker_id = p_target_user_id and blocked_id = v_sender_id)
  ) then
    raise exception using errcode = '42501', message = 'message unavailable';
  end if;

  if v_sender_id::text < p_target_user_id::text then
    v_user1_id := v_sender_id;
    v_user2_id := p_target_user_id;
  else
    v_user1_id := p_target_user_id;
    v_user2_id := v_sender_id;
  end if;

  insert into public.dm_conversations (user1_id, user2_id)
  values (v_user1_id, v_user2_id)
  on conflict (user1_id, user2_id)
  do update set user1_id = excluded.user1_id
  returning id into v_conversation_id;

  insert into public.dm_messages (conversation_id, sender_id, content, image_urls)
  values (v_conversation_id, v_sender_id, v_content, v_image_urls)
  returning id into v_message_id;

  return query select v_conversation_id, v_message_id;
end;
$$;

revoke all on function public.send_dm_message_atomic(uuid, text, text[]) from public, anon;
grant execute on function public.send_dm_message_atomic(uuid, text, text[]) to authenticated;

-- 과거 비원자 전송에서 preview만 누락된 대화가 있으면 최신 실제 메시지로 복구한다.
update public.dm_conversations c
set last_message = (
      select coalesce(
        nullif(btrim(m.content), ''),
        case when coalesce(cardinality(m.image_urls), 0) > 0 then '[사진]' else '[메시지]' end
      )
      from public.dm_messages m
      where m.conversation_id = c.id
      order by m.created_at desc, m.id desc
      limit 1
    ),
    last_message_at = (
      select m.created_at
      from public.dm_messages m
      where m.conversation_id = c.id
      order by m.created_at desc, m.id desc
      limit 1
    )
where c.last_message is null
  and exists (select 1 from public.dm_messages m where m.conversation_id = c.id);
