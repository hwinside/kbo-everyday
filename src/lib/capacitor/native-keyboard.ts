// iOS 네이티브 키보드 제어 — @capacitor/keyboard 브릿지.
//
// 스토리 댓글 바텀시트에서 WKWebView 기본 자동스크롤과 visualViewport 보정이 동시에
// 적용되면 배경이 밀리고 시트가 진동한다. 새 네이티브 바이너리에서는 WebView 리사이즈와
// 자동스크롤을 끄고, 플러그인이 주는 정확한 키보드 높이로 시트를 직접 배치한다.
// 플러그인이 없는 기존 바이너리·웹/PWA는 기존 visualViewport 경로를 유지한다.

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

/**
 * iOS 네이티브 댓글 시트용 키보드 모드를 활성화한다.
 * resize:none + native scroll disabled 상태에서 keyboardWillShow/Hide 높이를 전달한다.
 */
export function beginOverlayKeyboard(onHeight: (height: number) => void): OverlayKeyboardHandle {
  let released = false;
  let previousResizeMode: KeyboardResizeOptions["mode"] = KeyboardResize.Native;
  const subscriptions: PluginListenerHandle[] = [];

  void (async () => {
    try {
      try {
        previousResizeMode = (await Keyboard.getResizeMode()).mode;
      } catch {
        previousResizeMode = KeyboardResize.Native;
      }

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
        await Promise.all(subscriptions.map((subscription) => subscription.remove()));
        return;
      }

      await Keyboard.setResizeMode({ mode: KeyboardResize.None });
      await Keyboard.setScroll({ isDisabled: true });
    } catch {
      // 브릿지 호출 실패 시 기존 visualViewport 동작을 건드리지 않는다.
    }
  })();

  return {
    release: () => {
      if (released) return;
      released = true;
      onHeight(0);
      void Promise.all(subscriptions.map((subscription) => subscription.remove())).catch(() => {});
      void (async () => {
        try {
          await Keyboard.setScroll({ isDisabled: false });
          await Keyboard.setResizeMode({ mode: previousResizeMode });
        } catch {
          /* 종료 중 브릿지 실패는 무시 */
        }
      })();
    },
  };
}

/** 새 Keyboard 플러그인이 실제 탑재된 iOS 네이티브 바이너리인지 동기 판정한다. */
export function supportsNativeKeyboardOverlay(): boolean {
  return isIosNativeRuntime() && hasKeyboardPlugin();
}
