/**
 * 야잘알봇 대화는 push 알림 대상이 아니다 — **실제 배포 dispatch 로직**으로 고정.
 *
 * ⚠️ 이 게이트가 생긴 이유 (하린아빠 2026-08-04 20:33 "야잘알봇은 push알림에서 제외",
 * 삼순 계약: 생각중·답변·picker/ack 전부 포함).
 *
 * 종전 `handleDm` 은 **수신자만** 걸렀다(`receiver === BASEBALL_GENIUS_USER_ID`).
 * 그래서 유저 질문 → 봇 방향은 막혔지만, **봇 답변 → 유저** 방향은 일반 DM 푸시를
 * 그대로 타서 질문 한 번에 알림이 울렸다. 봇은 유저가 화면에서 기다리는 대화형 기능이라
 * 푸시가 필요 없고, picker 되묻기까지 알림이 가면 소음이 된다.
 *
 * 반대로 **일반 DM 푸시는 회귀하면 안 된다** — 봇만 빼는 것이지 쪽지 알림을 끄는 게 아니다.
 * 그래서 양방향을 같이 태운다.
 *
 * 실행: npm run qa:genius-push-exclusion
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { BASEBALL_GENIUS_USER_ID } from "../../src/lib/constants/baseball-genius";

const ROUTE = path.join(process.cwd(), "src/app/api/notifications/dispatch/route.ts");
const source = readFileSync(ROUTE, "utf8");

let pass = 0;
const failures: string[] = [];
function check(name: string, fn: () => void) {
  try {
    fn();
    pass += 1;
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failures.push(`${name}: ${(error as Error).message}`);
    console.error(`  ❌ ${name}: ${(error as Error).message}`);
  }
}

/**
 * `handleDm` 의 야잘알봇 게이트를 **소스에서 직접 추출해 실행**한다.
 *
 * 문자열 포함 검사(`source.includes("senderId === BASEBALL_GENIUS")`)로 두면 조건을
 * `&&` 로 바꾸거나 주석 처리해도 통과할 수 있다. 실제 boolean 식을 꺼내 평가한다.
 */
function extractGuard(): (senderId: string, receiver: string) => boolean {
  const m = source.match(
    /if \((receiver === BASEBALL_GENIUS_USER_ID[^)]*|senderId === BASEBALL_GENIUS_USER_ID[^)]*)\) return \[\];/,
  );
  assert.ok(m, "handleDm 의 야잘알봇 push 게이트 조건을 소스에서 찾지 못했다");
  const expr = m[1];
  // eslint-disable-next-line no-new-func -- 배포 소스의 실제 조건식을 그대로 평가한다
  return new Function(
    "senderId", "receiver", "BASEBALL_GENIUS_USER_ID", `return Boolean(${expr});`,
  ) as (s: string, r: string) => boolean;
}

const guardExpr = extractGuard();
const GENIUS = BASEBALL_GENIUS_USER_ID;
const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const skip = (senderId: string, receiver: string) =>
  (guardExpr as unknown as (s: string, r: string, g: string) => boolean)(senderId, receiver, GENIUS);

// ── 야잘알봇 축: 양방향 모두 push 제외 ──────────────────────────────────────
check("유저 질문 → 봇: push 안 만든다", () => assert.equal(skip(USER_A, GENIUS), true));
check("봇 답변 → 유저: push 안 만든다 (이번 계약)", () => assert.equal(skip(GENIUS, USER_A), true));
check("봇 picker 되묻기 → 유저: push 안 만든다", () => assert.equal(skip(GENIUS, USER_B), true));

// ── 일반 DM 은 무회귀 ───────────────────────────────────────────────────────
check("일반 유저 → 유저 DM: push 유지", () => assert.equal(skip(USER_A, USER_B), false));
check("일반 유저 → 다른 유저 DM: push 유지", () => assert.equal(skip(USER_B, USER_A), false));

// ── 계약 문서화 — 봇 id 가 상수 SSOT 에서 온다 ──────────────────────────────
check("게이트가 상수 SSOT 를 쓴다(하드코딩 uuid 아님)", () => {
  assert.ok(
    source.includes('import { BASEBALL_GENIUS_USER_ID }') ||
    /BASEBALL_GENIUS_USER_ID.*from "@\/lib\/constants\/baseball-genius"/.test(source),
    "dispatch route 가 봇 id 를 상수에서 import 하지 않는다",
  );
  assert.ok(
    !new RegExp(`["']${GENIUS}["']`).test(source),
    "dispatch route 에 봇 uuid 가 하드코딩돼 있다 — 상수와 어긋나면 조용히 새어나간다",
  );
});

if (failures.length > 0) {
  console.error(`\n❌ genius push exclusion: PASS=*** FAIL=${failures.length}`);
  process.exit(1);
}
console.log(`\n✅ genius push exclusion: ${pass} PASS (봇 양방향 제외 + 일반 DM 무회귀)`);
