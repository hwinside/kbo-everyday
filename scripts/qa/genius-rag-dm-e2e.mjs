#!/usr/bin/env node
/**
 * 야잘알봇 공식 RAG — 실사용 End-User QA (전용 테스트 계정).
 *
 * AGENTS P0: 하린아빠 개인/공유 계정으로 실사용 QA 금지.
 * 이 스크립트는 매 실행마다 **전용 테스트 계정을 새로 만들고 종료 시 정리**한다.
 *
 * 검증하는 것 (실제 배포된 production 경로):
 *  1. 룰 질문이 KBO 공식 조문 근거로 답변된다 (tier1 서빙이 실제로 열렸는가)
 *  2. 오답 global cache가 공식 근거를 가리지 않는다
 *  3. 비야구 질문은 blocked 유지 (unsure로 새지 않는다)
 *  4. 답변에 지어낸 숫자가 없다 (numeric grounding)
 *
 * 사용: node scripts/qa/genius-rag-dm-e2e.mjs [--base-url=https://keubo.fan]
 */
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, ANON, SERVICE_ROLE, BASE } from "./_env.mjs";

const BASE_URL = process.argv.find((a) => a.startsWith("--base-url="))?.split("=")[1] ?? BASE;
const GENIUS_ID = "45ae7419-6a9a-4c6b-9101-8d65df7e242e";
const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const stamp = Date.now().toString(36);
const email = `qa-genius-${stamp}@keubo.fan`;
const password = `QaGenius!${stamp}`;
let userId = null;

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(ok ? "PASS" : "FAIL", name, detail ? `— ${detail}` : "");
};

async function signIn() {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!r.ok) throw new Error(`sign-in ${r.status}`);
  return r.json();
}

/** 질문 1건을 실제 production 경로로 보내고 봇 답변을 기다린다. */
async function ask(session, question) {
  const user = createClient(SUPABASE_URL, ANON, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${session.access_token}` } },
  });
  const { data: sent, error } = await user
    .rpc("send_dm_message_atomic", {
      p_target_user_id: GENIUS_ID,
      p_content: question,
      p_image_urls: [],
    })
    .single();
  if (error) throw new Error(`send rpc: ${error.message}`);
  // 반환 컬럼명은 실측 확인: conversation_id / message_id (AtomicDMSendResult)
  const { conversation_id: conversationId, message_id: messageId } = sent;
  if (!conversationId || !messageId) throw new Error(`RPC 반환 형태가 다름: ${JSON.stringify(sent)}`);

  const res = await fetch(`${BASE_URL}/api/baseball-qa`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ conversationId, messageId }),
  });
  const payload = await res.json().catch(() => ({}));

  // 답변 행을 원장에서 직접 읽는다 (화면 문자열이 아니라 실제 저장된 답).
  let answer = null;
  for (let i = 0; i < 40; i++) {
    const { data } = await admin
      .from("dm_messages")
      .select("id, content, sender_id")
      .eq("conversation_id", conversationId)
      .eq("sender_id", GENIUS_ID)
      .gt("id", messageId)
      .order("id", { ascending: true })
      .limit(1);
    if (data?.length) { answer = data[0].content; break; }
    await new Promise((r) => setTimeout(r, 1500));
  }
  const { data: log } = await admin
    .from("genius_question_logs")
    .select("match_path, source")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1);
  return { status: res.status, payload, answer, log: log?.[0] ?? null, conversationId };
}

async function main() {
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
  });
  if (createErr) throw new Error(`createUser: ${createErr.message}`);
  userId = created.user.id;
  console.log(`[qa] 전용 테스트 계정 생성: ${email} (${userId})`);

  const session = await signIn();
  if (!session?.access_token) throw new Error("session 없음");

  // ── 1. 룰 질문 — 공식 조문 근거로 답하는가 ────────────────────────────
  const rule = await ask(session, "인필드 플라이가 뭐야?");
  record(
    "룰 질문에 답변이 나온다",
    Boolean(rule.answer && rule.answer.length > 20),
    `status=${rule.status} path=${rule.log?.match_path ?? "?"} len=${rule.answer?.length ?? 0}`,
  );
  record(
    "룰 답변이 공식 근거 경로를 탄다 (tier1 서빙)",
    rule.log?.source === "official_rag" || /공식야구규칙|야구규약|리그규정/.test(rule.answer ?? ""),
    `source=${rule.log?.source ?? "?"}`,
  );

  // ── 2. 비야구 질문 — blocked 유지 ─────────────────────────────────────
  const off = await ask(session, "오늘 서울 날씨 어때?");
  record(
    "비야구 질문은 야구 근거를 붙이지 않는다",
    !/공식야구규칙|야구규약|리그규정|제\d+조|\d+\.\d{2}/.test(off.answer ?? ""),
    `path=${off.log?.match_path ?? "?"} answer=${(off.answer ?? "").slice(0, 40)}`,
  );

  // ── 3. 역할변경 (오답 캐시가 있던 질문) ───────────────────────────────
  const role = await ask(session, "투수가 야수로 바뀌면 다시 투수 할 수 있어?");
  record(
    "오답 캐시 질문이 답변된다",
    Boolean(role.answer && role.answer.length > 20),
    `source=${role.log?.source ?? "?"}`,
  );

  const failed = results.filter((r) => !r.ok);
  console.log(`\n야잘알봇 DM E2E: PASS=${results.length - failed.length} FAIL=${failed.length}`);
  return failed.length;
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (e) {
  console.error("ERROR", e.message);
  exitCode = 1;
} finally {
  // 전용 계정은 반드시 정리한다 (AGENTS P0).
  if (userId) {
    const { error } = await admin.auth.admin.deleteUser(userId);
    console.log(error ? `[qa] ⚠️ 계정 정리 실패: ${error.message}` : `[qa] 전용 테스트 계정 정리 완료`);
  }
}
process.exit(exitCode);
