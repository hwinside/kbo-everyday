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
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import playwright from "playwright";
import { SUPABASE_URL, ANON, SERVICE_ROLE, REF, BASE } from "./_env.mjs";

// ⚠️ 키를 문자열로 다시 적으면 배포 클라가 키를 바꿔도 게이트는 조용히 GREEN 이다.
// 실제 배포 모듈의 상수를 그대로 읽는다.
const OUTBOX_KEY = "baseball-genius-question-outbox-v1";

// 마스코트 렌더 높이도 같은 이유로 **배포 소스에서** 읽는다(.mjs 라 TS import 불가 → 파싱).
// 파싱 실패를 기본값으로 넘기면 상수가 사라져도 GREEN 이 된다 — fail-close.
const GENIUS_MASCOT_HEIGHT_PX = (() => {
  const src = readFileSync(resolve(process.cwd(), "src/lib/constants/baseball-genius.ts"), "utf8");
  const m = src.match(/export const GENIUS_MASCOT_HEIGHT_PX\s*=\s*(\d+)\s*;/);
  if (!m) throw new Error("GENIUS_MASCOT_HEIGHT_PX 상수를 배포 소스에서 찾지 못했다");
  return Number(m[1]);
})();

const BASE_URL = process.argv.find((a) => a.startsWith("--base-url="))?.split("=")[1] ?? BASE;
const GENIUS_ID = "45ae7419-6a9a-4c6b-9101-8d65df7e242e";

// (질문, 답변 유형, 기대 마스코트) — 매핑 5갈래를 화면에서 직접 확인한다.
// 2026-08-16 전면 교체: 정적 PNG 5표정 → **영상 클립 13종**.
// 기대값은 클립 이름(data-clip)이다. 어느 클립인지는 (reply_kind, motion, 최애팀)로
// 결정되며, 여기서 재계산하지 않고 **배포 SSOT 함수**로 뽑는다(게이트가 상수를
// 재구현하면 결함을 못 본다 — M90).
const CASES = [
  { q: "보크가 뭐야?", a: "투수가 주자를 속이는 반칙 동작입니다.", kind: "answer", path: "dictionary" },
  { q: "낫아웃이 뭐야?", a: "3스트라이크인데 포수가 못 잡은 상황입니다.", kind: "answer", path: "llm" },
  // §7.6 의미 모션 — 감사·칭찬은 headspin 이어야 한다(시드 교대 아님).
  { q: "고마워", a: "도움이 됐다니 다행이에요! ⚾", kind: "ack", path: "ack", motion: "headspin" },
  { q: "안녕", a: "안녕하세요! ⚾", kind: "ack", path: "ack", motion: "excited" },
  { q: "오늘 경기 결과 알려줘", a: "야구 룰/용어에 대한 질문만 답할 수 있어요.", kind: "unavailable", path: "blocked" },
  // payload 자체가 없는 과거 답변(배포 전 생성분) — 야구 동작 폴백이어야 하고 깨지면 안 된다.
  { q: "예전 질문", a: "예전에 저장된 답변이에요.", kind: null, path: null },
];

