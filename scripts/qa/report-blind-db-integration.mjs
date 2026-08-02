/**
 * 신고 자동 블라인드 + outbox DB fault matrix.
 *
 * ⚠️ prod-ref HARD BLOCK: 격리 Supabase branch/local DB에서만 실행한다.
 * 실행 전제: v1 + v2 migration 적용, REPORT_BLIND_TEST_ALLOW_ISOLATED=1.
 *
 * 실제 production 경로 검증:
 *  ① anon/authenticated claim RPC 거부 + authenticated dedup_key 선점 거부
 *  ② 병렬 신고 3건 → 원자 블라인드/outbox 1건
 *  ③ 동시 claim → 동일 outbox 정확히 1회 lease
 *  ④ attempts=9 최종 claim 뒤 DM 성공→완료 전 crash → exhausted reconcile 완료
 *  ⑤ attempts=9 최종 claim 뒤 DM 전 crash → exhausted reconcile dead-letter + requeue
 *  ⑥ reason=block 제외 + comment 기존 경로 유지
 *  ⑦ teardown 오류 fail-closed + 생성 데이터/계정 잔존 0
 */
import "./_env.mjs";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import {
  sendOpsMessageToUser,
  verifyOpsMessageByDedupKey,
} from "../../src/lib/cs/send-ops-message.ts";
import {
  blindTargetLabel,
  buildBlindNotice,
} from "../../src/lib/moderation/report-blind.ts";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const TEST_API_KEY = process.env.SUPABASE_TEST_API_KEY || ANON_KEY;
const MANAGEMENT_TOKEN = process.env.SUPABASE_MANAGEMENT_TOKEN || "";
const PROJECT_REF = SUPABASE_URL.match(/^https:\/\/([a-z0-9]+)\./)?.[1] || "";
const SYSTEM_USER_ID =
  process.env.SYSTEM_USER_ID || "7b58d68e-e212-40aa-a96d-5018cb82cc81";
const PROD_REFS = ["lbmbdjgsnenqjwjotoei"];
const MAX_ATTEMPTS = 10;
const LEASE_MS = 30_000;
const ROOM = `test:report-blind-qa:${randomUUID()}`;

if (!SUPABASE_URL || !ANON_KEY || !SERVICE_ROLE || !TEST_API_KEY || !MANAGEMENT_TOKEN || !PROJECT_REF) {
  console.error("FATAL: Supabase URL/keys/management-token/project-ref env 필요");
  process.exit(2);
}
if (PROD_REFS.some((ref) => SUPABASE_URL.includes(ref))) {
  console.error("REFUSED: production ref 대상 DB fault matrix 실행 차단");
  process.exit(2);
}
if (process.env.REPORT_BLIND_TEST_ALLOW_ISOLATED !== "1") {
  console.error("REFUSED: REPORT_BLIND_TEST_ALLOW_ISOLATED=1 필요");
  process.exit(2);
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});
let pass = 0;
let fail = 0;
function check(name, condition, extra) {
  if (condition) {
    pass++;
    return;
  }
  fail++;
  console.error(`  ✗ ${name}${extra ? ` — ${JSON.stringify(extra)}` : ""}`);
}

function requireData(label, result) {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  if (!result.data) throw new Error(`${label}: no data`);
  return result.data;
}

async function must(label, query) {
  const result = await query;
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data;
}

async function createTestUser(tag) {
  const password = `Qa-${randomUUID()}-9a!`;
  const email = `qa+report-blind-${tag}-${randomUUID()}@keubo.test`;
  const data = requireData(
    `createUser(${tag})`,
    await admin.auth.admin.createUser({ email, password, email_confirm: true }),
  );
  const id = data.user.id;
  await must(
    `profile(${tag})`,
    admin
      .from("profiles")
      .upsert({ id, nickname: `qa-${tag}-${id.slice(0, 6)}`, team_id: 1, is_bot: false }),
  );
  return { id, email, password };
}

async function report(type, targetId, reporterId, reason = "abuse") {
  await must(
    `report(${type}:${targetId})`,
    admin.from("reports").insert({
      reporter_id: reporterId,
      target_type: type,
      target_id: targetId,
      reason,
    }),
  );
}

