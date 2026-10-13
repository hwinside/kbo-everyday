-- Ticket transfers: KST game-date rollover, not first pitch or UTC midnight.
-- Run only after review/merge approval. This also completes the existing backlog.
begin;

create extension if not exists pg_cron with schema extensions;
create schema if not exists private;

create or replace function private.normalize_ticket_transfer_status()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.status in ('open', 'reserved')
     and new.game_date < (statement_timestamp() at time zone 'Asia/Seoul')::date then
    new.status := 'sold';
  end if;
  return new;
end;
$$;

revoke all on function private.normalize_ticket_transfer_status() from public, anon, authenticated;

-- Covers old app versions and writes racing the sweep. The existing author RLS
-- stays intact; this trigger changes only NEW.status, never another user's row.
drop trigger if exists ticket_transfer_auto_complete on public.ticket_transfers;
create trigger ticket_transfer_auto_complete
before insert or update on public.ticket_transfers
for each row execute function private.normalize_ticket_transfer_status();

create or replace function private.complete_past_ticket_transfers()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  completed integer;
begin
  -- Uses the existing (status, game_date) index; terminal/NULL dates are untouched.
  update public.ticket_transfers
     set status = 'sold'
   where status in ('open', 'reserved')
     and game_date < (statement_timestamp() at time zone 'Asia/Seoul')::date;
  get diagnostics completed = row_count;
  return completed;
end;
$$;

-- Only the DB-owned scheduler/operator can sweep other authors' rows.
revoke all on function private.complete_past_ticket_transfers() from public, anon, authenticated;

-- Named schedule is idempotent. Every hour includes KST midnight and retries a
-- missed run without waiting another day; date calculation is timezone-explicit.
select cron.schedule(
  'ticket-transfers-auto-complete',
  '0 * * * *',
  'select private.complete_past_ticket_transfers();'
);

select private.complete_past_ticket_transfers();
commit;
