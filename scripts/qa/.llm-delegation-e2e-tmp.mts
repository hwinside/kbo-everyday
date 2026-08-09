// #1139 LLM 위임 3시나리오 E2E — 브랜치 코드(processBaseballQaQuestion)를 로컬 실행,
// DB·Gemini 는 Production 실물. preview 가 Vercel SSO 로 막혀 있어(실측 302) 이 방식.
// 전용 테스트 계정 생성 → 실 DM → 실 파이프라인 → 답변 실측 → cleanup.
import "./_env.mjs";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const GENIUS_ID = "45ae7419-6a9a-4c6b-9101-8d65df7e242e";
const UNSURE = "질문을 정확히 이해하지 못했어요";

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });
const stamp = Date.now().toString(36);
const email = `qa-llmdel-${stamp}@keubo.fan`;
const password = `QaLlmDel!${stamp}A9`;
let userId: string | null = null;
let conversationId: string | null = null;
const messageIds: number[] = [];
let pass = 0; const failures: string[] = [];
function check(name: string, ok: boolean, extra?: unknown) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { failures.push(name); console.log(`FAIL ${name} :: ${JSON.stringify(extra ?? null)}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { processBaseballQaQuestion } = await import("../../src/lib/baseball-qa/server");
  const { data: created, error: ce } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (ce) throw ce;
  userId = created.user.id;
  const { error: pe } = await admin.from("profiles").insert({ id: userId, nickname: `qLD${stamp}`.slice(0, 12), team_id: 1990 });
  if (pe) throw pe;
  const signIn = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const session = await signIn.json();
  const userClient = createClient(SUPABASE_URL, ANON, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${session.access_token}` } },
  });
  check("계정 생성+로그인", Boolean(userId && session.access_token));

  async function ask(question: string): Promise<string> {
    const { data: sent, error: se } = await userClient
      .rpc("send_dm_message_atomic", { p_target_user_id: GENIUS_ID, p_content: question, p_image_urls: [] })
      .single();
    if (se) throw se;
    conversationId = (sent as { conversation_id: string }).conversation_id;
    const messageId = Number((sent as { message_id: number }).message_id);
    messageIds.push(messageId);
    await processBaseballQaQuestion({ messageId, conversationId: conversationId!, userId: userId!, question });
    for (let i = 0; i < 10; i++) {
      // query-guard: bounded -- 일회용 QA 대화의 봇 답변 1건 조회
      const { data } = await admin.from("dm_messages")
        .select("content,sender_id,created_at").eq("conversation_id", conversationId!)
        .eq("sender_id", GENIUS_ID).order("created_at", { ascending: false }).limit(1);
      if (data?.[0] && messageIds.length > 0) return data[0].content as string;
      await sleep(1000);
    }
    return "";
  }

  // S1: 기아 1군 선수 (팀 명단 — roster SSOT + 1군 fail-close 라벨)
  const a1 = await ask("기아 1군 선수");
  console.log("A1:", a1);
  check("S1 답변이 unsure 아님", !a1.includes(UNSURE) && a1.trim().length > 0, a1);
  check("S1 이적 선수(최형우)를 현재 명단으로 말하지 않음", !a1.includes("최형우"), a1);

  // S2: 정정 발화 — 인정·정정 (00:53 캡처 재현)
  const a2 = await ask("최형우는 현재 삼성 라이온즈 소속인데??");
  console.log("A2:", a2);
  check("S2 정정에 모르겠다로 답하지 않음", !a2.includes(UNSURE) && a2.trim().length > 0, a2);
  check("S2 삼성 소속 인정", a2.includes("삼성"), a2);
  check("S2 역정정 없음 (삼성이 아니라고 말하지 않음)", !/삼성[^.]{0,12}(아니|않)/.test(a2) && !/(KIA|기아)[^.]{0,10}소속으로/.test(a2), a2);

  // S3: 입단 질문 + 짧은 후속 (축 A)
  const a3 = await ask("임찬규는 언제 어느팀에 입단했어?");
  console.log("A3:", a3);
  check("S3 답변이 unsure 아님", !a3.includes(UNSURE) && a3.trim().length > 0, a3);
  const a4 = await ask("언제?");
  console.log("A4:", a4);
  check("S3 후속 `언제?` 가 unsure 아님 (직전 맥락 결속)", !a4.includes(UNSURE) && a4.trim().length > 0, a4);

  // 진단: 각 질문의 match_path·job source
  const { data: diagLogs } = await admin.from("genius_question_logs")
    .select("question,match_path,created_at").eq("user_id", userId!)
    .order("created_at", { ascending: true }).limit(10);
  console.log("DIAG logs:", JSON.stringify(diagLogs));
  const { data: diagJobs } = await admin.from("genius_question_jobs")
    .select("message_id,status,source,last_error").in("message_id", messageIds).limit(10);
  console.log("DIAG jobs:", JSON.stringify(diagJobs));
  console.log(failures.length ? `❌ FAIL ${failures.length}: ${failures.join(", ")}` : `✅ E2E PASS (${pass} checks)`);
  process.exitCode = failures.length ? 1 : 0;
}

async function cleanup() {
  try {
    if (conversationId) {
      await admin.from("dm_messages").delete().eq("conversation_id", conversationId);
      await admin.from("dm_conversations").delete().eq("id", conversationId);
    }
    if (userId) {
      await admin.from("genius_question_jobs").delete().in("message_id", messageIds.length ? messageIds : [-1]);
      await admin.from("genius_question_logs").delete().eq("user_id", userId);
      await admin.from("profiles").delete().eq("id", userId);
      await admin.auth.admin.deleteUser(userId);
    }
    console.log("cleanup done");
  } catch (e) { console.error("cleanup FAILED:", e); process.exitCode = 1; }
}

main().catch((e) => { console.error("E2E error:", e); process.exitCode = 1; }).finally(cleanup);
