#!/usr/bin/env node
/**
 * 야잘알봇 RAG 경로 End-User E2E (match_path 합집합 hotfix 검증용).
 *
 * 하린아빠 개인/공유 계정 사용 금지 → **전용 테스트 계정을 새로 만들어** 실사용 동선을 탄다.
 *  ① 테스트 계정 생성 + 실제 로그인 세션 획득
 *  ② 사용자 세션으로 야잘알봇에게 `구자욱이 누구야?` DM 전송 (send_dm_message_atomic)
 *  ③ production `/api/baseball-qa` 를 그 사용자 토큰으로 호출 (앱이 하는 것과 동일)
 *  ④ job completed / genius_question_logs.match_path='rag' / 봇 답변 DM 이 사용자에게 실제 노출
 *  ⑤ 중복 과금 0 · 중복 발송 0 (동일 messageId 재호출이 새 로그/새 DM 을 만들지 않음)
 *  ⑥ cleanup — 계정·프로필·대화·메시지·로그·job 잔존 0 (실패해도 fail-close 로 보고)
 */
import "./_env.mjs";
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, ANON, SERVICE_ROLE, BASE } from "./_env.mjs";

const GENIUS_ID = "45ae7419-6a9a-4c6b-9101-8d65df7e242e";
const QUESTION = "구자욱이 누구야?";
const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const stamp = Date.now().toString(36);
const email = `qa-genius-rag-${stamp}@keubo.fan`;
const password = `QaGeniusRag!${stamp}`;
let pass = 0;
const failures = [];
let userId = null;
let conversationId = null;
let messageId = null;

