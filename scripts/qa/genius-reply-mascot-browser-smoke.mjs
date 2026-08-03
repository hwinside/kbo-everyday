#!/usr/bin/env node
/**
 * 답변 유형별 마스코트 실브라우저 검증 (2026-08-02).
 *
 * 소스 계약(qa:genius-reply-mascot)만으로는 "DB 에 저장된 유형이 실제 화면의 표정으로
 * 이어지는가"를 증명하지 못한다. 여기서는 전용 테스트 계정 대화에 유형별 봇 답변을
 * service_role 로 직접 심고, 실제 렌더된 <img> 의 상태·실로드를 확인한다.
 *
 * 답변은 production RPC(admin_send_ops_message)를 실제 호출한다. 따라서
 * migration 적용 뒤 이 한 테스트가 "발송 → payload → 화면"을 끝까지 검증한다.
 *
 * 실행: node scripts/qa/genius-reply-mascot-browser-smoke.mjs --base-url=http://localhost:3099
 */
import { createClient } from "@supabase/supabase-js";
import playwright from "playwright";
import { SUPABASE_URL, ANON, SERVICE_ROLE, REF, BASE } from "./_env.mjs";

const BASE_URL = process.argv.find((a) => a.startsWith("--base-url="))?.split("=")[1] ?? BASE;
const GENIUS_ID = "45ae7419-6a9a-4c6b-9101-8d65df7e242e";

// (질문, 답변 유형, 기대 마스코트) — 매핑 5갈래를 화면에서 직접 확인한다.
const CASES = [
  { q: "보크가 뭐야?", a: "투수가 주자를 속이는 반칙 동작이에요.", kind: "answer", path: "dictionary", expect: "answering" },
  { q: "낫아웃이 뭐야?", a: "3스트라이크인데 포수가 못 잡은 상황이에요.", kind: "answer", path: "llm", expect: "answering" },
  { q: "고마워", a: "도움이 됐다니 다행이에요! ⚾", kind: "ack", path: "ack", expect: "praised" },
  { q: "오늘 경기 결과 알려줘", a: "야구 룰/용어에 대한 질문만 답할 수 있어요.", kind: "unavailable", path: "blocked", expect: "unknown" },
  // payload 자체가 없는 과거 답변(배포 전 생성분) — idle 폴백이어야 하고 깨지면 안 된다.
  { q: "예전 질문", a: "예전에 저장된 답변이에요.", kind: null, path: null, expect: "idle" },
];

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const results = [];
const ok = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

