/**
 * 파일 픽 controller (삼순 #805 라운드4 — 이벤트 소스 결속).
 *
 * 상태머신(pick-session)만으로는 부족했다: 배선에서 토큰을 공유 ref에 두면
 * `open A → cancel A → open B → A late change` 순서에서 A의 change handler가
 * B의 토큰을 읽어 stale 파일이 반영된다.
 *
 * 그래서 controller는 **픽마다 새 native input 인스턴스**를 만들고, open 시점에
 * 발급받은 토큰을 그 인스턴스의 이벤트 handler closure에 결속한다. A의 이벤트는
 * A의 토큰만 들고 오므로 B로 오인될 수 없다(서로 다른 DOM 노드 + 서로 다른 closure).
 */
import { createPickSession } from "./pick-session";

export interface NativePickHandlers {
  /** 멀티픽: 선택 순서 그대로의 배열(1→2→3). 빈 선택은 null. */
  onChange: (files: File[] | null) => void;
  onCancel: () => void;
}

export interface PickController {
  /** 새 픽 시작. 진행 중이면 false(재진입 차단). */
  openPicker(): boolean;
  /** 수동 취소/닫기/reset — 활성 픽 invalidate. 이후 late 이벤트는 무시된다. */
  cancel(): void;
  isPicking(): boolean;
}

export function createPickController(opts: {
  /** 픽마다 호출 — 반드시 매 호출 새 input 인스턴스를 만들어 handlers를 결속해야 한다. */
  openNative: (handlers: NativePickHandlers) => void;
  onFile: (files: File[] | null) => void;
  onStateChange?: (picking: boolean) => void;
}): PickController {
  const session = createPickSession(opts.onStateChange);
  return {
    openPicker() {
      const token = session.open();
      if (token == null) return false;
      // 토큰을 이 픽의 이벤트 handler closure에 결속 — 공유 ref 없음
      opts.openNative({
        onChange: (files) => {
          // 이 change가 stale(취소/교체된 픽의 late event)이면 무시하고 활성 세션은 유지
          if (!session.resolveChange(token)) return;
          opts.onFile(files);
        },
        onCancel: () => {
          // 자기 픽이 아직 활성일 때만 취소 — B가 열린 뒤 도착한 A의 cancel이 B를 죽이지 않게
          session.cancel(token);
        },
      });
      return true;
    },
    cancel() {
      session.cancel();
    },
    isPicking: () => session.isPicking(),
  };
}
