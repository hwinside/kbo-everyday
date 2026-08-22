#!/usr/bin/env node
/**
 * PR #1256 (getClaims) 후속 — 2계정 실제 UI 로그인 + 채팅 양방향 End-User E2E.
 *
 * 삼순 지적 반영: 앞선 16/16 은 auth/API 검증이었고 채팅 전송·수신이 0건이었다.
 * 여기서는 독립 브라우저 컨텍스트 2개로 실제 UI 로그인 → A 전송 → B 새로고침 없이 수신
 * → B 답장 → A 수신 → 새로고침 후 보존까지 태운다.
 *
 * 실시간 축은 어제 🅱️(realtime publication 에서 posts/comments DROP, chat_messages 유지)의
 * 유저 동선 검증도 겸한다.
 *
 * P0: 하린아빠/공유 계정 사용 금지 → 일회용 계정 2개 생성 후 종료 시 삭제(에러·postcondition 확인).
 */
import { createClient } from "@supabase/supabase-js";
import playwright from "playwright";
import { readFileSync } from "node:fs";
import { assertSendAllowed } from "./send-guard.mjs";

const ENV_PATH = process.env.QA_ENV_PATH || "/Users/harinclaw/Projects/kbo-everyday/.env.local";
for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (!m) continue;
  let v = m[2];
  if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
  if (!process.env[m[1]]) process.env[m[1]] = v;
}
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BASE = process.env.QA_BASE_URL || "https://keubo.fan";
const GAME_ID = process.env.QA_GAME_ID || "20260819SKSS0";
// 격리 staging 전용 — 실경기방(game:*) 은 send-guard 가 차단한다. 반드시 qa-fixture:* 를 env 로 지정.
const ROOM_ID = process.env.QA_FIXTURE_ROOM ?? null;
// [P0] 실유저 공간 발송 영구 차단 — production ref/공개 경기방이면 여기서 죽는다(우회 없음).
assertSendAllowed({ roomId: ROOM_ID, purpose: "chat send QA" });

// [P0 GUARD 2026-08-21] 라이브/당일/미래 경기 방 발송 절대 금지 (실유저 노출 사고 재발 방지)
// 종료가 확정된 과거 날짜 경기 또는 더미 room_id만 허용. QA_ALLOW_LIVE 같은 우회 플래그 금지.
{
  const ymd = String(GAME_ID).slice(0, 8);
  const todayKst = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, "");
  if (!/^\d{8}$/.test(ymd) || ymd >= todayKst) {
    console.error(`[GUARD-FAIL] GAME_ID=${GAME_ID} — 당일/미래/형식불명 경기 방은 발송 금지. 과거(종료) 경기로만 실행하세요.`);
    process.exit(1);
  }
}
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/**
 * 결함주입 스위치 — postcondition fail-close 의 검증력을 증명하기 위한 것.
 *   QA_FAULT=pc_select_error  : postcondition SELECT 를 강제로 실패시킨다.
 *   QA_FAULT=pc_user_error    : getUserById 를 not-found 아닌 에러로 만든다.
 *   QA_FAULT=delete_error     : 모든 delete 호출이 error 를 반환한 것처럼 취급한다.
 * 정상 실행에서는 비어 있어야 하며, 주입 시 해당 postcondition 이 FAIL(RED) 이어야 한다.
 */
const FAULT = process.env.QA_FAULT || "";
const pcTable = (name) => (FAULT === "pc_select_error" ? `${name}__qa_fault_missing` : name);

const results = [];
let failed = 0;
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failed++;
  console.log(`${ok ? "  PASS" : "  FAIL"} — ${name}${detail ? ` :: ${detail}` : ""}`);
}

const stamp = Date.now().toString(36);
const accounts = [
  { label: "A", email: `qa-chat-a-${stamp}@keubo.fan`, password: `QaChatA!${stamp}`, nickname: `qaChatA${stamp.slice(-5)}` },
  { label: "B", email: `qa-chat-b-${stamp}@keubo.fan`, password: `QaChatB!${stamp}`, nickname: `qaChatB${stamp.slice(-5)}` },
];
const MSG_A = `QA-A-${stamp}-안녕하세요`;
const MSG_B = `QA-B-${stamp}-반갑습니다`;

