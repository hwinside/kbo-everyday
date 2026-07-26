// iOS 네이티브 키보드 제어 — @capacitor/keyboard 브릿지.
//
// 스토리 댓글 바텀시트에서 WKWebView 기본 자동스크롤과 visualViewport 보정이 동시에
// 적용되면 배경이 밀리고 시트가 진동한다. 새 네이티브 바이너리에서는 WebView 리사이즈와
// 자동스크롤을 끄고, 플러그인이 주는 정확한 키보드 높이로 시트를 직접 배치한다.
// 플러그인이 없는 기존 바이너리·웹/PWA는 기존 visualViewport 경로를 유지한다.
//
// 동시성 계약(삼순 #883 왕복4 blocker 반영) — resize/scroll 을 전역 refCount lease + idempotent reconcile 로 관리.
//   ⭐ 근본: reject 뒤 실제 native 상태(적용 전 실패 vs 적용 후 응답 실패)를 보장 못 하므로, 낙관적
//      applied-flag 으로 skip 하지 않는다. want=true 면 항상 setResizeMode(None)+setScroll(true)를
//      재발행(idempotent) → restore applied-then-reject 로 native 가 baseline 으로 돌아갔어도 reopen 이
//      desired 를 확실히 재적용한다.
//   ② 복원 통지는 실제 성공 후에만 — setScroll(false)+setResizeMode(baseline) 둘 다 성공해야 nativeScrollActive=false.
//      실패하면 상태 유지 + bounded retry. guard(root scroll)는 전역 getter 를 읽어 복원 전 조기 재활성화 안 됨.
//   ②-B terminal fail-safe: retry 예산 소진까지 복원 실패하면 lease 를 버리고 web guard 재활성화·상태
//      리셋 → 영구 잔류(resize none+scroll disabled+guard true)를 막고 다음 open 이 처음부터 재초기화된다.
//   ③ baseline 은 lease 미보유(null)일 때만 캡처 → 복원 pending 으로 held 면 오염값(none) 재캡처 안 함.
//   ④ scroll 도 resize 와 동일한 전역 refCount lease — 두 오버레이 active 중 하나 release 해도 refCount>0 이면
//      restore 가 안 돌아 나머지 오버레이의 native scroll 제어가 유지된다.

import { Capacitor, type PluginListenerHandle } from "@capacitor/core";
import {
  Keyboard,
  KeyboardResize,
  type KeyboardResizeOptions,
} from "@capacitor/keyboard";
import { isIosNativeRuntime } from "./platform";

type ResizeMode = KeyboardResizeOptions["mode"];

/** 테스트/실기기 공용 최소 브릿지 인터페이스(behavioral 회귀용 주입 지점). */
export interface KeyboardBridge {
  getResizeMode: () => Promise<{ mode: ResizeMode }>;
  setResizeMode: (options: { mode: ResizeMode }) => Promise<void>;
  setScroll: (options: { isDisabled: boolean }) => Promise<void>;
  addListener: (
    eventName: "keyboardWillShow" | "keyboardWillHide",
    handler: (info: { keyboardHeight: number }) => void,
  ) => Promise<PluginListenerHandle>;
}

const realBridge: KeyboardBridge = {
  getResizeMode: () => Keyboard.getResizeMode(),
  setResizeMode: (options) => Keyboard.setResizeMode({ mode: options.mode }),
  setScroll: (options) => Keyboard.setScroll({ isDisabled: options.isDisabled }),
  addListener: (eventName, handler) =>
    eventName === "keyboardWillShow"
      ? Keyboard.addListener("keyboardWillShow", handler as never)
      : Keyboard.addListener("keyboardWillHide", handler as never),
};

interface InjectedCapacitor {
  isPluginAvailable?: (name: string) => boolean;
}

function hasKeyboardPlugin(): boolean {
  try {
    if (Capacitor.isPluginAvailable("Keyboard")) return true;
  } catch {
    /* static bridge 판정 실패 시 injected bridge 확인 */
  }
  if (typeof window === "undefined") return false;
  try {
    return (
      (window as unknown as { Capacitor?: InjectedCapacitor })
        .Capacitor?.isPluginAvailable?.("Keyboard") === true
    );
  } catch {
    return false;
  }
}