async function main() {
  const browser = await playwright.chromium.launch();
  let testUser = null;
  let forgerUser = null;
  let convId = null;

  try {
    const email = `qa-genius-mascot-${Date.now()}@keubo-qa.invalid`;
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
      password: `Qa!${Math.random().toString(36).slice(2)}Aa1`,
    });
    if (createErr) throw new Error(`테스트 계정 생성 실패: ${createErr.message}`);
    testUser = created.user;

    // 대화방 + 유형별 메시지 심기 (질문=유저, 답변=봇)
    const [u1, u2] = [testUser.id, GENIUS_ID].sort();
    const { data: conv, error: convErr } = await admin
      .from("dm_conversations")
      .insert({ user1_id: u1, user2_id: u2 })
      .select("id")
      .single();
    if (convErr) throw new Error(`대화 생성 실패: ${convErr.message}`);
    convId = conv.id;

    for (const [index, c] of CASES.entries()) {
      const { error: questionError } = await admin.from("dm_messages").insert({
        conversation_id: convId,
        sender_id: testUser.id,
        content: c.q,
      });
      if (questionError) throw new Error(`질문 삽입 실패: ${questionError.message}`);
      const payload = c.path
        ? { type: "baseball_genius_reply", reply_kind: c.kind, match_path: c.path }
        : null;
      // query-guard: bounded -- admin_send_ops_message는 대상 대화 1행만 반환한다.
      const { data: sent, error: sendError } = await admin.rpc("admin_send_ops_message", {
        p_system_user_id: GENIUS_ID,
        p_user_id: testUser.id,
        p_content: c.a,
        p_image_urls: [],
        p_preview: c.a,
        p_origin: "dm",
        p_dedup_key: `qa-genius-reply:${testUser.id}:${index}`,
        p_payload: payload,
      });
      if (sendError) throw new Error(`답변 RPC 실패: ${sendError.message}`);
      const sentRow = Array.isArray(sent) ? sent[0] : sent;
      if (sentRow?.conversation_id !== convId) {
        throw new Error(`답변 RPC 대화 불일치: ${sentRow?.conversation_id} != ${convId}`);
      }
    }
    // 위조 케이스 — ⚠️ **본인(testUser) 발신으로 짜면 거짓 초록이다.**
    // 내가 보낸 메시지는 `!isMe` 때문에 발신자 헤더(= 마스코트 자리) 자체가 안 그려진다.
    // 그래서 sender 검증을 통째로 빼도 그 assert 는 항상 PASS 한다(RED 실험으로 실제 확인함).
    // 진짜 위험은 **제3자**가 봇 payload 를 흉내내는 경우다 — 그때는 헤더가 렌더된다.
    const { data: forger, error: forgerErr } = await admin.auth.admin.createUser({
      email: `qa-genius-forger-${Date.now()}@keubo-qa.invalid`,
      email_confirm: true,
      password: `Qa!${Math.random().toString(36).slice(2)}Aa1`,
    });
    if (forgerErr) throw new Error(`위조 테스트 계정 생성 실패: ${forgerErr.message}`);
    forgerUser = forger.user;
    const { error: forgedInsertError } = await admin.from("dm_messages").insert({
      conversation_id: convId,
      sender_id: forgerUser.id,
      content: "내가 봇인 척",
      payload: { type: "baseball_genius_reply", reply_kind: "answer", match_path: "llm" },
    });
    if (forgedInsertError) throw new Error(`위조 메시지 삽입 실패: ${forgedInsertError.message}`);

    // 세션 주입 (쿠키 — @supabase/ssr 는 쿠키에서 읽는다)
    const { data: link, error: linkErr } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email,
    });
    if (linkErr) throw new Error(`magiclink 실패: ${linkErr.message}`);
    const vr = await fetch(
      `${SUPABASE_URL}/auth/v1/verify?token=${link.properties.hashed_token}&type=magiclink`,
      { redirect: "manual" },
    );
    const frag = new URLSearchParams((vr.headers.get("location") || "").split("#")[1] || "");
    const accessToken = frag.get("access_token");
    if (!accessToken) throw new Error(`세션 교환 실패: HTTP ${vr.status}`);
    const sessionUser = await (
      await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { apikey: ANON, Authorization: `Bearer ${accessToken}` },
      })
    ).json();
    const sessionValue = JSON.stringify({
      access_token: accessToken,
      refresh_token: frag.get("refresh_token"),
      expires_in: 3600,
      expires_at: Number(frag.get("expires_at")),
      token_type: "bearer",
      user: {
        id: sessionUser.id,
        email: sessionUser.email,
        aud: sessionUser.aud,
        role: sessionUser.role,
        app_metadata: {},
        user_metadata: {},
        created_at: sessionUser.created_at,
      },
    });

    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const authKey = `sb-${REF}-auth-token`;
    const u = new URL(BASE_URL);
    const expires = Number(frag.get("expires_at"));
    await ctx.addCookies([
      {
        name: authKey,
        value: `base64-${Buffer.from(sessionValue).toString("base64")}`,
        domain: u.hostname,
        path: "/",
        httpOnly: false,
        secure: u.protocol === "https:",
        sameSite: "Lax",
        ...(Number.isFinite(expires) ? { expires } : {}),
      },
    ]);
    await ctx.addInitScript(([k, v]) => window.localStorage.setItem(k, v), [authKey, sessionValue]);

    const page = await ctx.newPage();
    await page.goto(`${BASE_URL}/messages/${convId}`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="genius-reply-mascot"]', { timeout: 15000 });

    // 답변 본문 → 그 말풍선에 붙은 마스코트 상태를 짝지어 읽는다.
    // (인덱스로 세면 렌더 순서가 바뀔 때 조용히 엉뚱한 걸 검사한다)
    const observed = await page.evaluate(() => {
      const out = [];
      for (const img of document.querySelectorAll('[data-testid="genius-reply-mascot"]')) {
        const bubble = img.closest("div")?.parentElement;
        out.push({
          state: img.getAttribute("data-state"),
          naturalWidth: img.naturalWidth,
          height: Math.round(img.getBoundingClientRect().height),
          text: (bubble?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 60),
        });
      }
      return out;
    });

    for (const c of CASES) {
      const key = c.a.slice(0, 12);
      const hit = observed.find((o) => o.text.includes(key));
      ok(
        `[${c.path ?? "payload 없음"}] "${c.a.slice(0, 14)}…" → ${c.expect}`,
        !!hit && hit.state === c.expect,
        hit ? `실제=${hit.state}` : "말풍선을 찾지 못함",
      );
    }

    ok(
      "모든 마스코트가 실제로 로드됨(404 아님)",
      observed.length > 0 && observed.every((o) => o.naturalWidth > 0),
      `${observed.filter((o) => o.naturalWidth > 0).length}/${observed.length}`,
    );
    ok(
      "상태가 바뀌어도 렌더 높이가 동일(캐릭터 안 튐)",
      new Set(observed.map((o) => o.height)).size === 1,
      [...new Set(observed.map((o) => o.height))].join(","),
    );

    // 위조 방어: 유저 발신 payload 에는 마스코트가 붙지 않아야 한다.
    const forged = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll("*")].filter(
        (el) => el.children.length === 0 && el.textContent?.trim() === "내가 봇인 척",
      );
      if (nodes.length === 0) return { found: false };
      const row = nodes[0].closest(".flex");
      return { found: true, hasMascot: !!row?.querySelector('[data-testid="genius-reply-mascot"]') };
    });
    ok("유저가 흉내낸 payload 에는 마스코트가 안 붙는다", forged.found && !forged.hasMascot, JSON.stringify(forged));

    await ctx.close();
  } finally {
    if (convId) {
      const { error: messageDeleteError } = await admin.from("dm_messages").delete().eq("conversation_id", convId);
      ok("정리: 테스트 메시지 삭제", !messageDeleteError, messageDeleteError?.message ?? "");
      const { error: conversationDeleteError } = await admin.from("dm_conversations").delete().eq("id", convId);
      ok("정리: 테스트 대화 삭제", !conversationDeleteError, conversationDeleteError?.message ?? "");
      const { count: messageCount, error: messageCheckError } = await admin
        .from("dm_messages").select("id", { count: "exact", head: true }).eq("conversation_id", convId);
      const { count: conversationCount, error: conversationCheckError } = await admin
        .from("dm_conversations").select("id", { count: "exact", head: true }).eq("id", convId);
      ok("정리: 대화·메시지 잔존 0",
        !messageCheckError && !conversationCheckError && messageCount === 0 && conversationCount === 0,
        `messages=${messageCount} conversations=${conversationCount}`);
    }
    for (const uid of [testUser?.id, forgerUser?.id].filter(Boolean)) {
      const { error: profileDeleteError } = await admin.from("profiles").delete().eq("id", uid);
      const { error: authDeleteError } = await admin.auth.admin.deleteUser(uid);
      const { count: profileCount, error: profileCheckError } = await admin
        .from("profiles").select("id", { count: "exact", head: true }).eq("id", uid);
      const { data: authCheck, error: authCheckError } = await admin.auth.admin.getUserById(uid);
      ok(`정리: 임시계정 삭제 ${uid.slice(0, 8)}`,
        !profileDeleteError && !authDeleteError,
        `profile=${profileDeleteError?.message ?? "ok"} auth=${authDeleteError?.message ?? "ok"}`);
      ok(`정리: 임시계정 잔존 0 ${uid.slice(0, 8)}`,
        !profileCheckError && profileCount === 0 &&
          authCheckError?.status === 404 && !authCheck?.user,
        `profiles=${profileCount} auth=${authCheck?.user ? "남음" : authCheckError?.status ?? "조회실패"}`);
    }
    await browser.close();
  }

  const failed = results.filter((r) => !r.pass);
  console.log(
    `\n${failed.length === 0 ? "✅" : "❌"} genius reply mascot browser: PASS=${results.length - failed.length} FAIL=${failed.length}`,
  );
  if (failed.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error("SMOKE ERROR:", e.message);
  process.exit(1);
});
