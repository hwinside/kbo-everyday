#!/usr/bin/env node
/**
 * 스모크: 어드민 야잘알봇 대화 모니터링 route (/api/admin/baseball-genius)
 *   ① 비로그인(무인증) → 401 차단
 *   ② 잘못된 PIN → 401 차단
 *   ③ 관리자 PIN → 200 + conversations 배열 + keyset nextCursor 계약
 *   ④ 잘못된 cursor → 400
 *   ⑤ 읽기 전용 — POST 는 405 (핸들러 미노출)
 * 실행: BASE_URL=http://localhost:3000 ADMIN_PIN=... npm run qa:admin-genius-monitor
 */
const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const ADMIN_PIN = process.env.ADMIN_PIN;

if (!ADMIN_PIN) {
  console.error("[admin-genius-monitor] ADMIN_PIN is required");
  process.exit(1);
}

let checks = 0;
function check(condition, message) {
  if (!condition) throw new Error(message);
  checks += 1;
}

async function main() {
  const url = `${BASE_URL}/api/admin/baseball-genius`;

  // ① 무인증 차단
  const anon = await fetch(url);
  check(anon.status === 401, `anonymous request must be 401, got ${anon.status}`);

  // ② 잘못된 PIN 차단
  const badPin = await fetch(url, { headers: { "x-admin-pin": "wrong-pin-000" } });
  check(badPin.status === 401, `wrong pin must be 401, got ${badPin.status}`);

  // ③ 관리자 200 + 목록 계약
  const ok = await fetch(url, { headers: { "x-admin-pin": ADMIN_PIN } });
  check(ok.status === 200, `admin request must be 200, got ${ok.status}`);
  const json = await ok.json();
  check(Array.isArray(json.conversations), "conversations must be an array");
  check(json.conversations.length <= 50, "page must be bounded to 50 conversations");
  check(
    json.nextCursor === null ||
      (typeof json.nextCursor?.lastMessageAt === "string" &&
        typeof json.nextCursor?.conversationId === "string"),
    "nextCursor must be null or a keyset cursor"
  );

  // ④ 잘못된 cursor → 400
  const badCursor = await fetch(`${url}?cursorAt=not-a-date&cursorId=nope`, {
    headers: { "x-admin-pin": ADMIN_PIN },
  });
  check(badCursor.status === 400, `invalid cursor must be 400, got ${badCursor.status}`);

  // ⑤ 읽기 전용 (POST 미노출)
  const post = await fetch(url, {
    method: "POST",
    headers: { "x-admin-pin": ADMIN_PIN, "Content-Type": "application/json" },
    body: "{}",
  });
  check(post.status === 405, `POST must be 405 (read-only route), got ${post.status}`);

  console.log(`[admin-genius-monitor] PASS — ${checks} checks`);
}

main().catch((error) => {
  console.error("[admin-genius-monitor] FAIL:", error.message);
  process.exit(1);
});