// 출처 표기 케이스 (하린아빠 2026-08-05 P0 — `rev crawled:…` 노출 제거).
//  · 신규: 본문엔 표시명만, 링크는 payload(source_url) → 클라가 앵커를 씌운다
//  · 구: 이미 발송된 과거 답변. 본문에 전체 URL·rev·기준일이 그대로 남아 있어
//        표시 시점에 잘라내야 한다(저장 행 UPDATE 없이).
const NAMU_URL = "https://namu.wiki/w/%EB%AC%B8%EB%B3%B4%EA%B2%BD";
const PROVENANCE_CASES = [
  {
    label: "신규 표기",
    answer: "문보경 선수의 별명은 문보물입니다.\n\n📄 출처: 나무위키",
    payload: { type: "baseball_genius_reply", reply_kind: "answer", match_path: "rag", source_url: NAMU_URL },
    expectLabel: "나무위키",
    expectHref: NAMU_URL,
  },
  {
    label: "구 표기(과거 발송분)",
    answer: `문보경 선수의 별명은 문학소년입니다.\n\n📄 출처: 문보경 (${NAMU_URL}) · rev crawled:2026-08-02T02:59:26.899Z · 2026-08-02 기준`,
    payload: { type: "baseball_genius_reply", reply_kind: "answer", match_path: "rag" },
    expectLabel: "나무위키",
    expectHref: NAMU_URL,
  },
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
    // 출처 표기 케이스도 같은 대화에 심는다(같은 페이지에서 한 번에 검증).
    for (const [index, c] of PROVENANCE_CASES.entries()) {
      // query-guard: bounded -- admin_send_ops_message는 대상 대화 1행만 반환한다.
      const { error: provError } = await admin.rpc("admin_send_ops_message", {
        p_system_user_id: GENIUS_ID,
        p_user_id: testUser.id,
        p_content: c.answer,
        p_image_urls: [],
        p_preview: c.answer.slice(0, 40),
        p_origin: "dm",
        p_dedup_key: `qa-genius-provenance:${testUser.id}:${index}`,
        p_payload: c.payload,
      });
      if (provError) throw new Error(`출처 케이스 RPC 실패: ${provError.message}`);
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
        const picture = img.parentElement;
        const reduced = picture?.querySelector('source[media*="prefers-reduced-motion"]');
        out.push({
          clip: img.getAttribute("data-clip"),
          src: img.getAttribute("src"),
          naturalWidth: img.naturalWidth,
          // 실제 화면 높이·폭 (96px 규격 + padding 겹침 확인)
          height: Math.round(img.getBoundingClientRect().height),
          width: Math.round(img.getBoundingClientRect().width),
          // reduced-motion poster 대체본이 실제 DOM 에 붙어 있는가
          posterSrcset: reduced?.getAttribute("srcset") ?? null,
          messageId: Number(img.closest("[data-message-id]")?.getAttribute("data-message-id") ?? 0),
          text: (bubble?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 60),
        });
      }
      return out;
    });

    // 기대 클립은 **배포 SSOT 함수**로 뽑는다 — 여기서 매핑을 재현하면
    // 배포 매핑이 바뀌어도 게이트는 조용히 GREEN 이 된다.
    const { geniusMotionClipFor, GENIUS_MASCOT_HEIGHT_PX } =
      await import("../../src/lib/constants/baseball-genius.ts");

    for (const c of CASES) {
      const key = c.a.slice(0, 12);
      const hit = observed.find((o) => o.text.includes(key));
      const expected = hit
        ? geniusMotionClipFor(c.kind, hit.messageId, { motion: c.motion ?? null })
        : null;
      ok(
        `[${c.path ?? "payload 없음"}] "${c.a.slice(0, 14)}…" → ${expected ?? "?"}`,
        !!hit && hit.clip === expected,
        hit ? `실제=${hit.clip} 기대=${expected}` : "말풍선을 찾지 못함",
      );
    }

    ok(
      "모든 마스코트 영상이 실제로 로드됨(404 아님)",
      observed.length > 0 && observed.every((o) => o.naturalWidth > 0),
      `${observed.filter((o) => o.naturalWidth > 0).length}/${observed.length} :: ` +
        JSON.stringify(observed.map((o) => [o.clip, o.naturalWidth, o.height])),
    );
    ok(
      "정적 PNG 가 아니라 영상 클립(/mascot/motion/*.webp)을 재생한다",
      observed.length > 0 && observed.every((o) => /^\/mascot\/motion\/[^/]+\.webp$/.test(o.src ?? "")),
      JSON.stringify(observed.map((o) => o.src)),
    );
    ok(
      "reduced-motion poster 대체본이 실제 DOM 에 붙어 있다",
      observed.length > 0 && observed.every((o) => /-poster\.webp$/.test(o.posterSrcset ?? "")),
      JSON.stringify(observed.map((o) => o.posterSrcset)),
    );
    ok(
      `클립이 바뀌어도 렌더 높이가 ${GENIUS_MASCOT_HEIGHT_PX}px 로 동일(캐릭터 안 튐)`,
      new Set(observed.map((o) => o.height)).size === 1 &&
        observed.every((o) => o.height === GENIUS_MASCOT_HEIGHT_PX),
      [...new Set(observed.map((o) => o.height))].join(","),
    );
    // 클립마다 폭이 다르다(스윙은 배트 때문에 넓다) — 말풍선 밖으로 삐져나가면 안 된다.
    const overflow = await page.evaluate(() => {
      const out = [];
      for (const img of document.querySelectorAll('[data-testid="genius-reply-mascot"]')) {
        const row = img.closest(".flex");
        if (!row) continue;
        const a = img.getBoundingClientRect();
        const b = row.getBoundingClientRect();
        if (a.left < b.left - 1 || a.right > b.right + 1) {
          out.push({ clip: img.getAttribute("data-clip"), imgLeft: a.left, imgRight: a.right, rowLeft: b.left, rowRight: b.right });
        }
      }
      return out;
    });
    ok("마스코트가 말풍선 행 밖으로 넘치지 않는다(폭이 넓은 스윙 포함)",
      overflow.length === 0, JSON.stringify(overflow));

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

    // ── 출처 표기 실렌더 (하린아빠 2026-08-05 P0) ──────────────────────────────
    //
    // 소스 계약만으로는 "화면에 crawled 가 안 보인다"를 증명하지 못한다.
    // 실제 렌더된 DOM 텍스트에서 금칙 문자열이 0건인지, 표시명이 앵커인지 직접 읽는다.
    const provObserved = await page.evaluate(() => {
      const out = [];
      for (const node of document.querySelectorAll('[data-testid="genius-provenance"]')) {
        const bubble = node.parentElement;
        const anchor = node.querySelector('[data-testid="genius-provenance-link"]');
        out.push({
          text: (node.innerText || "").replace(/\s+/g, " ").trim(),
          href: anchor?.getAttribute("href") ?? null,
          anchorText: anchor?.textContent?.trim() ?? null,
          bubbleText: (bubble?.innerText || "").replace(/\s+/g, " ").trim(),
        });
      }
      return { rows: out, pageText: (document.body.innerText || "").replace(/\s+/g, " ") };
    });

    for (const c of PROVENANCE_CASES) {
      const hit = provObserved.rows.find(
        (r) => r.anchorText === `📄 출처: ${c.expectLabel}` && r.href === c.expectHref,
      );
      ok(
        `[${c.label}] 출처가 '${c.expectLabel}' 표시명 + 하이퍼링크로 렌더`,
        !!hit,
        hit ? `href=${hit.href}` : JSON.stringify(provObserved.rows),
      );
    }

    // 금칙 — 하나라도 화면에 보이면 RED. 이게 이 핫픽스의 본체다.
    for (const [name, pattern] of [
      ["crawled", /crawled/i],
      ["rev 접두", /\brev\s+\S/],
      ["기준일", /\d{4}-\d{2}-\d{2} 기준/],
      ["전체 URL 평문", /https:\/\/namu\.wiki\//],
    ]) {
      ok(
        `화면 텍스트에 '${name}' 노출 0건`,
        !pattern.test(provObserved.pageText),
        provObserved.pageText.match(pattern)?.[0] ?? "",
      );
    }

    await ctx.close();

    // ── 생각중(대기) 마스코트 actual 렌더 (삼순 #1100 2차 P0-3) ──────────────────
    //
    // ⚠️ 위 케이스들은 전부 **답변이 이미 도착한** 말풍선이다. 하린아빠가 실화면에서
    // 못 봤다고 한 것은 답변을 **기다리는 동안**의 생각중 표정인데, 그 경로는
    // `GeniusTypingIndicator` 라 위 셀렉터에 아예 안 걸린다. 코드 존재(unit PASS)만으로
    // 닫으면 안 되므로 실제 브라우저에서 대기 상태를 만들어 렌더를 실측한다.
    //
    // 대기 상태 재현: outbox(localStorage)에 미확인 질문을 심고 `/api/baseball-qa` 를
    // 막는다. 그러면 클라가 계속 waiting 이라 인디케이터가 화면에 남는다.
    const waitCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await waitCtx.addCookies([
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
    await waitCtx.addInitScript(([k, v]) => window.localStorage.setItem(k, v), [authKey, sessionValue]);
    // 실제 배포 클라이언트가 읽는 그 키·그 shape 으로 심는다(자체 fixture 금지).
    await waitCtx.addInitScript(
      ([key, value]) => window.localStorage.setItem(key, value),
      [OUTBOX_KEY, JSON.stringify([{ conversationId: convId, messageId: 999000001, attempts: 0 }])],
    );
    // 답변이 오면 waiting 이 풀리므로 요청 자체를 붙잡아 대기 상태를 유지한다.
    await waitCtx.route("**/api/baseball-qa", async () => { /* never fulfilled */ });

    const waitPage = await waitCtx.newPage();
    // ⚠️ `networkidle` 금지 — 위 route() 가 `/api/baseball-qa` 를 의도적으로 붙잡고 있어
    // 네트워크가 절대 idle 이 되지 않는다(첫 구현이 여기서 30s timeout 으로 죽었다).
    await waitPage.goto(`${BASE_URL}/messages/${convId}`, { waitUntil: "domcontentloaded" });

    let typing = null;
    try {
      await waitPage.waitForSelector('[data-testid="genius-typing-mascot"]', { timeout: 20000 });
      typing = await waitPage.evaluate(() => {
        const img = document.querySelector('[data-testid="genius-typing-mascot"]');
        if (!img) return null;
        const rect = img.getBoundingClientRect();
        const host = img.closest('[data-testid="genius-typing-indicator"]');
        return {
          clip: img.getAttribute("data-clip"),
          state: host?.getAttribute("data-state") ?? null,
          naturalWidth: img.naturalWidth,
          height: Math.round(rect.height),
          visible: rect.width > 0 && rect.height > 0,
          statusRole: !!host?.querySelector('[role="status"]'),
        };
      });
    } catch {
      typing = null;
    }

    // waiting / retrying 은 둘 다 "답변을 기다리는 중"이며 같은 thinking 표정이다.
    // 관측 시점에 따라 어느 쪽이든 나올 수 있으므로 둘 다 허용하되, 그 외 상태는 실패다.
    ok(
      "대기중 생각 마스코트가 실제로 렌더된다(waiting/retrying → thinking 클립)",
      !!typing && typing.clip === "thinking" && ["waiting", "retrying"].includes(typing.state),
      JSON.stringify(typing),
    );
    ok(
      "대기중 마스코트 영상이 실제 로드된다(404 아님)",
      !!typing && typing.naturalWidth > 0,
      typing ? `naturalWidth=${typing.naturalWidth}` : "미렌더",
    );
    // 기대 높이는 배포 상수에서 온다 — 숫자를 게이트에 적으면 상수가 바뀌어도 몰라서
    // 사용처만 되돌아가는 결함을 못 잡는다(M90 `게이트가 상수를 재구현하면…`).
    // 2026-08-16 하린아빠 지시로 32 → 96(헤더 마스코트와 동일 규격)으로 키운 자리다.
    ok(
      `대기중 마스코트가 ${GENIUS_MASCOT_HEIGHT_PX}px 로 눈에 보인다`,
      !!typing && typing.visible && typing.height === GENIUS_MASCOT_HEIGHT_PX,
      typing ? `height=${typing.height} visible=${typing.visible}` : "미렌더",
    );
    ok(
      "대기중 '답변 작성 중' status 가 함께 노출된다",
      !!typing && typing.statusRole,
      typing ? `statusRole=${typing.statusRole}` : "미렌더",
    );

    await waitCtx.close();
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
