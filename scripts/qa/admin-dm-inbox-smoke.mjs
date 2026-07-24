#!/usr/bin/env node
import { createClient } from "@supabase/supabase-js";
import { ANON, SERVICE_ROLE, SUPABASE_URL } from "./_env.mjs";

const SYSTEM_USER_ID = process.env.SYSTEM_USER_ID;
const PAGE_SIZE = 50;
const RUNS = 20;

if (!SYSTEM_USER_ID) {
  console.error("[admin-dm-inbox] SYSTEM_USER_ID is required");
  process.exit(1);
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const anon = createClient(SUPABASE_URL, ANON, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let checks = 0;
function check(condition, message) {
  if (!condition) throw new Error(message);
  checks += 1;
}

async function fetchPage(cursor = null) {
  const started = performance.now();
  // query-guard: bounded -- SQL RPC clamps p_limit to 101 rows.
  const { data, error } = await admin.rpc("admin_dm_inbox_page", {
    p_system_user_id: SYSTEM_USER_ID,
    p_cursor_at: cursor?.lastMessageAt ?? null,
    p_cursor_id: cursor?.conversationId ?? null,
    p_limit: PAGE_SIZE + 1,
  });
  if (error) throw error;
  return { rows: data ?? [], elapsedMs: performance.now() - started };
}

function isBefore(row, cursor) {
  return row.last_message_at < cursor.lastMessageAt
    || (row.last_message_at === cursor.lastMessageAt && row.id < cursor.conversationId);
}

async function main() {
  const deniedPage = await anon.rpc("admin_dm_inbox_page", {
    p_system_user_id: SYSTEM_USER_ID,
    p_cursor_at: null,
    p_cursor_id: null,
    p_limit: 1,
  });
  const deniedUnread = await anon.rpc("admin_dm_unread_total", {
    p_system_user_id: SYSTEM_USER_ID,
  });
  check(Boolean(deniedPage.error) && Boolean(deniedUnread.error), "anon RPC execution was not denied");

  const first = await fetchPage();
  check(first.rows.length <= PAGE_SIZE + 1, "page exceeded requested lookahead limit");
  // origin='feedback' 대화는 유저 발신 0건이어도 노출된다(건의함 회신).
  // 노출 자격 정확성은 admin-dm-inbox-feedback-origin.sh(PG17 fixture)가 고정하므로,
  // 여기서는 count 필드가 음수가 아닌지만 불변으로 유지한다.
  check(first.rows.every((row) => Number(row.user_msg_count) >= 0 && Number(row.sys_msg_count) >= 0), "inbox returned negative message counts");
  check(first.rows.every((row, index, rows) => index === 0 || isBefore(row, {
    lastMessageAt: rows[index - 1].last_message_at,
    conversationId: rows[index - 1].id,
  })), "page is not ordered by (last_message_at DESC, id DESC)");

  const visible = first.rows.slice(0, PAGE_SIZE);
  const tail = visible.at(-1);
  if (tail) {
    const cursor = { lastMessageAt: tail.last_message_at, conversationId: tail.id };
    const second = await fetchPage(cursor);
    const firstIds = new Set(visible.map((row) => row.id));
    check(second.rows.every((row) => !firstIds.has(row.id)), "compound cursor returned a duplicate");
    check(second.rows.every((row) => isBefore(row, cursor)), "compound cursor returned an out-of-range row");
  }

  const unreadBefore = await admin.rpc("admin_dm_unread_total", {
    p_system_user_id: SYSTEM_USER_ID,
  });
  const unreadAfter = await admin.rpc("admin_dm_unread_total", {
    p_system_user_id: SYSTEM_USER_ID,
  });
  if (unreadBefore.error || unreadAfter.error) throw unreadBefore.error ?? unreadAfter.error;
  check(Number(unreadBefore.data) === Number(unreadAfter.data), "global unread total changed between pages");

  const timings = [];
  for (let i = 0; i < RUNS; i += 1) timings.push((await fetchPage()).elapsedMs);
  timings.sort((a, b) => a - b);
  const p95 = timings[Math.ceil(timings.length * 0.95) - 1];
  check(first.elapsedMs <= 1000, `cold RPC exceeded 1s: ${first.elapsedMs.toFixed(0)}ms`);
  check(p95 <= 1000, `warm RPC p95 exceeded 1s: ${p95.toFixed(0)}ms`);

  console.log(JSON.stringify({
    checks,
    firstPageRows: first.rows.length,
    unreadTotal: Number(unreadBefore.data),
    coldMs: Math.round(first.elapsedMs),
    warmP95Ms: Math.round(p95),
  }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
