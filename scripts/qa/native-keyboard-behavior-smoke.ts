// Behavioral 회귀 — iOS 네이티브 키보드 오버레이 전역 lease(삼순 #883 왕복3 blocker).
// 문자열 검사가 아니라 실제 beginOverlayKeyboard 를 fake bridge 로 구동해, delayed/rejected 주입으로
// 상태 정합을 검증한다. fake bridge 는 "applied-then-reject"(네이티브 side effect 는 적용됐는데 응답만
// reject)를 모델링해 실제 native scroll/resize 상태를 추적한다.
//   ① setScroll(true) applied-then-reject → fallback 뒤 native disabled 잔류 0
//   ② setScroll(false) restore reject → native active 인데 guard 조기 재활성화 금지(isNativeKeyboardScrollActive)
//   ③ setResizeMode(baseline) restore reject → 다음 open 이 오염값(none) 재캡처 안 함(baseline poisoning 0)
//   ④ 2 active 중 1 release → 남은 오버레이의 native scroll 유지(scroll 도 전역 refCount lease)

import type { PluginListenerHandle } from "@capacitor/core";
import {
  beginOverlayKeyboard,
  isNativeKeyboardScrollActive,
  __resetOverlayKeyboardStateForTest,
  type KeyboardBridge,
} from "../../src/lib/capacitor/native-keyboard";

