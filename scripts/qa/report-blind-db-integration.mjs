/**
 * 신고 자동 블라인드 + outbox DB 실통합 테스트 (삼순 2차 NO-GO 반영 검증).
 *
 * ⚠️ 실행 전제: 마이그레이션 20260720_report_blind_notice.sql + 20260720_report_blind_notice_v2.sql
 *    가 대상 프로젝트에 **선적용**되어 있어야 한다(report_blind_notices/claim RPC/dm dedup_key +
 *    race-free · block-제외 트리거). 미적용 상태에서는 실행하지 않는다.
 *
 * ⚠️ 실사용자 무영향: 이 테스트는 자체 생성한 throwaway 계정(auth.users + profiles)만 쓴다.
 *    실제 유저에게 쪽지가 가지 않으며(발송 경로는 상태머신 시뮬레이션으로만 검증), 시작·종료 시
 *    생성 계정/행을 전부 삭제한다(auth.users 삭제 → profiles CASCADE).
 *
 * 검증 경로(인메모리 스모크가 못 하는 실 DB):
 *   ① 임계값 미만(2건) → 블라인드 안 됨 + outbox 없음
 *   ② 3번째 직접 신고 → 신고 insert 와 같은 트랜잭션(트리거)에서 블라인드 전환 + outbox 1건
 *   ③(멱등) 4번째 → outbox 여전히 1건, deleted_at 불변
 *   ④ 댓글 경로: 3건 → is_hidden + outbox
 *   ⑤ block 스코프 제외: 2 직접 + 1 block(reason='block') → 블라인드 안 됨(직접 2명뿐)
 *   ⑥ claim lease: pending → claim 1건 반환(attempts++·claimed_at), 즉시 재claim 0건(lease),
 *      claim 해제 후 재claim 가능, notified_at/attempts>=MAX 제외
 *
 * 실행: node scripts/qa/report-blind-db-integration.mjs
 */
import "./_env.mjs";
import { randomUUID } from "node:crypto";
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

async function report(type, id, reporterId, reason = "abuse") {
  const { error } = await admin
    .from("reports")
    .insert({ reporter_id: reporterId, target_type: type, target_id: id, reason });
  if (error) throw new Error(`report insert failed: ${error.message}`);
}

// ── throwaway 계정 생성/삭제 (실사용자 무영향) ────────────────────────────
async function createTestUser(tag) {
  const email = `qa+report-blind-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@keubo.test`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: randomUUID(),
    email_confirm: true,
  });
  if (error || !data?.user) throw new Error(`createUser failed: ${error?.message}`);
  const id = data.user.id;
  // profiles 는 트리거로 자동 생성될 수 있어 upsert(없으면 삽입, 있으면 유지).
  const { error: pErr } = await admin
    .from("profiles")
    .upsert({ id, nickname: `qa-${tag}`, team_id: 1, is_bot: false }, { onConflict: "id" });
  if (pErr) throw new Error(`profile upsert failed: ${pErr.message}`);
  return id;
}

