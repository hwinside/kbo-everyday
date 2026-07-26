// iOS 네이티브 키보드 제어 — @capacitor/keyboard 브릿지.
//
// 스토리 댓글 바텀시트에서 WKWebView 기본 자동스크롤과 visualViewport 보정이 동시에
// 적용되면 배경이 밀리고 시트가 진동한다. 새 네이티브 바이너리에서는 WebView 리사이즈와
// 자동스크롤을 끄고, 플러그인이 주는 정확한 키보드 높이로 시트를 직접 배치한다.
// 플러그인이 없는 기존 바이너리·웹/PWA는 기존 visualViewport 경로를 유지한다.
//
// 동시성 계약(삼순 #883 blocker 반영):
// ① listener 부분실패 handle 유실 방지 — addListener 를 allSettled 로 받아 성공한 handle 을
//    반드시 수거하고, 하나라도 실패하면 수거분을 제거한 뒤 fallback 으로 전환한다.
// ② close→reopen 전역 race — @capacitor/keyboard 는 전역 싱글턴이라 두 오버레이가 겹치면
//    setResizeMode/setScroll 이 서로 덮어써 baseline(previousResizeMode)이 오염된다. 모든 브릿지
//    조작을 모듈 단일 opChain 으로 직렬화하고, baseline 은 활성 오버레이 0→1 전이에서 한 번만
//    캡처해 1→0 전이에서 복원한다(refcount). 중첩 오버레이는 baseline 을 다시 읽지 않는다.
// ③ restore 부분실패 격리 — setScroll 복원이 throw 해도 setResizeMode 복원이 반드시 실행되도록
//    각 브릿지 호출을 독립 try/catch 로 감싼다.

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
  /**
   * native 오버레이가 스크롤을 실제로 직접 제어하기 시작/종료할 때 토글. true=setScroll(disabled)
   * 적용됨, false=복원 시작. scroll-lock 의 restoreLockedScroll guard 가 이 값으로 이중보정을 피한다.
   */
  onActiveChange?: (active: boolean) => void;
  /** 테스트 전용 브릿지 주입. 미지정 시 실제 @capacitor/keyboard 브릿지. */
  bridge?: KeyboardBridge;
}

// ── 모듈 전역 상태(② refcount baseline + 직렬화 chain) ─────────────────────────
let opChain: Promise<void> = Promise.resolve();
let activeCount = 0;
let baselineResizeMode: ResizeMode = KeyboardResize.Native;

/** 모든 브릿지 조작을 단일 chain 으로 직렬화한다(전역 race 차단). */
function enqueue(op: () => Promise<void>): Promise<void> {
  const next = opChain.then(op, op);
  opChain = next.catch(() => {});
  return next;
}

/** 테스트 훅 — 전역 refcount/baseline/chain 을 초기화한다. */
export function __resetOverlayKeyboardStateForTest(): void {
  opChain = Promise.resolve();
  activeCount = 0;
  baselineResizeMode = KeyboardResize.Native;
}

/**
 * iOS 네이티브 댓글 시트용 키보드 모드를 활성화한다.
 * resize:none + native scroll disabled 상태에서 keyboardWillShow/Hide 높이를 전달한다.
 *
 * 모든 setup/restore 는 전역 opChain 으로 직렬화되어, close→reopen 이 겹쳐도 baseline 오염과
 * handle race 가 발생하지 않는다.
 */
export function beginOverlayKeyboard(
  options: BeginOverlayKeyboardOptions,
): OverlayKeyboardHandle {
  const { onHeight, onFallback, onActiveChange } = options;
  const bridge = options.bridge ?? realBridge;

  let released = false;
  let subscriptions: PluginListenerHandle[] = [];
  let counted = false; // 이 인스턴스가 activeCount 를 증가시켰는지
  let scrollDisabled = false; // 이 인스턴스가 setScroll(disabled) 를 적용했는지

  const removeSubscriptions = async (): Promise<void> => {
    if (subscriptions.length === 0) return;
    const pending = subscriptions;
    subscriptions = [];
    await Promise.allSettled(pending.map((s) => s.remove()));
  };

  // doRestore — 이 인스턴스 몫만 되돌린다(enqueue 하지 않는 raw 버전). setup 은 이미 opChain
  // 안에서 실행되므로 직접 호출하고(재-enqueue 시 자기 뒤에 append 되어 deadlock), release 는
  // enqueue(doRestore) 로 감싼다. ③ 각 브릿지 호출을 독립 try/catch 로 격리해 앞 호출이 throw
  // 해도 뒤 호출(resize 복원)이 반드시 실행된다. 여러 번 불려도 idempotent.
  const doRestore = async (): Promise<void> => {
    await removeSubscriptions();

    if (scrollDisabled) {
      onActiveChange?.(false);
      try {
        await bridge.setScroll({ isDisabled: false });
      } catch {
        /* scroll 복원 실패는 격리 — resize 복원은 아래에서 반드시 시도 */
      }
      scrollDisabled = false;
    }

    // ② baseline 은 마지막 오버레이(1→0)에서만 복원한다.
    if (counted) {
      activeCount = Math.max(0, activeCount - 1);
      counted = false;
      if (activeCount === 0) {
        try {
          await bridge.setResizeMode({ mode: baselineResizeMode });
        } catch {
          /* 복원 실패는 무시(다음 오버레이/GC 로 정리) */
        }
      }
    }
  };

  // setup — 직렬화 chain 안에서 실행. 각 await 뒤 released 재확인.
  enqueue(async () => {
    if (released) return;

    // ② baseline 은 0→1 전이에서만 캡처(중첩 오버레이는 오염된 현재값을 읽지 않음).
    if (activeCount === 0) {
      try {
        baselineResizeMode = (await bridge.getResizeMode()).mode;
      } catch {
        baselineResizeMode = KeyboardResize.Native;
      }
    }
    activeCount += 1;
    counted = true;
    if (released) {
      await doRestore();
      return;
    }

    // ① listener 부분실패 handle 유실 방지 — allSettled 로 성공분을 수거.
    const results = await Promise.allSettled([
      bridge.addListener("keyboardWillShow", ({ keyboardHeight }) => {
        if (!released) onHeight(Math.max(0, Math.round(keyboardHeight)));
      }),
      bridge.addListener("keyboardWillHide", () => {
        if (!released) onHeight(0);
      }),
    ]);
    for (const r of results) {
      if (r.status === "fulfilled") subscriptions.push(r.value);
    }
    if (results.some((r) => r.status === "rejected")) {
      // 부분 실패 — 수거한 handle 제거 + baseline refcount 되돌린 뒤 fallback.
      await doRestore();
      if (!released) onFallback();
      return;
    }
    if (released) {
      await doRestore();
      return;
    }

    try {
      await bridge.setResizeMode({ mode: KeyboardResize.None });
      if (released) {
        await doRestore();
        return;
      }
      await bridge.setScroll({ isDisabled: true });
      scrollDisabled = true;
      onActiveChange?.(true);
      if (released) {
        await doRestore();
        return;
      }
    } catch {
      await doRestore();
      if (!released) onFallback();
    }
  });

  return {
    release: () => {
      if (released) return;
      released = true;
      onHeight(0);
      void enqueue(doRestore);
    },
  };
}

/** 새 Keyboard 플러그인이 실제 탑재된 iOS 네이티브 바이너리인지 동기 판정한다. */
export function supportsNativeKeyboardOverlay(): boolean {
  return isIosNativeRuntime() && hasKeyboardPlugin();
}
