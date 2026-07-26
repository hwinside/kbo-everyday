// iOS 네이티브 키보드 제어 — @capacitor/keyboard 브릿지.
//
// 스토리 댓글 바텀시트에서 WKWebView 기본 자동스크롤과 visualViewport 보정이 동시에
// 적용되면 배경이 밀리고 시트가 진동한다. 새 네이티브 바이너리에서는 WebView 리사이즈와
// 자동스크롤을 끄고, 플러그인이 주는 정확한 키보드 높이로 시트를 직접 배치한다.
// 플러그인이 없는 기존 바이너리·웹/PWA는 기존 visualViewport 경로를 유지한다.
//
// 동시성 계약(삼순 #883 blocker 반영):
// ② setup(리스너 등록 + resize:none + scroll:disabled)과 release(restore)를 단일 async
//    chain으로 직렬화한다. release는 항상 setup 완료 뒤에 restore를 실행하므로, 빠른
//    open→close 에서도 native scroll off/resize:none 이 잔류하지 않는다. 적용에 성공한
//    단계(resizeChanged/scrollDisabled)만 되돌린다.
// ③ setup 중 브릿지가 부분 실패하면 이미 적용된 단계를 되돌리고 onFallback을 호출해
//    호출부가 web visualViewport 경로로 복귀하게 한다(half-native 잔류 방지).

import { Capacitor, type PluginListenerHandle } from "@capacitor/core";
import {
  Keyboard,
  KeyboardResize,
  type KeyboardResizeOptions,
} from "@capacitor/keyboard";
import { isIosNativeRuntime } from "./platform";

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
}

/**
 * iOS 네이티브 댓글 시트용 키보드 모드를 활성화한다.
 * resize:none + native scroll disabled 상태에서 keyboardWillShow/Hide 높이를 전달한다.
 *
 * setup과 release는 단일 chain으로 직렬화되어, release()가 setup 완료 전에 호출돼도
 * restore가 setup 뒤에 실행된다(자동스크롤 off 잔류 방지).
 */
export function beginOverlayKeyboard(
  options: BeginOverlayKeyboardOptions,
): OverlayKeyboardHandle {
  const { onHeight, onFallback, onActiveChange } = options;
  let released = false;
  let previousResizeMode: KeyboardResizeOptions["mode"] = KeyboardResize.Native;
  let resizeChanged = false;
  let scrollDisabled = false;
  const subscriptions: PluginListenerHandle[] = [];

  // 적용에 성공한 단계만 되돌린다. 여러 번 호출돼도 idempotent 하다.
  const restore = async (): Promise<void> => {
    if (subscriptions.length > 0) {
      const pending = subscriptions.splice(0, subscriptions.length);
      try {
        await Promise.all(pending.map((subscription) => subscription.remove()));
      } catch {
        /* 리스너 제거 실패는 무시 */
      }
    }
    // 복원 시작 = native 가 더 이상 스크롤을 제어하지 않음 → web guard 가 다시 동작해야 한다.
    if (scrollDisabled) onActiveChange?.(false);
    try {
      if (scrollDisabled) {
        await Keyboard.setScroll({ isDisabled: false });
        scrollDisabled = false;
      }
      if (resizeChanged) {
        await Keyboard.setResizeMode({ mode: previousResizeMode });
        resizeChanged = false;
      }
    } catch {
      /* 복원 중 브릿지 실패는 무시(다음 release/GC 로 종료) */
    }
  };

  // setup 체인 — 각 await 뒤 released 를 재확인해 즉시 중단·복원한다.
  let chain: Promise<void> = (async () => {
    try {
      try {
        previousResizeMode = (await Keyboard.getResizeMode()).mode;
      } catch {
        previousResizeMode = KeyboardResize.Native;
      }
      if (released) return;

      const [showSubscription, hideSubscription] = await Promise.all([
        Keyboard.addListener("keyboardWillShow", ({ keyboardHeight }) => {
          if (!released) onHeight(Math.max(0, Math.round(keyboardHeight)));
        }),
        Keyboard.addListener("keyboardWillHide", () => {
          if (!released) onHeight(0);
        }),
      ]);
      subscriptions.push(showSubscription, hideSubscription);
      if (released) {
        await restore();
        return;
      }

      await Keyboard.setResizeMode({ mode: KeyboardResize.None });
      resizeChanged = true;
      if (released) {
        await restore();
        return;
      }

      await Keyboard.setScroll({ isDisabled: true });
      scrollDisabled = true;
      onActiveChange?.(true);
      if (released) {
        await restore();
        return;
      }
    } catch {
      // 부분 실패 — 이미 적용된 단계를 되돌리고 web visualViewport 폴백으로 전환.
      await restore();
      if (!released) onFallback();
    }
  })();

  return {
    release: () => {
      if (released) return;
      released = true;
      onHeight(0);
      // setup 이 끝난 뒤 restore 를 실행해 순서를 보장한다(중간 잔류 방지).
      chain = chain.then(restore).catch(() => {});
    },
  };
}

/** 새 Keyboard 플러그인이 실제 탑재된 iOS 네이티브 바이너리인지 동기 판정한다. */
export function supportsNativeKeyboardOverlay(): boolean {
  return isIosNativeRuntime() && hasKeyboardPlugin();
}
