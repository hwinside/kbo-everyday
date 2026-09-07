/**
 * Reviewer-run QA: npm run qa:ticket-auto-complete
 * Actual migration/trigger/RLS in isolated PGlite; no production DB access.
 * pg_cron is unavailable in PGlite: only extension creation is removed and
 * cron.schedule is a named-job upsert stub. Live scheduler/UI remain separate QA.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { resolveTicketStatus } from "../../src/lib/tickets/auto-complete";
import { toKSTDateString } from "../../src/lib/utils/date-kst";

let checks = 0;
function equal(actual: unknown, expected: unknown, label: string) {
  assert.deepEqual(actual, expected, label);
  checks++;
}

async function main() {
  for (const [instant, expected] of [
    ["2026-09-07T14:59:59.999Z", "open"],
    ["2026-09-07T15:00:00.000Z", "sold"],
    ["2026-12-31T15:00:00.000Z", "sold"],
  ]) {
    equal(resolveTicketStatus({ status: "open", game_date: "2026-09-07" }, toKSTDateString(instant)), expected, instant);
  }
  for (const status of ["open", "reserved", "sold", "cancelled", "expired", "hidden"]) {
    for (const date of ["2026-09-06", "2026-09-07", "2026-09-08", null, "", "invalid", "2026-02-30"]) {
      equal(resolveTicketStatus({ status, game_date: date }, "2026-09-07"),
        date === "2026-09-06" && ["open", "reserved"].includes(status) ? "sold" : status,
        `${status}/${date}`);
    }
  }
  equal(resolveTicketStatus({ status: "open", game_date: "2028-02-29" }, "2028-03-01"), "sold", "leap day");

  const db = new PGlite();
  try {
    await db.exec(`
      create role anon;
      create role authenticated;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as
        $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      create table public.profiles (id uuid primary key);
      insert into public.profiles values
        ('11111111-1111-4111-8111-111111111111'),
        ('22222222-2222-4222-8222-222222222222');
      create schema cron;
      create table cron.job (jobname text primary key, schedule text, command text);
      create function cron.schedule(text, text, text) returns bigint language sql as $$
        insert into cron.job values ($1, $2, $3) on conflict (jobname)
          do update set schedule = excluded.schedule, command = excluded.command returning 1::bigint;
      $$;
    `);
    await db.exec(readFileSync("src/lib/supabase/migration-tickets.sql", "utf8"));
    // Legacy NULL-date preservation is defensive; production schema is NOT NULL.
    await db.exec(`alter table public.ticket_transfers alter column game_date drop not null;
      grant usage on schema public, auth to authenticated;
      grant select, insert, update, delete on public.ticket_transfers to authenticated;
      grant usage, select on sequence public.ticket_transfers_id_seq to authenticated;
      create function public.qa_ticket(text, date, uuid default '11111111-1111-4111-8111-111111111111')
      returns bigint language sql as $$
        insert into public.ticket_transfers (author_id, team_id, venue_id, game_date, seat_area, price, contact_method, status)
        values ($3, 1, 'jamsil', $2, 'QA', 1000, 'dm', $1) returning id;
      $$;
      select public.qa_ticket(case when n % 2 = 0 then 'reserved' else 'open' end,
        (statement_timestamp() at time zone 'Asia/Seoul')::date - 1)
      from generate_series(1,1205) n;
      select public.qa_ticket(s, d) from unnest(array['open','reserved','sold','cancelled','expired']) s,
        unnest(array[(statement_timestamp() at time zone 'Asia/Seoul')::date,
          (statement_timestamp() at time zone 'Asia/Seoul')::date + 1, null::date]) d;
      select public.qa_ticket('cancelled', (statement_timestamp() at time zone 'Asia/Seoul')::date - 1);
    `);
    const scalar = async (sql: string) => (await db.query<{ value: unknown }>(sql)).rows[0].value;
    const before = (await db.query("select id, status from public.ticket_transfers where id > 1205 order by id")).rows;
    const migration = readFileSync("supabase/migrations/20260907133000_ticket_auto_complete.sql", "utf8")
      .replace("create extension if not exists pg_cron with schema extensions;", "");
    await db.exec(migration);
    equal(await scalar("select count(*)::int value from public.ticket_transfers where id <= 1205 and status = 'sold'"), 1205, "backlog > 1000");
    equal((await db.query("select id, status from public.ticket_transfers where id > 1205 order by id")).rows, before, "today/future/NULL/terminal unchanged");
    equal(await scalar("select private.complete_past_ticket_transfers() value"), 0, "sweep idempotency");
    await db.exec(migration);
    equal(await scalar("select count(*)::int value from cron.job"), 1, "migration idempotency");
    equal((await db.query("select * from cron.job")).rows, [{ jobname: "ticket-transfers-auto-complete", schedule: "0 * * * *", command: "select private.complete_past_ticket_transfers();" }], "named hourly schedule");
    for (const role of ["anon", "authenticated"]) {
      equal(await scalar(`select has_function_privilege('${role}', 'private.complete_past_ticket_transfers()', 'execute') value`), false, `${role} cannot sweep`);
    }
    await db.exec(`set role authenticated;
      set request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222';`);
    equal((await db.query("update public.ticket_transfers set status = 'open' where id = 1 returning id")).rows.length, 0, "other user cannot mutate");
    await db.exec("set request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111'");
    equal(await scalar("update public.ticket_transfers set status = 'reserved' where id = 1 returning status value"), "sold", "stale reservation normalized");
    equal(await scalar("update public.ticket_transfers set game_date = (statement_timestamp() at time zone 'Asia/Seoul')::date + 2 where id = 1 returning status value"), "sold", "postponement does not auto-reopen sold");
    equal(await scalar("update public.ticket_transfers set status = 'reserved' where id = 1206 returning status value"), "reserved", "today owner action unchanged");
    const inserted = await scalar("select public.qa_ticket('open', (statement_timestamp() at time zone 'Asia/Seoul')::date - 1) value");
    equal(await scalar(`select status value from public.ticket_transfers where id = ${Number(inserted)}`), "sold", "old app past-date insert");
    await db.exec("reset role");
    for (const timezone of ["UTC", "Asia/Seoul", "America/Los_Angeles"]) {
      await db.exec(`set timezone = '${timezone}'`);
      equal(await scalar("select (timestamptz '2026-09-07 14:59:59.999+00' at time zone 'Asia/Seoul')::date::text value"), "2026-09-07", `${timezone} before midnight`);
      equal(await scalar("select (timestamptz '2026-09-07 15:00:00+00' at time zone 'Asia/Seoul')::date::text value"), "2026-09-08", `${timezone} after midnight`);
    }
    console.log(`Ticket auto-complete: ${checks} assertions passed (scheduler execution/UI not covered).`);
  } finally {
    await db.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
