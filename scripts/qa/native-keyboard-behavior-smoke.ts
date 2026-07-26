// Behavioral 회귀 — iOS 네이티브 키보드 오버레이 동시성(삼순 #883 왕복2 blocker).
// 문자열 검사가 아니라 실제 beginOverlayKeyboard 를 fake bridge 로 구동해 관찰 가능한 동작을 검증한다.
//   ① listener 부분실패 시 성공 handle 을 반드시 remove + fallback 전환(handle 유실 0)
//   ② close→reopen 겹침에서 baseline resize mode 오염 없이 최종 Native 로 복원
//   ③ restore 에서 setScroll 이 throw 해도 setResizeMode(baseline) 복원이 실행됨
//
// jsdom/브라우저 불필요 — 순수 Promise 오케스트레이션만 검증한다.

import type { PluginListenerHandle } from "@capacitor/core";
import {
  beginOverlayKeyboard,
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

const flush = () => new Promise((r) => setTimeout(r, 0));
async function settle(times = 12) {
  for (let i = 0; i < times; i += 1) await flush();
}

interface Call {
  op: string;
  arg?: unknown;
}

// 관찰 가능한 fake bridge. 실패를 주입할 수 있고 remove 호출을 기록한다.
function makeBridge(opts: {
  failListener?: "show" | "hide" | null;
  failSetScrollRestore?: boolean; // setScroll({isDisabled:false}) 만 throw
  startResizeMode?: string;
}) {
  const calls: Call[] = [];
  let removed = 0;
  let created = 0;
  let currentResizeMode = opts.startResizeMode ?? "native";

  const capturedBaselines: string[] = [];
  const bridge: KeyboardBridge = {
    getResizeMode: async () => {
      calls.push({ op: "getResizeMode" });
      capturedBaselines.push(currentResizeMode);
      return { mode: currentResizeMode as never };
    },
    setResizeMode: async ({ mode }) => {
      calls.push({ op: "setResizeMode", arg: mode });
      currentResizeMode = mode as unknown as string;
    },
    setScroll: async ({ isDisabled }) => {
      calls.push({ op: "setScroll", arg: isDisabled });
      if (!isDisabled && opts.failSetScrollRestore) {
        throw new Error("setScroll restore failed (injected)");
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
    get removed() {
      return removed;
    },
    get created() {
      return created;
    },
    get resizeMode() {
      return currentResizeMode;
    },
    get capturedBaselines() {
      return capturedBaselines;
    },
  };
}

async function main() {
  // ── ① listener 부분실패 → 성공 handle remove + fallback ──────────────────
  console.log("[① listener 부분실패 handle 유실 방지]");
  {
    __resetOverlayKeyboardStateForTest();
    const b = makeBridge({ failListener: "hide" });
    let fallback = 0;
    const handle = beginOverlayKeyboard({
      onHeight: () => {},
      onFallback: () => {
        fallback += 1;
      },
      bridge: b.bridge,
    });
    await settle();
    ok("성공한 listener(show) handle 이 remove 됨(유실 0)", b.created === 1 && b.removed === 1);
    ok("부분실패 시 onFallback 1회 호출", fallback === 1);
    ok("부분실패 시 setScroll(disabled) 미적용(native 활성 안 됨)",
      !b.calls.some((c) => c.op === "setScroll" && c.arg === true));
    ok("baseline resize mode 복원(최종 native)", b.resizeMode === "native");
    handle.release();
    await settle();
    ok("release 후 추가 fallback 없음", fallback === 1);
  }

  // ── ② close→reopen 전역 race → baseline 오염 없음 ─────────────────────────
  console.log("[② close→reopen 겹침 baseline 오염 방지]");
  {
    __resetOverlayKeyboardStateForTest();
    const b = makeBridge({ startResizeMode: "native" });
    // 첫 오버레이 열고 setup 완료
    const h1 = beginOverlayKeyboard({ onHeight: () => {}, onFallback: () => {}, bridge: b.bridge });
    await settle();
    ok("setup 후 resize None 적용", b.resizeMode === "none");
    // 겹침: release(h1) 직후 곧바로 reopen(h2) — 전역 chain 으로 직렬화돼야
    h1.release();
    const h2 = beginOverlayKeyboard({ onHeight: () => {}, onFallback: () => {}, bridge: b.bridge });
    await settle();
    // h2 활성 동안 resize 는 none
    ok("reopen 활성 중 resize None 유지", b.resizeMode === "none");
    // ★ 핵심 불변식: baseline 은 절대 오염된 값(none)으로 캡처되지 않는다.
    ok("baseline 캡처값이 절대 'none' 아님(오염 0)",
      b.capturedBaselines.length > 0 && b.capturedBaselines.every((m) => m !== "none"));
    h2.release();
    await settle();
    ok("마지막 오버레이 종료 시 baseline(native)로 복원", b.resizeMode === "native");
  }

  // ②-b 진짜 중첩(refcount>1): h1 활성 중 h2 열림 → h2 는 오염된 none 을 baseline 으로 읽지 않아야.
  {
    __resetOverlayKeyboardStateForTest();
    const b = makeBridge({ startResizeMode: "native" });
    const h1 = beginOverlayKeyboard({ onHeight: () => {}, onFallback: () => {}, bridge: b.bridge });
    await settle();
    const h2 = beginOverlayKeyboard({ onHeight: () => {}, onFallback: () => {}, bridge: b.bridge });
    await settle();
    ok("중첩 시 baseline 캡처 1회만(activeCount>0 이면 재캡처 skip)",
      b.calls.filter((c) => c.op === "getResizeMode").length === 1);
    h2.release();
    await settle();
    ok("중첩 해제 첫 release 에선 아직 native 복원 안 함(refcount 잔여)", b.resizeMode === "none");
    h1.release();
    await settle();
    ok("마지막 release 에서만 baseline(native) 복원", b.resizeMode === "native");
  }

  // ── ③ setScroll 복원 실패 시 setResizeMode 복원 미실행 방지 ────────────────
  console.log("[③ restore 부분실패 격리 — scroll throw 여도 resize 복원]");
  {
    __resetOverlayKeyboardStateForTest();
    const b = makeBridge({ startResizeMode: "native", failSetScrollRestore: true });
    let active: boolean | null = null;
    const h = beginOverlayKeyboard({
      onHeight: () => {},
      onFallback: () => {},
      onActiveChange: (a) => {
        active = a;
      },
      bridge: b.bridge,
    });
    await settle();
    ok("setup 후 native 활성(onActiveChange true)", active === true);
    ok("setup 후 resize None", b.resizeMode === "none");
    h.release();
    await settle();
    // setScroll(false) 는 throw 하지만 setResizeMode(native) 는 반드시 실행돼야
    ok("scroll 복원 throw 에도 resize baseline(native) 복원됨", b.resizeMode === "native");
    ok("scroll 복원 실패해도 onActiveChange(false) 통지", active === false);
    ok("setResizeMode 복원 호출이 실제 존재",
      b.calls.some((c) => c.op === "setResizeMode" && c.arg === "native"));
  }

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  if (fail > 0) process.exit(1);
}

void main();