function check(name, ok, extra) {
  if (ok) {
    pass += 1;
    console.log(`PASS ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL ${name}${extra ? ` :: ${JSON.stringify(extra)}` : ""}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // ① 전용 테스트 계정
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (createError) throw createError;
  userId = created.user.id;
  const { error: profileError } = await admin
    .from("profiles")
    .insert({ id: userId, nickname: `qGR${stamp}`.slice(0, 12), team_id: 1990 });
  if (profileError) throw profileError;

  const signIn = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!signIn.ok) throw new Error(`sign-in failed: ${signIn.status}`);
  const session = await signIn.json();
  const accessToken = session.access_token;
  const userClient = createClient(SUPABASE_URL, ANON, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  check("test account created + signed in", Boolean(userId && accessToken));

  // ② 실제 유저 세션으로 질문 DM 전송
  // query-guard: bounded -- RPC 시그니처가 (conversation_id, message_id) 한 행만 반환한다
  const { data: sent, error: sendError } = await userClient
    .rpc("send_dm_message_atomic", {
      p_target_user_id: GENIUS_ID,
      p_content: QUESTION,
      p_image_urls: [],
    })
    .single();
  if (sendError) throw sendError;
  // RPC 시그니처: TABLE(conversation_id uuid, message_id bigint)
  conversationId = sent.conversation_id;
  messageId = sent.message_id;
  check("question DM sent by end user", Boolean(conversationId && messageId), sent);

  // ③ production API 호출 (앱과 동일 경로)
  const apiResp = await fetch(`${BASE}/api/baseball-qa`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ conversationId, messageId }),
  });
  const apiBody = await apiResp.json().catch(() => ({}));
  check("POST /api/baseball-qa 200", apiResp.status === 200, { status: apiResp.status, apiBody });
  check("api source=rag", apiBody?.source === "rag", apiBody);

  // ④ job / log / DM 실측
  let job = null;
  for (let i = 0; i < 20; i += 1) {
    const { data } = await admin
      .from("genius_question_jobs")
      .select("message_id,status,attempts,source,last_error,quota_reserved,quota_remaining")
      .eq("message_id", messageId)
      .maybeSingle();
    job = data;
    if (job?.status === "completed") break;
    await sleep(1500);
  }
  check("job completed", job?.status === "completed", job);
  check("job source=rag", job?.source === "rag", job);
  check("job last_error null", !job?.last_error, job);

  // query-guard: bounded -- 방금 만든 일회용 QA 계정 소유 로그만 대상이라 상한 10행이면 충분하다
  const { data: logs } = await admin
    .from("genius_question_logs")
    .select("id,match_path,answer,created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(10);
  check("log rows = 1", (logs?.length ?? 0) === 1, logs);
  check("log match_path=rag", logs?.[0]?.match_path === "rag", logs?.[0]);
  check("log answer non-empty", Boolean(logs?.[0]?.answer?.trim()), logs?.[0]);

  // 사용자 본인 세션에서 실제로 봇 답변이 보이는가 (RLS 통과 = 유저 화면 노출)
  // query-guard: bounded -- 일회용 QA 대화 1개의 메시지만 보며 상한 10행으로 자른다
  const { data: visible } = await userClient
    .from("dm_messages")
    .select("id,sender_id,content,created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(10);
  const botMessages = (visible ?? []).filter((m) => m.sender_id === GENIUS_ID);
  check("bot answer visible to end user", botMessages.length === 1, botMessages);
  check(
    "bot answer non-empty + mentions 구자욱",
    Boolean(botMessages[0]?.content?.trim()) && botMessages[0].content.includes("구자욱"),
    botMessages[0]?.content,
  );

  // ⑤ 중복 과금/발송 0 — 동일 messageId 재호출
  const replay = await fetch(`${BASE}/api/baseball-qa`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ conversationId, messageId }),
  });
  const replayBody = await replay.json().catch(() => ({}));
  check("replay accepted (no 5xx)", replay.status < 500, { status: replay.status, replayBody });

  // query-guard: bounded -- 중복 로그 검출용이라 상한 10행이면 1행 초과를 충분히 잡는다
  const { data: logsAfter } = await admin
    .from("genius_question_logs")
    .select("id")
    .eq("user_id", userId)
    .limit(10);
  check("no duplicate log after replay", (logsAfter?.length ?? 0) === 1, logsAfter?.length);

  // query-guard: bounded -- 중복 봇 DM 검출용이라 일회용 대화의 상한 10행이면 충분하다
  const { data: msgsAfter } = await admin
    .from("dm_messages")
    .select("id,sender_id")
    .eq("conversation_id", conversationId)
    .limit(10);
  const botAfter = (msgsAfter ?? []).filter((m) => m.sender_id === GENIUS_ID);
  check("no duplicate bot DM after replay", botAfter.length === 1, botAfter.length);

  // 과금 원장은 genius_daily_usage(user_id, kst_day, used). 재호출 후에도 used=1 이어야 한다.
  // query-guard: bounded -- 일회용 QA 계정의 당일 원장이라 상한 5행으로 중복까지 잡힌다
  const { data: usageRows } = await admin
    .from("genius_daily_usage")
    .select("kst_day,used")
    .eq("user_id", userId)
    .limit(5);
  check("daily usage row = 1", (usageRows?.length ?? 0) === 1, usageRows);
  check("quota charged exactly once (used=1)", usageRows?.[0]?.used === 1, usageRows);
  check("job quota_reserved true", job?.quota_reserved === true, job);
}

async function cleanup() {
  const problems = [];
  try {
    if (conversationId) {
      await admin.from("dm_messages").delete().eq("conversation_id", conversationId);
      await admin.from("dm_conversations").delete().eq("id", conversationId);
    }
    if (messageId) {
      await admin.from("genius_question_jobs").delete().eq("message_id", messageId);
    }
    if (userId) {
      await admin.from("genius_question_logs").delete().eq("user_id", userId);
      await admin.from("genius_daily_usage").delete().eq("user_id", userId);
      await admin.from("profiles").delete().eq("id", userId);
      await admin.auth.admin.deleteUser(userId);
    }
  } catch (e) {
    problems.push(String(e?.message ?? e));
  }
  // 잔존 0 검증
  if (userId) {
    // query-guard: bounded -- cleanup 잔존 검출용이라 상한 5행이면 0 초과를 잡는다
    const { data: logLeft } = await admin
      .from("genius_question_logs")
      .select("id")
      .eq("user_id", userId)
      .limit(5);
    if ((logLeft?.length ?? 0) !== 0) problems.push(`logs left: ${logLeft.length}`);
    const { data: profLeft } = await admin.from("profiles").select("id").eq("id", userId);
    if ((profLeft?.length ?? 0) !== 0) problems.push(`profile left: ${profLeft.length}`);
    // query-guard: bounded -- cleanup 잔존 검출용이라 상한 5행이면 0 초과를 잡는다
    const { data: usageLeft } = await admin
      .from("genius_daily_usage")
      .select("user_id")
      .eq("user_id", userId)
      .limit(5);
    if ((usageLeft?.length ?? 0) !== 0) problems.push(`daily usage left: ${usageLeft.length}`);
  }
  if (messageId) {
    const { data: jobLeft } = await admin
      .from("genius_question_jobs")
      .select("message_id")
      .eq("message_id", messageId);
    if ((jobLeft?.length ?? 0) !== 0) problems.push(`job left: ${jobLeft.length}`);
  }
  check("cleanup leftover = 0", problems.length === 0, problems);
}

main()
  .catch((e) => {
    failures.push(`fatal: ${e?.message ?? e}`);
    console.log(`FAIL fatal :: ${e?.message ?? e}`);
  })
  .finally(async () => {
    await cleanup();
    console.log(`\n=== ${pass} PASS / ${failures.length} FAIL ===`);
    if (failures.length) console.log(failures.join("\n"));
    process.exit(failures.length ? 1 : 0);
  });
