/**
 * 신고 자동 블라인드 + outbox DB 실통합 테스트 (삼순 NO-GO 반영 검증).
 *
 * ⚠️ 실행 전제: 마이그레이션 `supabase/migrations/20260720_report_blind_notice.sql`가
 *    대상 프로젝트에 **선적용**되어 있어야 한다(report_blind_notices 테이블 + 확장된
 *    auto_blind_on_report 트리거). 미적용 상태에서는 실행하지 않는다.
 *
 * 인메모리 스모크(report-blind-smoke.ts)가 재현 못 하는 실 DB 경로를 검증:
 *   ① 임계값 미만(2건) → 블라인드 안 됨 + outbox 없음
 *   ② 3번째 신고 → 신고 insert 와 같은 트랜잭션(트리거)에서 블라인드 전환
 *      (chat: deleted_at + content 마스킹) + outbox 1건 적재(author_id/notified_at NULL)
 *   ③ 4번째 신고 → 멱등(outbox 여전히 1건, 블라인드 유지) — 동시 전환 1회 보장의 관측 결과
 *   ④ 댓글 경로: 3건 → is_hidden + outbox (기존 자동숨김 동작 유지 + outbox 추가)
 *   ⑤ outbox 재시도 상태머신: 미발송 조회 → 실패 시 attempts++ 유지(재시도) →
 *      attempts>=MAX 제외 → 발송 성공(notified_at) 제외
 *
 * 실행: node scripts/qa/report-blind-db-integration.mjs
 * 정리: 테스트가 생성한 chat/comment/reports/outbox 행만 시작·종료 시 삭제(실데이터 무손상).
 */
import "./_env.mjs";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const ROOM = "test:report-blind-qa";
const MAX_ATTEMPTS = 10; // 크론과 동일 상한

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error(`  ✗ ${name}${extra ? " — " + JSON.stringify(extra) : ""}`);
  }
}

async function cleanup(chatIds, commentIds) {
  for (const id of chatIds) {
    await admin.from("reports").delete().eq("target_type", "chat").eq("target_id", id);
    await admin.from("report_blind_notices").delete().eq("target_type", "chat").eq("target_id", id);
    await admin.from("chat_messages").delete().eq("id", id);
  }
  for (const id of commentIds) {
    await admin.from("reports").delete().eq("target_type", "comment").eq("target_id", id);
    await admin.from("report_blind_notices").delete().eq("target_type", "comment").eq("target_id", id);
    await admin.from("comments").delete().eq("id", id);
  }
}

async function report(type, id, reporterId, reason = "abuse") {
  const { error } = await admin
    .from("reports")
    .insert({ reporter_id: reporterId, target_type: type, target_id: id, reason });
  if (error) throw new Error(`report insert failed: ${error.message}`);
}