let pass = 0;
let fail = 0;
function ok(label: string, cond: boolean) {
  if (cond) {
    pass += 1;
    console.log(`  ✅ ${label}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${label}`);
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function settle(times = 14) {
  for (let i = 0; i < times; i += 1) await wait(0);
}

interface Call {
  op: string;
  arg?: unknown;
}

// 관찰 가능한 fake bridge — 실제 native scroll/resize 상태를 추적하고 실패를 주입한다.
function makeBridge(opts: {
  failListener?: "show" | "hide" | null;
  // "applied-then-reject": native side effect 는 적용하고 promise 만 reject
  failSetScrollDisable?: boolean; // setScroll(true) 응답 reject(적용은 됨)
  failSetScrollEnable?: boolean; // setScroll(false) 응답 reject(적용은 됨)
  failSetResizeRestore?: boolean; // setResizeMode(baseline) 응답 reject(적용은 됨)
  startResizeMode?: string;
} = {}) {
  const calls: Call[] = [];
  const capturedBaselines: string[] = [];
  let removed = 0;
  let created = 0;
  let nativeResizeMode = opts.startResizeMode ?? "native";
  let nativeScrollDisabled = false;

  const bridge: KeyboardBridge = {
    getResizeMode: async () => {
      calls.push({ op: "getResizeMode" });
      capturedBaselines.push(nativeResizeMode);
      return { mode: nativeResizeMode as never };
    },
    setResizeMode: async ({ mode }) => {
      calls.push({ op: "setResizeMode", arg: mode });
      nativeResizeMode = mode as unknown as string; // side effect 적용
      if (mode !== "none" && opts.failSetResizeRestore) {
        throw new Error("setResizeMode restore rejected (applied-then-reject)");
      }
    },
    setScroll: async ({ isDisabled }) => {
      calls.push({ op: "setScroll", arg: isDisabled });
      nativeScrollDisabled = isDisabled; // side effect 적용
      if (isDisabled && opts.failSetScrollDisable) {
        throw new Error("setScroll(true) rejected (applied-then-reject)");
      }
      if (!isDisabled && opts.failSetScrollEnable) {
        throw new Error("setScroll(false) rejected (applied-then-reject)");
      }
    },
    addListener: async (eventName) => {
      if (
        (opts.failListener === "show" && eventName === "keyboardWillShow") ||
        (opts.failListener === "hide" && eventName === "keyboardWillHide")
      ) {
        throw new Error(`addListener ${eventName} failed (injected)`);
      }
      created += 1;
      const handle: PluginListenerHandle = {
        remove: async () => {
          removed += 1;
        },
      };
      return handle;
    },
  };

  return {
    bridge,
    calls,
    capturedBaselines,
    get removed() {
      return removed;
    },
    get created() {
      return created;
    },
    get nativeResizeMode() {
      return nativeResizeMode;
    },
    get nativeScrollDisabled() {
      return nativeScrollDisabled;
    },
  };
}

async function main() {
  // ── 기본: 정상 apply/release ────────────────────────────────────────────
  console.log("[기본 apply/release 정합]");
  {
    __resetOverlayKeyboardStateForTest();
    const b = makeBridge();
    const h = beginOverlayKeyboard({ onHeight: () => {}, onFallback: () => {}, bridge: b.bridge });
    await settle();
    ok("apply 후 native resize None + scroll disabled", b.nativeResizeMode === "none" && b.nativeScrollDisabled);
    ok("apply 후 guard 활성(isNativeKeyboardScrollActive true)", isNativeKeyboardScrollActive() === true);
    h.release();
    await settle();
    ok("release 후 native resize baseline(native) + scroll enabled", b.nativeResizeMode === "native" && !b.nativeScrollDisabled);
    ok("release 후 guard 비활성", isNativeKeyboardScrollActive() === false);
  }

  // ── ① listener 부분실패 → handle 수거 + fallback ─────────────────────────
  console.log("[① listener 부분실패 handle 유실 방지]");
  {
    __resetOverlayKeyboardStateForTest();
    const b = makeBridge({ failListener: "hide" });
    let fallback = 0;
    beginOverlayKeyboard({ onHeight: () => {}, onFallback: () => (fallback += 1), bridge: b.bridge });
    await settle();
    ok("성공 handle(show) remove(유실 0)", b.created === 1 && b.removed === 1);
    ok("onFallback 1회 + native scroll 미적용", fallback === 1 && !b.nativeScrollDisabled);
  }

  // ── ① setScroll(true) applied-then-reject → fallback 뒤 disabled 잔류 0 ───
  console.log("[① setScroll(true) applied-then-reject 롤백]");
  {
    __resetOverlayKeyboardStateForTest();
    const b = makeBridge({ failSetScrollDisable: true });
    let fallback = 0;
    beginOverlayKeyboard({ onHeight: () => {}, onFallback: () => (fallback += 1), bridge: b.bridge });
    await settle();
    ok("응답 reject(적용됨) → onFallback 1회", fallback === 1);
    ok("★ native scroll disabled 잔류 0(setScroll(false)로 롤백)", b.nativeScrollDisabled === false);
    ok("resize 도 baseline(native)로 롤백", b.nativeResizeMode === "native");
    ok("guard 비활성(조기 활성 안 됨)", isNativeKeyboardScrollActive() === false);
  }

  // ── ② setScroll(false) restore reject → guard 조기 재활성화 금지 ──────────
  console.log("[② restore setScroll(false) reject — guard 조기 재활성화 금지]");
  {
    __resetOverlayKeyboardStateForTest();
    const b = makeBridge({ failSetScrollEnable: true });
    const h = beginOverlayKeyboard({ onHeight: () => {}, onFallback: () => {}, bridge: b.bridge });
    await settle();
    ok("apply 후 guard 활성", isNativeKeyboardScrollActive() === true);
    h.release();
    await settle(2); // retry 이전 첫 restore 시점
    // setScroll(false) 응답이 reject → nativeScrollActive 유지(false 통지 금지)
    ok("★ restore reject 시 guard 활성 유지(복원 성공 전 false 통지 금지)", isNativeKeyboardScrollActive() === true);
    await wait(200); // bounded retry 경과
    await settle();
    // fake bridge 는 setScroll(false) 를 매번 reject → retry 소진 후에도 native 는 enable(적용은 됨)
    ok("bounded retry 소진 후 native scroll 은 enable(적용됨)", b.nativeScrollDisabled === false);
    const enableCalls = b.calls.filter((c) => c.op === "setScroll" && c.arg === false).length;
    ok("bounded retry 유계(setScroll(false) 호출 ≤ 1+최대재시도)", enableCalls >= 2 && enableCalls <= 4);
  }

  // ── ③ resize restore reject → baseline poisoning 0 ───────────────────────
  console.log("[③ resize restore reject — baseline poisoning 방지]");
  {
    __resetOverlayKeyboardStateForTest();
    const b = makeBridge({ startResizeMode: "native", failSetResizeRestore: true });
    const h1 = beginOverlayKeyboard({ onHeight: () => {}, onFallback: () => {}, bridge: b.bridge });
    await settle();
    ok("첫 apply 후 resize None", b.nativeResizeMode === "none");
    h1.release();
    await settle(2);
    // setResizeMode(baseline=native) 적용은 되지만 응답 reject → resizeNoneApplied 유지, baseline 보존
    // 다음 open 은 baseline 을 재캡처하지 않아야(오염된 현재값 무시)
    const capturesBefore = b.capturedBaselines.length;
    const h2 = beginOverlayKeyboard({ onHeight: () => {}, onFallback: () => {}, bridge: b.bridge });
    await settle();
    ok("★ 다음 open 이 baseline 재캡처 안 함(pending 유지)", b.capturedBaselines.length === capturesBefore);
    h2.release();
    await wait(200);
    await settle();
    // 모든 캡처된 baseline 이 'none' 아님(poisoning 0)
    ok("★ 캡처 baseline 절대 'none' 아님(poisoning 0)",
      b.capturedBaselines.length > 0 && b.capturedBaselines.every((m) => m !== "none"));
  }

  // ── ④ 2 active 중 1 release → 남은 오버레이 native scroll 유지 ────────────
  console.log("[④ 2 active 중 1 release — scroll 전역 refCount lease]");
  {
    __resetOverlayKeyboardStateForTest();
    const b = makeBridge({ startResizeMode: "native" });
    const h1 = beginOverlayKeyboard({ onHeight: () => {}, onFallback: () => {}, bridge: b.bridge });
    await settle();
    const h2 = beginOverlayKeyboard({ onHeight: () => {}, onFallback: () => {}, bridge: b.bridge });
    await settle();
    ok("2 active — native scroll disabled", b.nativeScrollDisabled === true);
    h1.release();
    await settle();
    ok("★ 1 release 후에도 native scroll disabled 유지(refCount>0)", b.nativeScrollDisabled === true);
    ok("★ 1 release 후 resize None 유지", b.nativeResizeMode === "none");
    ok("★ 1 release 후 guard 활성 유지", isNativeKeyboardScrollActive() === true);
    ok("setScroll(false) 미호출(마지막 release 전)",
      !b.calls.some((c) => c.op === "setScroll" && c.arg === false));
    h2.release();
    await settle();
    ok("마지막 release 에서만 native scroll enable", b.nativeScrollDisabled === false);
    ok("마지막 release 후 guard 비활성", isNativeKeyboardScrollActive() === false);
  }

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  if (fail > 0) process.exit(1);
}

void main();
