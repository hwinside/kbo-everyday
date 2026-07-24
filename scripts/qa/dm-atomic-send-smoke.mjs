#!/usr/bin/env node
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, ANON, SERVICE_ROLE } from "./_env.mjs";

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const stamp = Date.now().toString(36);
const password = `QaDmAtomic!${stamp}`;
const userIds = [];
let checks = 0;

function check(condition, message) {
  if (!condition) throw new Error(message);
  checks += 1;
}

async function createUser(index) {
  const email = `qa-dm-atomic-${index}-${stamp}@keubo.fan`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  userIds.push(data.user.id);
  const { error: profileError } = await admin.from("profiles").insert({
    id: data.user.id,
    nickname: `qDA${index}${stamp}`.slice(0, 12),
    team_id: index === 0 ? 1990 : 2002,
  });
  if (profileError) throw profileError;

  const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) throw new Error(`sign-in failed: ${response.status}`);
  const session = await response.json();
  const client = createClient(SUPABASE_URL, ANON, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${session.access_token}` } },
  });
  return { id: data.user.id, client };
}

async function conversationBetween(a, b) {
  const [u1, u2] = [a, b].sort();
  const { data, error } = await admin
    .from("dm_conversations")
    .select("id, last_message, last_message_at")
    .eq("user1_id", u1)
    .eq("user2_id", u2)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function send(client, targetId, content) {
  // query-guard: bounded -- RPC는 방 id와 메시지 id 한 행만 반환한다.
  return client
    .rpc("send_dm_message_atomic", {
      p_target_user_id: targetId,
      p_content: content,
      p_image_urls: [],
    })
    .single();
}

async function main() {
  const a = await createUser(0);
  const b = await createUser(1);

  await admin.from("user_blocks").insert({ blocker_id: a.id, blocked_id: b.id });
  const [blockedA, blockedB] = await Promise.all([
    send(a.client, b.id, "blocked-a"),
    send(b.client, a.id, "blocked-b"),
  ]);
  check(Boolean(blockedA.error) && Boolean(blockedB.error), "bidirectional block did not reject both sends");
  check(!(await conversationBetween(a.id, b.id)), "blocked first send left an empty room");
  await admin.from("user_blocks").delete().eq("blocker_id", a.id).eq("blocked_id", b.id);

  const [firstA, firstB] = await Promise.all([
    send(a.client, b.id, "concurrent-a"),
    send(b.client, a.id, "concurrent-b"),
  ]);
  check(!firstA.error && !firstB.error, "concurrent first sends failed");
  check(firstA.data?.conversation_id === firstB.data?.conversation_id, "concurrent sends created different rooms");

  const conversation = await conversationBetween(a.id, b.id);
  check(Boolean(conversation), "atomic send did not create a room");
  // query-guard: bounded -- 일회용 QA 대화의 최대 10개 메시지만 검증한다.
  const { data: messages, error: messageError } = await admin
    .from("dm_messages")
    .select("id, content, created_at")
    .eq("conversation_id", conversation.id)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(10);
  if (messageError) throw messageError;
  check(messages.length === 2, `concurrent first sends expected 2 messages, got ${messages.length}`);
  check(conversation.last_message === messages[0].content, "preview does not match the latest concurrent message");

  const { error: directError } = await a.client.from("dm_messages").insert({
    conversation_id: conversation.id,
    sender_id: a.id,
    content: "trigger-preview",
  });
  if (directError) throw directError;
  const afterTrigger = await conversationBetween(a.id, b.id);
  check(afterTrigger?.last_message === "trigger-preview", "message trigger did not update preview atomically");

  console.log(`dm atomic send smoke: ${checks}/${checks} PASS`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (userIds.length === 2) {
      const conversation = await conversationBetween(userIds[0], userIds[1]);
      if (conversation) await admin.from("dm_conversations").delete().eq("id", conversation.id);
      await admin.from("user_blocks").delete().eq("blocker_id", userIds[0]).eq("blocked_id", userIds[1]);
    }
    if (userIds.length) await admin.from("profiles").delete().in("id", userIds);
    for (const id of userIds) await admin.auth.admin.deleteUser(id);
  });
