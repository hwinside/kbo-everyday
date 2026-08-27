/**
 * 스모크: 어드민 로딩/인증 회복력 — 2026-08-26 (삼순 조건부 GO 범위).
 *
 *   P0-a 센티넬("session") x-admin-pin은 scryptSync/PIN 검증을 건너뛴다 (동시 7건 이벤트루프 블로킹 제거).
 *   P0-b verifyAdminSessionToken(=checkAdminSessionToken)이 supabase transient error를 not-found와 분리 →
 *        error는 상위 503, not-found/expired/revoked는 401. (유령 401/로그 0줄 방지)
 *   P1   requireAdmin이 401(미인증)과 503(세션 저장소 일시 장애)을 구분 매핑.
 *   P1   프론트 apiFetch가 401/503에 1회 재시도, 실패 시 빈 0 대시보드 대신 실패 UI.
 *   SSOT  센티넬 상수는 constants.ts 한 곳 — AdminShell/pin.ts가 리터럴 복제 없이 공유.
 *
 * 결함 주입으로 검증력 증명: 순수 classifyAdminSessionRow는 env/DB 없이 전 분기,
 * checkAdminAuth는 dummy env로 supabase를 '구성만' 하고 쿼리는 안 태운다(쿠키/토큰 없음).
 * 실행: npm run qa:admin-auth-loading
 */

// supabaseAdmin 싱글톤이 import 시점에 process.env를 읽어 createClient 한다(네트워크는 안 탐).
// checkAdminAuth의 동적 import 전에 dummy env를 심어 구성 실패를 막는다.
process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://dummy.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "dummy-service-role-key";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "dummy-anon-key";

import { readFileSync } from "node:fs";
import { classifyAdminSessionRow } from "../../src/lib/admin/session-policy";
import { ADMIN_SESSION_SENTINEL } from "../../src/lib/admin/constants";
import { checkAdminAuth, requireAdmin, verifyAdminPinValue } from "../../src/lib/admin/pin";

let pass = 0;
let fail = 0;
function check(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    pass++;
  } else {
    fail++;
    console.error(`  ✗ ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}

function req(headers: Record<string, string> = {}): Request {
  return new Request("https://x/api/admin/x", { headers: new Headers(headers) });
}

// ── P0-b classifier: transient error를 무효와 분리 (결함 주입) ──────────────
const now = 1_000_000_000;
const future = new Date(now + 60_000).toISOString();
const past = new Date(now - 60_000).toISOString();

check("classify valid", classifyAdminSessionRow({ expires_at: future, revoked_at: null }, null, now), "valid");
// 핵심: 유효해 보이는 행이 함께 와도 error가 우선 → "error"(=503). 되돌리면(error||!data→invalid) 이 줄이 RED.
check(
  "classify transient error wins over valid row",
  classifyAdminSessionRow({ expires_at: future, revoked_at: null }, { message: "conn reset" }, now),
  "error",
);
check("classify not-found -> invalid", classifyAdminSessionRow(null, null, now), "invalid");
check("classify revoked -> invalid", classifyAdminSessionRow({ expires_at: future, revoked_at: past }, null, now), "invalid");
check("classify expired -> invalid", classifyAdminSessionRow({ expires_at: past, revoked_at: null }, null, now), "invalid");
check("classify expiry boundary(==now) -> invalid", classifyAdminSessionRow({ expires_at: new Date(now).toISOString(), revoked_at: null }, null, now), "invalid");
check("classify null-expiry -> invalid", classifyAdminSessionRow({ expires_at: null, revoked_at: null }, null, now), "invalid");

// ── P0-a 센티넬 scrypt/PIN skip (결함 주입) ───────────────────────────────
// ADMIN_PIN을 센티넬 값으로 심으면 verifyAdminPinValue(sentinel)=true → 가드가 없으면 "ok"로 auth됨.
// 가드가 있으면 PIN 검증을 건너뛰고 쿠키 없음 → "unauthorized". 이게 skip의 결정적 증거.
process.env.ADMIN_PIN = ADMIN_SESSION_SENTINEL;
delete process.env.ADMIN_PIN_HASH;
check("sanity: sentinel WOULD auth if not skipped", verifyAdminPinValue(ADMIN_SESSION_SENTINEL), true);

async function run() {
  check(
    "sentinel header skips PIN -> unauthorized(no cookie)",
    await checkAdminAuth(req({ "x-admin-pin": ADMIN_SESSION_SENTINEL })),
    "unauthorized",
  );

  // 실제 PIN은 여전히 통과, 오답은 미인증 (센티넬 skip이 정상 PIN을 막지 않음)
  process.env.ADMIN_PIN = "realsecret-1234";
  delete process.env.ADMIN_PIN_HASH;
  check("real pin -> ok", await checkAdminAuth(req({ "x-admin-pin": "realsecret-1234" })), "ok");
  check("wrong pin no cookie -> unauthorized", await checkAdminAuth(req({ "x-admin-pin": "nope-nope-nope" })), "unauthorized");
  check("sentinel not treated as pin even with real ADMIN_PIN set", await checkAdminAuth(req({ "x-admin-pin": ADMIN_SESSION_SENTINEL })), "unauthorized");

  // ── P1 requireAdmin 401 매핑 (503 분기는 아래 소스 구조로 검증) ──
  const denied = await requireAdmin(req({ "x-admin-pin": "nope-nope-nope" }));
  check("requireAdmin unauthorized -> Response", denied instanceof Response, true);
  check("requireAdmin unauthorized -> 401", denied?.status, 401);
  process.env.ADMIN_PIN = "realsecret-1234";
  check("requireAdmin ok -> null", await requireAdmin(req({ "x-admin-pin": "realsecret-1234" })), null);
}

// ── 소스 구조 계약 (런타임 DB 주입이 불가한 분기 보강) ─────────────────────
const pinSrc = readFileSync("src/lib/admin/pin.ts", "utf8");
check("pin.ts: sentinel guard present", /pin\s*!==\s*ADMIN_SESSION_SENTINEL/.test(pinSrc), true);
check("pin.ts: requireAdmin maps unavailable->503", /unavailable[\s\S]*?status:\s*503/.test(pinSrc), true);
check("pin.ts: requireAdmin default->401", /status:\s*401/.test(pinSrc), true);

const sessionSrc = readFileSync("src/lib/admin/session.ts", "utf8");
check("session.ts: uses classifier", /classifyAdminSessionRow\(/.test(sessionSrc), true);
check("session.ts: console.error on transient error", /console\.error\(\s*"\[admin-session\]/.test(sessionSrc), true);
check("session.ts: TTL cache present", /sessionCache\.set\(/.test(sessionSrc), true);

const shellSrc = readFileSync("src/app/admin/AdminShell.tsx", "utf8");
check("AdminShell: sentinel from constants SSOT (no literal dup)", /ADMIN_SESSION_SENTINEL/.test(shellSrc) && !/=\s*"session"/.test(shellSrc), true);

const pageSrc = readFileSync("src/app/admin/page.tsx", "utf8");
check("page.tsx: apiFetch retries on 401/503", /status\s*===\s*401\s*\|\|\s*res\.status\s*===\s*503/.test(pageSrc), true);
check("page.tsx: failure UI (no empty-0 dashboard)", /setFailed\(true\)/.test(pageSrc) && /if \(failed\)/.test(pageSrc), true);

run()
  .then(() => {
    console.log(`\nadmin-auth-loading-smoke: ${pass} passed, ${fail} failed`);
    if (fail > 0) process.exit(1);
  })
  .catch((e) => {
    console.error("smoke threw:", e);
    process.exit(1);
  });