export interface OverlayKeyboardHandle {
  release: () => void;
}

export interface BeginOverlayKeyboardOptions {
  /** keyboardWillShow/Hide 로 전달되는 키보드 높이(px). 종료 시 0. */
  onHeight: (height: number) => void;
  /**
   * 브릿지 호출 실패(부분 실패 포함) 시 1회 호출. 호출부는 native 경로를 접고
   * web visualViewport 폴백으로 복귀해야 한다. release 이후에는 호출하지 않는다.
   */
  onFallback: () => void;
  /** 테스트 전용 브릿지 주입. 미지정 시 실제 @capacitor/keyboard 브릿지. */
  bridge?: KeyboardBridge;
}

// ── 전역 lease 매니저 상태 ─────────────────────────────────────────────────
// 삼순 왕복4: 낙관적 applied-flag 는 "적용 전 실패 / 적용 후 응답 실패"를 구분 못해 reject 시 실제
// native 상태와 어긋난다. 따라서 flag skip 최적화를 버리고 desired 상태를 매 reconcile 마다
// idempotent 하게 재수렴한다. baseline 은 lease 보유 여부(null 아님)로만 판단한다.
let opChain: Promise<void> = Promise.resolve();
let refCount = 0; // 활성 오버레이 수(scroll/resize 공통 lease)
let baseline: ResizeMode | null = null; // 캡처한 원래 resize mode. null=lease 미보유(복원 완료/terminal)
let nativeScrollActive = false; // guard 가 읽는 "native scroll 을 우리가 제어 중" 상태
let restoreRetries = 0;
let activeBridge: KeyboardBridge = realBridge;
const RESTORE_MAX_RETRIES = 3;
const RESTORE_RETRY_MS = 30;

/** 모든 브릿지 조작을 단일 chain 으로 직렬화한다(전역 race 차단). */
function enqueue<T>(op: () => Promise<T>): Promise<T> {
  const next = opChain.then(op, op);
  opChain = next.then(
    () => {},
    () => {},
  );
  return next;
}

/**
 * 전역 desired(refCount>0)로 native 상태를 수렴시킨다. apply 성공 시 true, 실패 시 false 반환.
 * 핵심(삼순 왕복4): reject 뒤 실제 native 상태를 모르므로, want=true 면 flag 로 skip 하지 않고 항상
 * setResizeMode(None)+setScroll(true)를 재발행한다(idempotent). 이로써 restore 응답 실패(applied-then-reject)
 * 뒤 reopen 이 desired 를 확실히 재적용한다. restore(refCount 0)는 성공 확인 또는 terminal fail-safe 까지 수렴.
 */
async function reconcile(): Promise<boolean> {
  const b = activeBridge;
  const want = refCount > 0;

  if (want) {
    try {
      // baseline 은 lease 미보유(null)일 때만 캡처 — held 면 재캡처 안 함(baseline poisoning 차단).
      if (baseline === null) {
        try {
          baseline = (await b.getResizeMode()).mode;
        } catch {
          baseline = KeyboardResize.Native;
        }
      }
      // flag skip 없이 항상 desired 재발행(reject 뒤 native 불명 → reopen 이 확실히 재수렴).
      await b.setResizeMode({ mode: KeyboardResize.None });
      await b.setScroll({ isDisabled: true });
      nativeScrollActive = true; // scroll+resize apply 확정 후에만 활성 통지
      restoreRetries = 0;
      return true;
    } catch {
      return false; // 호출부가 dec+restore+fallback 처리
    }
  }

  // restore — refCount 0. baseline 미보유면 되돌릴 것 없음.
  if (baseline === null) {
    nativeScrollActive = false;
    restoreRetries = 0;
    return true;
  }
  let ok = true;
  try {
    await b.setScroll({ isDisabled: false });
  } catch {
    ok = false;
  }
  try {
    await b.setResizeMode({ mode: baseline });
  } catch {
    ok = false;
  }
  if (ok) {
    baseline = null; // 성공 확인 → lease 해제
    nativeScrollActive = false; // 실제 enable 성공 후에만 guard 재활성화
    restoreRetries = 0;
    return true;
  }
  if (restoreRetries < RESTORE_MAX_RETRIES) {
    // 복원 성공 전이므로 nativeScrollActive 유지(조기 false 통지 금지) + bounded retry.
    restoreRetries += 1;
    setTimeout(() => {
      if (refCount === 0 && baseline !== null) void enqueue(reconcile);
    }, RESTORE_RETRY_MS);
  } else {
    // terminal fail-safe: retry 예산 소진 → 영구 잔류 방지. lease 를 버리고 web guard 재활성화,
    // 다음 open 은 baseline 재캡처해 처음부터 재초기화(retry budget 도 리셋).
    baseline = null;
    nativeScrollActive = false;
    restoreRetries = 0;
  }
  return true;
}

