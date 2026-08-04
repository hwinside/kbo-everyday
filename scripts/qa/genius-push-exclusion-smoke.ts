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
/** POST 종단 검증용 — 실제 발송 시도된 FCM 대상 목록. */
const fcmCalls: string[][] = [];

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
// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
(Module as any)._load = function patched(request: string, _parent: unknown, _isMain: boolean) {
  if (request.includes("supabase/admin")) {
    return { supabaseAdmin: stubSupabase() };
  }
  if (request.includes("notifications/fcm")) {
    return {
      sendFcmToUsers: async (userIds: string[]) => {
        fcmCalls.push(userIds);
        return { sent: userIds.length };
      },
    };
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
  process.env.NOTIFICATIONS_WEBHOOK_SECRET = "qa-secret";
  const mod = await import("../../src/app/api/notifications/dispatch/route");
  const POST = (mod as { POST?: (req: unknown) => Promise<Response> }).POST;
  assert.equal(typeof POST, "function", "dispatch route 가 POST 를 export 하지 않는다");

  /** 실제 POST webhook 종단. 대화 참여자는 고정하고 sender 만 바꿔 양쪽 ternary 를 태운다. */
  const postDispatch = async (
    senderId: string,
    user1Id: string,
    user2Id: string,
    content = "보크가 뭐야?",
  ) => {
    state.conv = { user1_id: user1Id, user2_id: user2Id };
    fcmCalls.length = 0;
    const res = await POST!({
      headers: { get: (k: string) => (k === "x-webhook-secret" ? "qa-secret" : null) },
      json: async () => ({
        table: "dm_messages",
        record: {
          conversation_id: CONV, sender_id: senderId,
          content, image_urls: null, payload: null,
        },
      }),
    });
    const body = await (res as unknown as {
      json: () => Promise<{ ok?: boolean; ignored?: string; dispatches?: number; sent?: number }>;
    }).json();
    return { status: (res as unknown as { status: number }).status, fcm: [...fcmCalls], body };
  };

  const assertBotSuppressed = (r: Awaited<ReturnType<typeof postDispatch>>) => {
    assert.equal(r.status, 200, `HTTP ${r.status}`);
    assert.equal(r.body.ok, true, `body=${JSON.stringify(r.body)}`);
    assert.equal(r.body.dispatches, 0, `dispatches=${r.body.dispatches}`);
    assert.equal(r.body.sent, 0, `sent=${r.body.sent}`);
    assert.deepEqual(r.fcm, [], `FCM=${JSON.stringify(r.fcm)}`);
    assert.notEqual(r.body.ignored, "dm_messages", "POST dm_messages 배선 단절");
  };

  await check("POST 종단: 유저 질문 → 봇 200/dispatch0/sent0/FCM0", async () =>
    assertBotSuppressed(await postDispatch(USER_A, USER_A, GENIUS)));
  await check("POST 종단: 봇 답변 → 유저 200/dispatch0/sent0/FCM0", async () =>
    assertBotSuppressed(await postDispatch(GENIUS, USER_A, GENIUS, "답변입니다")));
  await check("POST 종단: 봇 picker → 다른 유저 200/dispatch0/sent0/FCM0", async () =>
    assertBotSuppressed(await postDispatch(GENIUS, USER_B, GENIUS, "어느 선수를 말씀하시나요?")));

  const assertGeneralDm = (
    r: Awaited<ReturnType<typeof postDispatch>>,
    expectedReceiver: string,
  ) => {
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.dispatches, 1);
    assert.equal(r.body.sent, 1);
    assert.deepEqual(r.fcm, [[expectedReceiver]], `FCM target=${JSON.stringify(r.fcm)}`);
  };
  await check("POST 종단: 고정 대화 A(user1)→B(user2), target B", async () =>
    assertGeneralDm(await postDispatch(USER_A, USER_A, USER_B), USER_B));
  await check("POST 종단: 고정 대화 B(user2)→A(user1), target A", async () =>
    assertGeneralDm(await postDispatch(USER_B, USER_A, USER_B), USER_A));

  await check("dispatch route 가 봇 uuid 를 하드코딩하지 않는다", async () => {
    const { readFileSync } = await import("node:fs");
    const nodePath = await import("node:path");
    const source = readFileSync(
      nodePath.join(process.cwd(), "src/app/api/notifications/dispatch/route.ts"), "utf8");
    assert.ok(!new RegExp(`["']${GENIUS}["']`).test(source), "봇 uuid 하드코딩");
    assert.ok(!source.includes("export async function handleDm"),
      "Next route.ts 에 비허용 helper export — production build 실패 위험");
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