async function run() {
  const users = {};
  const chatIds = [];
  const commentIds = [];

  try {
    for (const tag of ["author", "r1", "r2", "r3", "r4"]) {
      users[tag] = await createTestUser(tag);
    }
    const { author, r1, r2, r3, r4 } = users;

    // ── 테스트 chat 메시지 ──
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

    // ② 3번째 직접 신고 → 블라인드 전환 + outbox 적재
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

    // ⑤ block 스코프 제외: 2 직접 + 1 block → 직접 2명뿐 → 블라인드 안 됨
    const { data: msg2, error: m2Err } = await admin
      .from("chat_messages")
      .insert({ room_id: ROOM, user_id: author, content: "차단 자동신고 스코프 테스트" })
      .select("id")
      .single();
    if (m2Err || !msg2) throw new Error(`chat insert2 failed: ${m2Err?.message}`);
    const chatId2 = msg2.id;
    chatIds.push(chatId2);
    await report("chat", chatId2, r1); // 직접 1
    await report("chat", chatId2, r2); // 직접 2
    await report("chat", chatId2, r3, "block"); // 차단 자동 (제외 대상)
    {
      const { data: m } = await admin.from("chat_messages").select("deleted_at").eq("id", chatId2).single();
      const { count } = await admin
        .from("report_blind_notices")
        .select("id", { count: "exact", head: true })
        .eq("target_type", "chat")
        .eq("target_id", chatId2);
      check("⑤ 직접2+block1: 블라인드 안 됨(block 제외)", m?.deleted_at == null, { deleted_at: m?.deleted_at });
      check("⑤ 직접2+block1: outbox 없음", (count ?? 0) === 0, { count });
      // 직접 3번째 → 블라인드 전환(block 미포함 3)
      await report("chat", chatId2, r4);
      const { data: m2 } = await admin.from("chat_messages").select("deleted_at").eq("id", chatId2).single();
      check("⑤ 직접3(block 무관): 블라인드됨", m2?.deleted_at != null);
    }

    // ⑥ claim lease 상태머신 (chat outbox 행으로 검증)
    // 이전 상태 초기화(테스트 재현성) — claimed_at/attempts 리셋
    await admin
      .from("report_blind_notices")
      .update({ claimed_at: null, attempts: 0, notified_at: null })
      .eq("target_type", "chat")
      .eq("target_id", chatId);
    {
      // 1차 claim → 1건 반환, attempts=1, claimed_at 세팅
      const { data: c1, error: e1 } = await admin.rpc("claim_report_blind_notices", {
        p_limit: 50,
        p_max_attempts: MAX_ATTEMPTS,
      });
      if (e1) throw new Error(`claim rpc failed: ${e1.message}`);
      const mine1 = (c1 ?? []).filter((r) => r.target_type === "chat" && r.target_id === chatId);
      check("⑥ 1차 claim: 대상 1건 반환", mine1.length === 1, { len: mine1.length });
      check("⑥ 1차 claim: attempts=1", mine1[0]?.attempts === 1, { a: mine1[0]?.attempts });
      check("⑥ 1차 claim: claimed_at 세팅", mine1[0]?.claimed_at != null);

      // 2차 즉시 claim → lease 로 같은 행 제외
      const { data: c2 } = await admin.rpc("claim_report_blind_notices", { p_limit: 50, p_max_attempts: MAX_ATTEMPTS });
      const mine2 = (c2 ?? []).filter((r) => r.target_type === "chat" && r.target_id === chatId);
      check("⑥ 2차 즉시 claim: lease 로 제외(0건)", mine2.length === 0, { len: mine2.length });

      // claim 해제(발송 실패 시뮬) → 재claim 가능
      await admin.from("report_blind_notices").update({ claimed_at: null }).eq("target_type", "chat").eq("target_id", chatId);
      const { data: c3 } = await admin.rpc("claim_report_blind_notices", { p_limit: 50, p_max_attempts: MAX_ATTEMPTS });
      const mine3 = (c3 ?? []).filter((r) => r.target_type === "chat" && r.target_id === chatId);
      check("⑥ 해제 후 재claim 가능(1건)", mine3.length === 1, { len: mine3.length });
      check("⑥ 재claim attempts 증가(=2)", mine3[0]?.attempts === 2, { a: mine3[0]?.attempts });

      // attempts>=MAX → claim 제외
      await admin
        .from("report_blind_notices")
        .update({ attempts: MAX_ATTEMPTS, claimed_at: null })
        .eq("target_type", "chat")
        .eq("target_id", chatId);
      const { data: c4 } = await admin.rpc("claim_report_blind_notices", { p_limit: 50, p_max_attempts: MAX_ATTEMPTS });
      const mine4 = (c4 ?? []).filter((r) => r.target_type === "chat" && r.target_id === chatId);
      check("⑥ attempts>=MAX: claim 제외", mine4.length === 0, { len: mine4.length });

      // notified_at 세팅 → claim 제외
      await admin
        .from("report_blind_notices")
        .update({ attempts: 1, claimed_at: null, notified_at: new Date().toISOString() })
        .eq("target_type", "chat")
        .eq("target_id", chatId);
      const { data: c5 } = await admin.rpc("claim_report_blind_notices", { p_limit: 50, p_max_attempts: MAX_ATTEMPTS });
      const mine5 = (c5 ?? []).filter((r) => r.target_type === "chat" && r.target_id === chatId);
      check("⑥ notified_at 세팅: claim 제외", mine5.length === 0, { len: mine5.length });
    }
  } finally {
    // 생성 행 정리
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
    // throwaway 계정 삭제(profiles CASCADE)
    for (const id of Object.values(users)) {
      await admin.auth.admin.deleteUser(id).catch(() => {});
    }
  }
}

run()
  .then(() => {
    console.log(`\nreport-blind DB integration: ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error("FATAL", e);
    process.exit(1);
  });
