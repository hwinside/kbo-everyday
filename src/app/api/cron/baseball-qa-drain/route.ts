import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { processBaseballQaQuestion } from "@/lib/baseball-qa/server";

const CRON_SECRET = process.env.CRON_SECRET || "";
const MAX_DRAIN_ATTEMPTS = 5;
const DRAIN_BATCH = 5;

export const maxDuration = 60;

/**
 * 야잘알봇 질문 job durable drainer (삼순 3차 NO-GO P0 반영).
 *
 * 질문 DM INSERT와 같은 트랜잭션에서 trigger가 genius_question_jobs 를 만들기 때문에,
 * send_dm_message_atomic 커밋 직후 앱 종료/응답 단절로 브라우저가 /api/baseball-qa 를
 * 한 번도 못 불러도 job은 남는다. 이 크론이 due job(queued / lease 만료 processing /
 * ready / failed<재시도 상한)을 재획득해 끝까지 처리한다. claim RPC와 messageId 단위
 * idempotent quota/LLM 저장 덕에 즉시 경로와 경합해도 중복 소비·중복 답변이 없다.
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // query-guard: bounded -- due job은 배치당 최대 5건만 처리한다.
  const { data: jobs, error } = await supabaseAdmin
    .from("genius_question_jobs")
    .select("message_id, conversation_id, user_id, status, attempts")
    .in("status", ["queued", "processing", "ready", "failed"])
    .lt("lease_until", new Date().toISOString())
    .lt("attempts", MAX_DRAIN_ATTEMPTS)
    .order("created_at", { ascending: true })
    .limit(DRAIN_BATCH);
  if (error) {
    console.error("baseball-qa drain query failed:", error.message);
    return NextResponse.json({ error: "drain query failed" }, { status: 503 });
  }

  const summary = { picked: jobs?.length ?? 0, completed: 0, pending: 0, failed: 0 };
  for (const job of jobs ?? []) {
    const { data: message } = await supabaseAdmin
      .from("dm_messages")
      .select("id, content")
      .eq("id", job.message_id)
      .eq("conversation_id", job.conversation_id)
      .eq("sender_id", job.user_id)
      .maybeSingle();
    if (!message) {
      // 원본 질문이 사라진 job은 재시도 무의미 — 종결 처리.
      await supabaseAdmin
        .from("genius_question_jobs")
        .update({
          status: "failed",
          last_error: "message_missing",
          attempts: MAX_DRAIN_ATTEMPTS,
          updated_at: new Date().toISOString(),
        })
        .eq("message_id", job.message_id);
      summary.failed++;
      continue;
    }
    const outcome = await processBaseballQaQuestion({
      messageId: Number(job.message_id),
      conversationId: job.conversation_id,
      userId: job.user_id,
      question: message.content ?? "",
    });
    if (outcome.kind === "completed") summary.completed++;
    else if (outcome.kind === "pending") summary.pending++;
    else summary.failed++;
  }
  return NextResponse.json({ ok: true, ...summary });
}