/** guard(root scroll)용 — native scroll 이 실제 disabled 로 확정된 상태인지. */
export function isNativeKeyboardScrollActive(): boolean {
  return nativeScrollActive;
}

/** 테스트 훅 — 전역 lease/상태/chain 을 초기화한다. */
export function __resetOverlayKeyboardStateForTest(): void {
  opChain = Promise.resolve();
  refCount = 0;
  baseline = null;
  nativeScrollActive = false;
  restoreRetries = 0;
  activeBridge = realBridge;
}

/**
 * iOS 네이티브 댓글 시트용 키보드 모드를 활성화한다.
 * resize:none + native scroll disabled 는 전역 lease 로, 높이 리스너는 인스턴스별로 관리한다.
 */
export function beginOverlayKeyboard(
  options: BeginOverlayKeyboardOptions,
): OverlayKeyboardHandle {
  const { onHeight, onFallback } = options;
  if (options.bridge) activeBridge = options.bridge;

  let released = false;
  let subscriptions: PluginListenerHandle[] = [];
  let joined = false; // 이 인스턴스가 refCount 를 증가시켰는지

  const removeSubscriptions = async (): Promise<void> => {
    if (subscriptions.length === 0) return;
    const pending = subscriptions;
    subscriptions = [];
    await Promise.allSettled(pending.map((s) => s.remove()));
  };

  const leaveLease = async (): Promise<void> => {
    if (!joined) return;
    joined = false;
    refCount = Math.max(0, refCount - 1);
    await reconcile();
  };

  enqueue(async () => {
    if (released) return;

    // ① 높이 리스너 부분실패 handle 유실 방지 — allSettled 로 성공분 수거.
    const results = await Promise.allSettled([
      activeBridge.addListener("keyboardWillShow", ({ keyboardHeight }) => {
        if (!released) onHeight(Math.max(0, Math.round(keyboardHeight)));
      }),
      activeBridge.addListener("keyboardWillHide", () => {
        if (!released) onHeight(0);
      }),
    ]);
    for (const r of results) {
      if (r.status === "fulfilled") subscriptions.push(r.value);
    }
    if (results.some((r) => r.status === "rejected") || released) {
      await removeSubscriptions();
      if (results.some((r) => r.status === "rejected") && !released) onFallback();
      return;
    }

    // 전역 lease 참여 + native 상태 수렴.
    refCount += 1;
    joined = true;
    const ok = await reconcile();
    if (!ok) {
      // apply 실패 — 이 인스턴스만 빠지고(다른 오버레이 유지) web 폴백으로 전환.
      await removeSubscriptions();
      await leaveLease();
      if (!released) onFallback();
      return;
    }
    if (released) {
      await removeSubscriptions();
      await leaveLease();
    }
  });

  return {
    release: () => {
      if (released) return;
      released = true;
      onHeight(0);
      void enqueue(async () => {
        await removeSubscriptions();
        await leaveLease();
      });
    },
  };
}

/** 새 Keyboard 플러그인이 실제 탑재된 iOS 네이티브 바이너리인지 동기 판정한다. */
export function supportsNativeKeyboardOverlay(): boolean {
  return isIosNativeRuntime() && hasKeyboardPlugin();
}