async function run() {
  // 리포터/작성자용 실제 profile id 확보(FK 충족). 시스템계정 제외.
  const { data: profs, error: pErr } = await admin
    .from("profiles")
    .select("id")
    .eq("is_bot", false)
    .neq("id", "7b58d68e-e212-40aa-a96d-5018cb82cc81")
    .limit(6);
  if (pErr || !profs || profs.length < 5) throw new Error("need >=5 real profiles for test");
  const [author, r1, r2, r3, r4] = profs.map((p) => p.id);

  const chatIds = [];
  const commentIds = [];

  try {
    // ── 테스트 chat 메시지 생성 ──
    const { data: msg, error: mErr } = await admin
      .from("chat_messages")
      .insert({ room_id: ROOM, user_id: author, content: "테스트용 신고대상 메시지" })
      .select("id")
      .single();
    if (mErr || !msg) throw new Error(`chat insert failed: ${mErr?.message}`);
    const chatId = msg.id;
    chatIds.push(chatId);

    // ① 임계값 미만(2건)
    await report("chat", chatId, r1);
    await report("chat", chatId, r2);
    {
      const { data: m } = await admin.from("chat_messages").select("deleted_at").eq("id", chatId).single();
      const { count } = await admin
        .from("report_blind_notices")
        .select("id", { count: "exact", head: true })
        .eq("target_type", "chat")
        .eq("target_id", chatId);
      check("① 2건: 블라인드 안 됨", m?.deleted_at == null, { deleted_at: m?.deleted_at });
      check("① 2건: outbox 없음", (count ?? 0) === 0, { count });
    }

    // ② 3번째 신고 → 블라인드 전환 + outbox 적재
    await report("chat", chatId, r3);
    {
      const { data: m } = await admin
        .from("chat_messages")
        .select("deleted_at, content, deleted_by")
        .eq("id", chatId)
        .single();
      const { data: ob } = await admin
        .from("report_blind_notices")
        .select("author_id, notified_at, attempts")
        .eq("target_type", "chat")
        .eq("target_id", chatId);
      check("② 3건: 블라인드됨(deleted_at)", m?.deleted_at != null);
      check("② 3건: content 마스킹", m?.content === "삭제된 메시지입니다", { content: m?.content });
      check("② 3건: deleted_by=시스템", m?.deleted_by === "7b58d68e-e212-40aa-a96d-5018cb82cc81");
      check("② 3건: outbox 1건", (ob?.length ?? 0) === 1, { len: ob?.length });
      check("② 3건: outbox author_id=작성자", ob?.[0]?.author_id === author);
      check("② 3건: outbox 미발송(notified_at null)", ob?.[0]?.notified_at == null);
    }

    // ③ 4번째 신고 → 멱등(outbox 여전히 1건, deleted_at 불변)
    const beforeDel = (await admin.from("chat_messages").select("deleted_at").eq("id", chatId).single()).data?.deleted_at;
    await report("chat", chatId, r4);
    {
      const { count } = await admin
        .from("report_blind_notices")
        .select("id", { count: "exact", head: true })
        .eq("target_type", "chat")
        .eq("target_id", chatId);
      const afterDel = (await admin.from("chat_messages").select("deleted_at").eq("id", chatId).single()).data?.deleted_at;
      check("③ 4건: outbox 여전히 1건(멱등)", (count ?? 0) === 1, { count });
      check("③ 4건: deleted_at 불변(재전환 없음)", beforeDel === afterDel);
    }

    // ④ 댓글 경로: 3건 → is_hidden + outbox
    const { data: cmt, error: cErr } = await admin
      .from("comments")
      .insert({ content: "테스트 댓글", author_id: author })
      .select("id")
      .single();
    if (cErr || !cmt) throw new Error(`comment insert failed: ${cErr?.message}`);
    const commentId = cmt.id;
    commentIds.push(commentId);
    await report("comment", commentId, r1);
    await report("comment", commentId, r2);
    await report("comment", commentId, r3);
    {
      const { data: c } = await admin.from("comments").select("is_hidden, report_count").eq("id", commentId).single();
      const { data: ob } = await admin
        .from("report_blind_notices")
        .select("author_id")
        .eq("target_type", "comment")
        .eq("target_id", commentId);
      check("④ 댓글 3건: is_hidden=true", c?.is_hidden === true, { c });
      check("④ 댓글 3건: report_count>=3", (c?.report_count ?? 0) >= 3);
      check("④ 댓글 3건: outbox 1건 + author", (ob?.length ?? 0) === 1 && ob?.[0]?.author_id === author);
    }

    // ⑤ outbox 재시도 상태머신 (chat outbox 행으로 검증)
    const pending = () =>
      admin
        .from("report_blind_notices")
        .select("id")
        .is("notified_at", null)
        .lt("attempts", MAX_ATTEMPTS)
        .eq("target_type", "chat")
        .eq("target_id", chatId);
    {
      let { data } = await pending();
      check("⑤ 미발송+attempts<MAX 는 pending", (data?.length ?? 0) === 1);

      // 실패 시뮬: attempts++ → 여전히 pending(재시도 유지)
      await admin.from("report_blind_notices").update({ attempts: 3, last_error: "send_failed" }).eq("target_type", "chat").eq("target_id", chatId);
      ({ data } = await pending());
      check("⑤ 실패 attempts=3 여전히 pending(재시도)", (data?.length ?? 0) === 1);

      // attempts>=MAX → pending 제외
      await admin.from("report_blind_notices").update({ attempts: MAX_ATTEMPTS }).eq("target_type", "chat").eq("target_id", chatId);
      ({ data } = await pending());
      check("⑤ attempts>=MAX pending 제외", (data?.length ?? 0) === 0);

      // 발송 성공 시뮬: notified_at 세팅 → pending 제외
      await admin.from("report_blind_notices").update({ attempts: 4, notified_at: new Date().toISOString() }).eq("target_type", "chat").eq("target_id", chatId);
      ({ data } = await pending());
      check("⑤ notified_at 세팅 후 pending 제외", (data?.length ?? 0) === 0);
    }
  } finally {
    await cleanup(chatIds, commentIds);
  }
}

run()
  .then(() => {
    console.log(`\nreport-blind DB integration: ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
  })
  .catch(async (e) => {
    console.error("FATAL", e);
    process.exit(1);
  });