async function createChat(authorId, content) {
  const row = requireData(
    "create chat",
    await admin
      .from("chat_messages")
      .insert({ room_id: ROOM, user_id: authorId, content })
      .select("id")
      .single(),
  );
  return row.id;
}

async function getOutbox(type, targetId) {
  return requireData(
    `outbox(${type}:${targetId})`,
    await admin
      .from("report_blind_notices")
      .select("*")
      .eq("target_type", type)
      .eq("target_id", targetId)
      .single(),
  );
}

async function expireLease(outboxId) {
  await must(
    "expire lease",
    admin
      .from("report_blind_notices")
      .update({ claimed_at: new Date(Date.now() - LEASE_MS - 1000).toISOString() })
      .eq("id", outboxId),
  );
}

async function claim() {
  const result = await admin.rpc("claim_report_blind_notices", {
    p_limit: 200,
    p_max_attempts: MAX_ATTEMPTS,
    p_lease: "30 seconds",
  });
  if (result.error) throw new Error(`claim: ${result.error.message}`);
  return result.data ?? [];
}

async function roleClaimDenied(role) {
  const response = await fetch(
    `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${MANAGEMENT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query:
          `begin; set local role ${role}; ` +
          "select * from claim_report_blind_notices(1, 10, interval '30 seconds'); rollback;",
      }),
    },
  );
  return !response.ok;
}

async function run() {
  const ctx = {
    users: [],
    chatIds: [],
    commentIds: [],
    dedupKeys: [],
  };
  let runError;

  try {
    for (const tag of ["author", "r1", "r2", "r3", "r4"]) {
      ctx.users.push(await createTestUser(tag));
    }
    const [author, r1, r2, r3, r4] = ctx.users;

    const authenticated = createClient(SUPABASE_URL, TEST_API_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const signIn = await authenticated.auth.signInWithPassword({
      email: r1.email,
      password: r1.password,
    });
    if (signIn.error) throw new Error(`signIn: ${signIn.error.message}`);

    // ① RPC ACL + dedup_key trust boundary.
    check("① anon role claim 거부", await roleClaimDenied("anon"));
    check("① authenticated role claim 거부", await roleClaimDenied("authenticated"));

    const authClaim = await authenticated.rpc("claim_report_blind_notices", {
      p_limit: 1,
      p_max_attempts: 10,
      p_lease: "30 seconds",
    });
    check("① authenticated HTTP RPC 거부", !!authClaim.error, {
      error: authClaim.error?.message,
    });

    const [u1, u2] = [r1.id, r2.id].sort();
    const authConversation = requireData(
      "auth conversation",
      await admin
        .from("dm_conversations")
        .insert({ user1_id: u1, user2_id: u2 })
        .select("id")
        .single(),
    );
    const forgedKey = `report-blind:chat:forged-${randomUUID()}`;
    ctx.dedupKeys.push(forgedKey);
    const forged = await authenticated.from("dm_messages").insert({
      conversation_id: authConversation.id,
      sender_id: r1.id,
      content: "forged",
      dedup_key: forgedKey,
    });
    check("① authenticated dedup_key 선점 거부", !!forged.error, {
      error: forged.error?.message,
    });

    // ② 병렬 신고 → race-free 블라인드 + outbox 1건.
    const raceChat = await createChat(author.id, "병렬 신고 대상");
    ctx.chatIds.push(raceChat);
    await Promise.all([
      report("chat", raceChat, r1.id),
      report("chat", raceChat, r2.id),
      report("chat", raceChat, r3.id),
    ]);
    const raceMessage = requireData(
      "race chat result",
      await admin
        .from("chat_messages")
        .select("deleted_at, content, deleted_by")
        .eq("id", raceChat)
        .single(),
    );
    const raceOutbox = await getOutbox("chat", raceChat);
    check("② 병렬 신고 블라인드", raceMessage.deleted_at != null);
    check("② content 마스킹", raceMessage.content === "삭제된 메시지입니다");
    check("② deleted_by 운영팀", raceMessage.deleted_by === SYSTEM_USER_ID);
    check("② outbox 작성자 일치", raceOutbox.author_id === author.id);

    // ③ 같은 outbox를 두 worker가 동시에 claim해도 정확히 1회 lease.
    await must(
      "reset race outbox",
      admin
        .from("report_blind_notices")
        .update({ attempts: 0, claimed_at: null, notified_at: null, dead_lettered_at: null })
        .eq("id", raceOutbox.id),
    );
    const [claimA, claimB] = await Promise.all([claim(), claim()]);
    const mineA = claimA.filter((row) => row.id === raceOutbox.id);
    const mineB = claimB.filter((row) => row.id === raceOutbox.id);
    check("③ 동시 claim 정확히 1회", mineA.length + mineB.length === 1, {
      a: mineA.length,
      b: mineB.length,
    });

    // ④ 최종 claim 뒤 DM 성공→완료 전 crash: exhausted reconcile로 완료.
    await must(
      "prepare post-DM crash",
      admin
        .from("report_blind_notices")
        .update({ attempts: 9, claimed_at: null, notified_at: null, dead_lettered_at: null })
        .eq("id", raceOutbox.id),
    );
    const finalClaim = (await claim()).filter((row) => row.id === raceOutbox.id);
    check(
      "④ attempts=9 최종 claim",
      finalClaim.length === 1 && finalClaim[0].attempts === 10 && finalClaim[0].reconcile_only === false,
      finalClaim,
    );
    const notice = buildBlindNotice(blindTargetLabel("chat"));
    const deliveredKey = `report-blind:chat:${raceChat}`;
    ctx.dedupKeys.push(deliveredKey);
    const sent = await sendOpsMessageToUser(
      admin,
      SYSTEM_USER_ID,
      author.id,
      notice,
      deliveredKey,
    );
    check("④ production helper DM 성공", sent.ok, sent);
    await expireLease(raceOutbox.id); // outbox 완료 전 crash 시뮬
    const reconcileClaim = (await claim()).filter((row) => row.id === raceOutbox.id);
    check(
      "④ exhausted reconcile claim",
      reconcileClaim.length === 1 && reconcileClaim[0].attempts === 10 && reconcileClaim[0].reconcile_only === true,
      reconcileClaim,
    );
    const verifiedDelivery = await verifyOpsMessageByDedupKey(
      admin,
      SYSTEM_USER_ID,
      author.id,
      deliveredKey,
      notice,
      null,
    );
    check("④ production helper 기존 DM 검증", verifiedDelivery.ok && verifiedDelivery.found, verifiedDelivery);
    await must(
      "complete reconciled outbox",
      admin
        .from("report_blind_notices")
        .update({ notified_at: new Date().toISOString(), claimed_at: null, last_error: null })
        .eq("id", raceOutbox.id),
    );
    const deliveredCount = await admin
      .from("dm_messages")
      .select("id", { count: "exact", head: true })
      .eq("dedup_key", deliveredKey);
    if (deliveredCount.error) throw new Error(`dm count: ${deliveredCount.error.message}`);
    check("④ crash 재진입 후 DM 중복 0", deliveredCount.count === 1, {
      count: deliveredCount.count,
    });

    // ⑤ 최종 claim 뒤 DM 전 crash: exhausted reconcile이 dead-letter, RPC로 requeue.
    const preDmCrashChat = await createChat(author.id, "DM 전 crash 대상");
    ctx.chatIds.push(preDmCrashChat);
    await Promise.all([
      report("chat", preDmCrashChat, r1.id),
      report("chat", preDmCrashChat, r2.id),
      report("chat", preDmCrashChat, r3.id),
    ]);
    const preDmOutbox = await getOutbox("chat", preDmCrashChat);
    await must(
      "prepare pre-DM crash",
      admin
        .from("report_blind_notices")
        .update({ attempts: 9, claimed_at: null, notified_at: null, dead_lettered_at: null })
        .eq("id", preDmOutbox.id),
    );
    const beforeDmFinal = (await claim()).filter((row) => row.id === preDmOutbox.id);
    check(
      "⑤ DM 전 최종 claim",
      beforeDmFinal.length === 1 && beforeDmFinal[0].reconcile_only === false,
      beforeDmFinal,
    );
    await expireLease(preDmOutbox.id); // DM 전에 crash
    const beforeDmReconcile = (await claim()).filter((row) => row.id === preDmOutbox.id);
    check(
      "⑤ DM 전 crash reconcile claim",
      beforeDmReconcile.length === 1 && beforeDmReconcile[0].reconcile_only === true,
      beforeDmReconcile,
    );
    const missingKey = `report-blind:chat:${preDmCrashChat}`;
    ctx.dedupKeys.push(missingKey);
    const missingDelivery = await verifyOpsMessageByDedupKey(
      admin,
      SYSTEM_USER_ID,
      author.id,
      missingKey,
      notice,
      null,
    );
    check("⑤ DM 미존재 검증", missingDelivery.ok && !missingDelivery.found, missingDelivery);
    await must(
      "dead-letter RPC",
      admin.rpc("dead_letter_report_blind_notice", {
        p_id: preDmOutbox.id,
        p_error: "attempts_exhausted_without_delivery",
      }),
    );
    let deadRow = requireData(
      "dead-letter row",
      await admin
        .from("report_blind_notices")
        .select("attempts, dead_lettered_at, last_error")
        .eq("id", preDmOutbox.id)
        .single(),
    );
    check("⑤ dead-letter RPC 상태전이", deadRow.attempts === 10 && deadRow.dead_lettered_at != null, deadRow);
    await must(
      "requeue RPC",
      admin.rpc("requeue_report_blind_notice", { p_id: preDmOutbox.id }),
    );
    deadRow = requireData(
      "requeued row",
      await admin
        .from("report_blind_notices")
        .select("attempts, claimed_at, dead_lettered_at")
        .eq("id", preDmOutbox.id)
        .single(),
    );
    check(
      "⑤ requeue RPC 복구",
      deadRow.attempts === 0 && deadRow.claimed_at == null && deadRow.dead_lettered_at == null,
      deadRow,
    );

    // ⑥ reason=block 제외.
    const blockChat = await createChat(author.id, "block 제외 대상");
    ctx.chatIds.push(blockChat);
    await report("chat", blockChat, r1.id);
    await report("chat", blockChat, r2.id);
    await report("chat", blockChat, r3.id, "block");
    let blockMessage = requireData(
      "block excluded result",
      await admin.from("chat_messages").select("deleted_at").eq("id", blockChat).single(),
    );
    check("⑥ 직접2+block1 미블라인드", blockMessage.deleted_at == null);
    await report("chat", blockChat, r4.id);
    blockMessage = requireData(
      "third direct result",
      await admin.from("chat_messages").select("deleted_at").eq("id", blockChat).single(),
    );
    check("⑥ 직접3 블라인드", blockMessage.deleted_at != null);

    // ⑥ comment 기존 경로 유지.
    const comment = requireData(
      "create comment",
      await admin
        .from("comments")
        .insert({ content: "댓글 신고 대상", author_id: author.id })
        .select("id")
        .single(),
    );
    ctx.commentIds.push(comment.id);
    await Promise.all([
      report("comment", comment.id, r1.id),
      report("comment", comment.id, r2.id),
      report("comment", comment.id, r3.id),
    ]);
    const commentResult = requireData(
      "comment result",
      await admin.from("comments").select("is_hidden").eq("id", comment.id).single(),
    );
    check("⑥ comment is_hidden 유지", commentResult.is_hidden === true);
  } catch (error) {
    runError = error;
  } finally {
    try {
      await cleanup(ctx);
    } catch (cleanupError) {
      if (runError) console.error("RUN ERROR BEFORE CLEANUP", runError);
      throw cleanupError;
    }
  }

  if (runError) throw runError;
}

async function cleanup(ctx) {
  const userIds = ctx.users.map((user) => user.id);

  for (const id of ctx.chatIds) {
    await must("cleanup chat reports", admin.from("reports").delete().eq("target_type", "chat").eq("target_id", id));
    await must("cleanup chat outbox", admin.from("report_blind_notices").delete().eq("target_type", "chat").eq("target_id", id));
  }
  for (const id of ctx.commentIds) {
    await must("cleanup comment reports", admin.from("reports").delete().eq("target_type", "comment").eq("target_id", id));
    await must("cleanup comment outbox", admin.from("report_blind_notices").delete().eq("target_type", "comment").eq("target_id", id));
  }

  if (userIds.length > 0) {
    const conversations = await must(
      "find cleanup conversations",
      admin
        .from("dm_conversations")
        .select("id")
        .or(`user1_id.in.(${userIds.join(",")}),user2_id.in.(${userIds.join(",")})`),
    );
    const conversationIds = (conversations ?? []).map((row) => row.id);
    if (conversationIds.length > 0) {
      await must("cleanup dm messages", admin.from("dm_messages").delete().in("conversation_id", conversationIds));
      await must("cleanup conversations", admin.from("dm_conversations").delete().in("id", conversationIds));
    }
  }

  if (ctx.chatIds.length > 0) {
    await must("cleanup chat rows", admin.from("chat_messages").delete().in("id", ctx.chatIds));
  }
  if (ctx.commentIds.length > 0) {
    await must("cleanup comment rows", admin.from("comments").delete().in("id", ctx.commentIds));
  }
  if (userIds.length > 0) {
    await must("cleanup profiles", admin.from("profiles").delete().in("id", userIds));
  }
  for (const user of ctx.users) {
    const deleted = await admin.auth.admin.deleteUser(user.id);
    if (deleted.error) throw new Error(`cleanup auth user ${user.id}: ${deleted.error.message}`);
  }

  // 잔존 0 assertions: teardown 자체가 실패하면 테스트도 실패한다.
  if (ctx.chatIds.length > 0) {
    const chats = await admin.from("chat_messages").select("id", { count: "exact", head: true }).in("id", ctx.chatIds);
    if (chats.error) throw new Error(`verify chats cleanup: ${chats.error.message}`);
    check("⑦ cleanup chat 잔존 0", chats.count === 0, { count: chats.count });

    const reports = await admin.from("reports").select("id", { count: "exact", head: true }).eq("target_type", "chat").in("target_id", ctx.chatIds);
    if (reports.error) throw new Error(`verify reports cleanup: ${reports.error.message}`);
    check("⑦ cleanup report 잔존 0", reports.count === 0, { count: reports.count });

    const outbox = await admin.from("report_blind_notices").select("id", { count: "exact", head: true }).eq("target_type", "chat").in("target_id", ctx.chatIds);
    if (outbox.error) throw new Error(`verify outbox cleanup: ${outbox.error.message}`);
    check("⑦ cleanup outbox 잔존 0", outbox.count === 0, { count: outbox.count });
  }
  if (ctx.commentIds.length > 0) {
    const comments = await admin.from("comments").select("id", { count: "exact", head: true }).in("id", ctx.commentIds);
    if (comments.error) throw new Error(`verify comments cleanup: ${comments.error.message}`);
    check("⑦ cleanup comment 잔존 0", comments.count === 0, { count: comments.count });
  }
  if (ctx.dedupKeys.length > 0) {
    const dms = await admin.from("dm_messages").select("id", { count: "exact", head: true }).in("dedup_key", ctx.dedupKeys);
    if (dms.error) throw new Error(`verify dm cleanup: ${dms.error.message}`);
    check("⑦ cleanup DM 잔존 0", dms.count === 0, { count: dms.count });
  }
  if (userIds.length > 0) {
    const profiles = await admin.from("profiles").select("id", { count: "exact", head: true }).in("id", userIds);
    if (profiles.error) throw new Error(`verify profiles cleanup: ${profiles.error.message}`);
    check("⑦ cleanup profile 잔존 0", profiles.count === 0, { count: profiles.count });

    let authResidual = 0;
    for (const id of userIds) {
      const found = await admin.auth.admin.getUserById(id);
      if (found.data?.user) authResidual++;
    }
    check("⑦ cleanup auth user 잔존 0", authResidual === 0, { authResidual });
  }
}

run()
  .then(() => {
    console.log(`\nreport-blind DB fault matrix: ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
  })
  .catch((error) => {
    console.error("FATAL", error);
    process.exit(1);
  });