let browser = null;
const insertedIds = [];

async function setupAccount(a) {
  const created = await admin.auth.admin.createUser({
    email: a.email, password: a.password, email_confirm: true,
  });
  if (created.error) throw new Error(`createUser ${a.label}: ${created.error.message}`);
  a.userId = created.data.user.id;
  const prof = await admin.from("profiles").upsert(
    { id: a.userId, nickname: a.nickname, team_id: 2002 }, { onConflict: "id" },
  );
  if (prof.error) throw new Error(`profile ${a.label}: ${prof.error.message}`);

  const authClient = createClient(SUPABASE_URL, ANON, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const signed = await authClient.auth.signInWithPassword({ email: a.email, password: a.password });
  if (signed.error || !signed.data.session) throw signed.error ?? new Error(`sign-in ${a.label}`);
  a.session = signed.data.session;
  const hdr = JSON.parse(Buffer.from(a.session.access_token.split(".")[0], "base64url").toString("utf8"));
  a.alg = hdr.alg;
  console.log(`  ${a.label}: ${a.userId} nick=${a.nickname} alg=${a.alg}`);
}

async function openUi(a) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(
    ([at, rt]) => {
      sessionStorage.setItem("kbo-pending-session", JSON.stringify({
        access_token: at, refresh_token: rt,
      }));
    },
    [a.session.access_token, a.session.refresh_token],
  );
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") console.log(`    [${a.label} console.error] ${m.text().slice(0, 160)}`);
  });
  await page.goto(`${BASE}/games/${GAME_ID}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  a.context = context;
  a.page = page;
  return page;
}

async function composer(a) {
  const c = a.page.locator('[data-composer="game-chat"]').first();
  await c.waitFor({ state: "visible", timeout: 45000 });
  return c;
}

async function sendMessage(a, text) {
  const c = await composer(a);
  const box = c.locator('textarea[name="chat-message"]');
  await box.waitFor({ state: "visible", timeout: 20000 });
  await box.click();
  await box.fill(text);
  await c.locator("button:has(svg.lucide-send)").first().click();
}

/** DB 에 실제 insert 됐는지 (UI 낙관적 렌더가 아니라 저장소 확인) */
async function waitInserted(userId, content, timeoutMs = 30000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const { data, error } = await admin
      .from("chat_messages")
      .select("id, room_id, user_id, content, reply_to_id")
      .eq("room_id", ROOM_ID).eq("user_id", userId).eq("content", content)
      .maybeSingle();
    if (error) throw error;
    if (data) return data;
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

/** 상대 화면에 새로고침 없이 나타나는지 */
async function waitVisibleNoReload(a, text, timeoutMs = 30000) {
  try {
    await a.page.locator(`[data-chat-msg]:has-text(${JSON.stringify(text)})`)
      .first().waitFor({ state: "visible", timeout: timeoutMs });
    return true;
  } catch { return false; }
}

async function main() {
  console.log(`[chat E2E] base=${BASE} room=${ROOM_ID}`);

  console.log("\n[1] 전용 계정 2개 생성 + 로그인 세션 확보");
  for (const a of accounts) await setupAccount(a);
  check("두 계정 토큰 ES256", accounts.every((a) => a.alg === "ES256"),
    accounts.map((a) => `${a.label}=${a.alg}`).join(" "));

  console.log("\n[2] 독립 브라우저 컨텍스트 2개로 실제 UI 진입");
  browser = await playwright.chromium.launch({ headless: true, executablePath: CHROME });
  for (const a of accounts) {
    await openUi(a);
    console.log(`  ${a.label} 페이지 로드 완료`);
  }
  for (const a of accounts) {
    let ok = true;
    try { await composer(a); } catch { ok = false; }
    check(`${a.label} 로그인 상태로 채팅 작성창 노출 (인증 UI 종단)`, ok);
  }

  console.log("\n[3] A 전송 → DB insert");
  await sendMessage(accounts[0], MSG_A);
  const rowA = await waitInserted(accounts[0].userId, MSG_A);
  if (rowA) insertedIds.push(rowA.id);
  check("A 메시지 DB insert", Boolean(rowA), rowA ? `id=${rowA.id}` : "timeout");
  check("A 메시지 sender 결속 (user_id == A)", rowA?.user_id === accounts[0].userId,
    `got=${rowA?.user_id ?? "none"}`);

  console.log("\n[4] B 화면에 새로고침 없이 수신되는가 (realtime)");
  const seenByB = await waitVisibleNoReload(accounts[1], MSG_A);
  check("B 가 새로고침 없이 A 메시지 수신 (chat_messages realtime 생존)", seenByB);
  if (seenByB) {
    const senderShown = await accounts[1].page
      .locator(`[data-chat-msg]:has-text(${JSON.stringify(MSG_A)})`).first()
      .innerText().catch(() => "");
    check("B 화면에서 발신자가 A 로 표시 (sender 결속)",
      senderShown.includes(accounts[0].nickname),
      `expected nick=${accounts[0].nickname} text=${senderShown.replace(/\s+/g, " ").slice(0, 80)}`);
  } else {
    check("B 화면에서 발신자가 A 로 표시 (sender 결속)", false, "수신 실패로 판정 불가");
  }

  console.log("\n[5] B 답장 → A 가 새로고침 없이 수신");
  await sendMessage(accounts[1], MSG_B);
  const rowB = await waitInserted(accounts[1].userId, MSG_B);
  if (rowB) insertedIds.push(rowB.id);
  check("B 답장 DB insert", Boolean(rowB), rowB ? `id=${rowB.id}` : "timeout");
  const seenByA = await waitVisibleNoReload(accounts[0], MSG_B);
  check("A 가 새로고침 없이 B 답장 수신 (양방향 realtime)", seenByA);

  console.log("\n[6] 새로고침 후 보존");
  await accounts[0].page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
  const keptA = await waitVisibleNoReload(accounts[0], MSG_A, 30000);
  const keptB = await waitVisibleNoReload(accounts[0], MSG_B, 30000);
  check("새로고침 후 A 화면에 두 메시지 모두 보존", keptA && keptB, `A=${keptA} B=${keptB}`);

  console.log("\n[7] 교차 오염 — 각 메시지가 자기 발신자로만 저장됐는가");
  const { data: rows, error: rowsErr } = await admin
    .from("chat_messages").select("id,user_id,content")
    .eq("room_id", ROOM_ID).in("content", [MSG_A, MSG_B]).order("created_at");
  check("QA 메시지 2건 조회", !rowsErr && rows?.length === 2,
    rowsErr ? rowsErr.message : `count=${rows?.length}`);
  if (rows?.length === 2) {
    const byContent = Object.fromEntries(rows.map((r) => [r.content, r.user_id]));
    check("A 메시지는 A 계정 소유", byContent[MSG_A] === accounts[0].userId);
    check("B 메시지는 B 계정 소유", byContent[MSG_B] === accounts[1].userId);
  }
}

async function cleanup() {
  console.log("\n[cleanup]");
  if (browser) {
    for (const a of accounts) { try { await a.context?.close(); } catch { /* noop */ } }
    await browser.close().catch(() => {});
  }
  // 삭제 호출의 error 를 로그만 하고 넘어가면 "정리 실패"가 결과 판정에 안 잡힌다.
  // 모든 delete 의 error 를 모아 check() 로 결속한다.
  const deleteErrors = [];
  const noteDelete = (label, res) => {
    const err = FAULT === "delete_error"
      ? { message: `injected delete failure (${label})` }
      : res?.error;
    if (err) deleteErrors.push(`${label}: ${err.message}`);
    return err;
  };

  if (insertedIds.length) {
    const del = await admin.from("chat_messages").delete().in("id", insertedIds);
    const e = noteDelete("messages.byId", del);
    console.log(`  메시지 삭제 error=${e?.message ?? "null"}`);
  }
  for (const a of accounts) {
    if (!a.userId) continue;
    const dm = noteDelete(`${a.label}.chat_messages`, await admin.from("chat_messages").delete().eq("user_id", a.userId));
    const dp = noteDelete(`${a.label}.profiles`, await admin.from("profiles").delete().eq("id", a.userId));
    const du = noteDelete(`${a.label}.auth_user`, await admin.auth.admin.deleteUser(a.userId));
    console.log(`  ${a.label} msg.error=${dm?.message ?? "null"} profile.error=${dp?.message ?? "null"} user.error=${du?.message ?? "null"}`);
  }
  check(
    "cleanup — 모든 삭제 호출 error 없음",
    deleteErrors.length === 0,
    deleteErrors.join(" | ") || "all null",
  );
  // postcondition — fail-close.
  // 조회 자체가 실패하면 data 는 null 이고 `?.length ?? 0` 은 0 이 된다.
  // 그걸 "잔존 0" 으로 읽으면 정리 실패를 PASS 로 보고하게 된다 → error 와 data 존재를 모두 요구.
  const msgRes = await admin.from(pcTable("chat_messages")).select("id").in("content", [MSG_A, MSG_B]);
  check(
    "postcondition — QA 메시지 잔존 0 (조회 성공 전제)",
    !msgRes.error && Array.isArray(msgRes.data) && msgRes.data.length === 0,
    msgRes.error ? `select error: ${msgRes.error.message}` : `left=${msgRes.data?.length ?? "null"}`,
  );

  const ids = accounts.map((a) => a.userId).filter(Boolean);
  if (ids.length) {
    const profRes = await admin.from(pcTable("profiles")).select("id").in("id", ids);
    check(
      "postcondition — QA 프로필 잔존 0 (조회 성공 전제)",
      !profRes.error && Array.isArray(profRes.data) && profRes.data.length === 0,
      profRes.error ? `select error: ${profRes.error.message}` : `left=${profRes.data?.length ?? "null"}`,
    );

    // 계정은 "없음"을 적극 증명해야 한다.
    // getUserById 가 임의 에러(네트워크·권한)를 내는 건 삭제 근거가 아니므로
    // not-found 계열 응답만 성공 처리하고 나머지는 미판정(=FAIL) 으로 둔다.
    const verdicts = [];
    for (const id of ids) {
      const { data, error } = FAULT === "pc_user_error"
        ? { data: null, error: { status: 500, message: "injected transport failure" } }
        : await admin.auth.admin.getUserById(id);
      if (data?.user) { verdicts.push(`${id.slice(0, 8)}=EXISTS`); continue; }
      if (!error) { verdicts.push(`${id.slice(0, 8)}=NO_USER_NO_ERROR`); continue; }
      // 삭제 증명은 구조화된 신호만 인정한다.
      // 범용 "not found" 문자열 매칭은 무관한 에러문(예: "table not found")도 통과시킨다.
      const notFound = error.status === 404 || error.code === "user_not_found";
      verdicts.push(`${id.slice(0, 8)}=${notFound ? "GONE" : `UNVERIFIED(status=${error.status ?? "?"} code=${error.code ?? "?"}: ${error.message})`}`);
    }
    check(
      "postcondition — QA 계정 삭제가 not-found 로 증명됨",
      verdicts.every((v) => v.endsWith("=GONE")),
      verdicts.join(" "),
    );
  }
}

let exitCode = 0;
try {
  await main();
} catch (e) {
  console.error("\nUNCAUGHT:", e.message);
  exitCode = 1;
} finally {
  try { await cleanup(); } catch (e) { console.error("cleanup 실패:", e.message); exitCode = 1; }
}

console.log("\n=== 요약 ===");
console.log(`총 ${results.length} · PASS ${results.length - failed} · FAIL ${failed}`);
for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name} :: ${r.detail}`);
process.exit(exitCode || (failed ? 1 : 0));
