/**
 * 야잘알봇 대화는 push 알림 대상이 아니다 — **실제 `handleDm` 함수를 호출해** 고정.
 *
 * ⚠️ 이 게이트가 생긴 이유 (하린아빠 2026-08-04 20:33 "야잘알봇은 push알림에서 제외",
 * 삼순 계약: 생각중·답변·picker/ack 전부 포함).
 *
 * 종전 `handleDm` 은 **수신자만** 걸렀다(`receiver === BASEBALL_GENIUS_USER_ID`).
 * 그래서 유저 질문 → 봇 방향은 막혔지만 **봇 답변 → 유저**는 일반 DM 푸시를 그대로 타서
 * 질문 한 번에 알림이 울렸다.
 *
 * ⚠️ 그리고 이 게이트 자체가 한 번 false-green 이었다 (삼순 #1102 1차 P0-3).
 * 첫 버전은 소스에서 조건식을 regex 로 꺼내 평가했는데, **위쪽에 같은 모양의 decoy guard**
 * 를 하나 심어두면 실제 guard 를 `if (false)` 로 무력화해도 6/6 GREEN 이었다.
 * 소스 문자열로 의미를 추론하는 계약은 유지 불가능하다 — 그래서 지금은 `handleDm` 을
 * **그대로 호출해 반환 dispatch 개수**로 판정한다. guard 가 어떻게 깨지든 결과로 잡힌다.
 *
 * 실행: npm run qa:genius-push-exclusion
 */
import assert from "node:assert/strict";
import Module from "node:module";
import { BASEBALL_GENIUS_USER_ID } from "../../src/lib/constants/baseball-genius";

const GENIUS = BASEBALL_GENIUS_USER_ID;
const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const CONV = "33333333-3333-4333-8333-333333333333";

/**
 * `handleDm` 은 supabase admin 클라이언트를 module scope 에서 잡는다.
 * 실제 DB 를 붙일 수는 없으므로 **그 모듈만** 최소 stub 으로 바꾼다 —
 * 검증 대상인 dispatch route 자체는 배포 소스 그대로 로드된다.
 */
interface StubState { conv: { user1_id: string; user2_id: string } | null }
const state: StubState = { conv: null };

function stubSupabase() {
  const chain = (table: string) => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () =>
          table === "dm_conversations"
            ? { data: state.conv, error: null }
            : { data: { nickname: "테스트" }, error: null },
        limit: async () => ({ data: [], error: null }),
      }),
      in: async () => ({ data: [], error: null }),
    }),
    update: () => ({ eq: async () => ({ data: null, error: null }) }),
    insert: async () => ({ data: null, error: null }),
  });
  return { from: (table: string) => chain(table) };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- CJS resolve hook 교체
const origLoad = (Module as any)._load;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Module as any)._load = function patched(request: string, parent: unknown, isMain: boolean) {
  if (request.includes("supabase/admin")) {
    return { supabaseAdmin: stubSupabase() };
  }
  if (request.includes("notifications/fcm")) {
    return { sendFcmToUsers: async () => ({ sent: 0 }) };
  }
  if (request.includes("notifications/audience")) {
    return { fetchFavoritePlayerFanIds: async () => [] };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, prefer-rest-params
  return origLoad.apply(this, arguments as any);
};

let pass = 0;
const failures: string[] = [];
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    pass += 1;
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failures.push(`${name}: ${(error as Error).message}`);
    console.error(`  ❌ ${name}: ${(error as Error).message}`);
  }
}

async function main() {
  const mod = await import("../../src/app/api/notifications/dispatch/route");
  const handleDm = (mod as { handleDm?: (r: Record<string, unknown>) => Promise<unknown[]> }).handleDm;
  assert.equal(
    typeof handleDm, "function",
    "dispatch route 가 handleDm 을 export 하지 않는다 — 실제 함수를 호출할 수 없다",
  );

  /** 실제 `handleDm` 을 호출해 push dispatch 개수를 돌려준다. */
  const dispatchCount = async (senderId: string, receiverId: string) => {
    state.conv = { user1_id: senderId, user2_id: receiverId };
    const out = await handleDm!({
      conversation_id: CONV,
      sender_id: senderId,
      content: "보크가 뭐야?",
      image_urls: null,
      payload: null,
    });
    return out.length;
  };

  // ── 야잘알봇 축: 양방향 모두 push 0 ────────────────────────────────────────
  await check("유저 질문 → 봇: dispatch 0", async () =>
    assert.equal(await dispatchCount(USER_A, GENIUS), 0));
  await check("봇 답변 → 유저: dispatch 0 (이번 계약)", async () =>
    assert.equal(await dispatchCount(GENIUS, USER_A), 0));
  await check("봇 picker 되묻기 → 다른 유저: dispatch 0", async () =>
    assert.equal(await dispatchCount(GENIUS, USER_B), 0));

  // ── 일반 DM 은 무회귀 ─────────────────────────────────────────────────────
  // 봇만 빼는 것이지 쪽지 알림을 끄는 게 아니다. 여기가 0 이 되면 과차단 회귀다.
  await check("일반 유저 → 유저 DM: dispatch 1", async () =>
    assert.equal(await dispatchCount(USER_A, USER_B), 1));
  await check("반대 방향 일반 DM: dispatch 1", async () =>
    assert.equal(await dispatchCount(USER_B, USER_A), 1));

  // ── 봇 id SSOT ────────────────────────────────────────────────────────────
  await check("dispatch route 가 봇 uuid 를 하드코딩하지 않는다", async () => {
    const { readFileSync } = await import("node:fs");
    const nodePath = await import("node:path");
    const source = readFileSync(
      nodePath.join(process.cwd(), "src/app/api/notifications/dispatch/route.ts"), "utf8");
    assert.ok(
      !new RegExp(`["']${GENIUS}["']`).test(source),
      "봇 uuid 가 하드코딩돼 있다 — 상수와 어긋나면 조용히 새어나간다",
    );
  });

  if (failures.length > 0) {
    console.error(`\n❌ genius push exclusion: PASS=*** FAIL=${failures.length}`);
    process.exit(1);
  }
  console.log(`\n✅ genius push exclusion: ${pass} PASS (실제 handleDm 호출 · 봇 양방향 0 · 일반 DM 1)`);
}

main().catch((error) => {
  console.error("❌ genius push exclusion FAIL:", error);
  process.exit(1);
});
