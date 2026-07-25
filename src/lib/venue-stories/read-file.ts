// 직관 라이브 컴포저 — 이미지 프리뷰용 data URL 읽기(타임아웃 종결 보장).
//
// 배경(하린아빠 A17 리포트): 안드로이드 WebView 는 갤러리 content:// File 에서 FileReader 가
// onload/onerror 를 **끝내 발화하지 않는** 케이스가 있다. 그러면 컴포저의 handlePickedFile 이
// read await 에서 영원히 멈춰 readingPreview lock 이 영구 stuck → 프리뷰는 떠도 '올리기'가
// 회색으로 남는다(영상은 FileReader 를 안 써서 무영향). probeVideoDurationMs(삼순 #813)가
// 같은 이유로 timeout 종결을 도입했듯, 이미지 read 도 timeout 으로 반드시 settle 시킨다.

/** 이미지 data URL 읽기 상한 — onload/onerror 미발화 File 무한대기 방지(하린아빠 A17 리포트). */
export const IMAGE_READ_TIMEOUT_MS = 12_000;

/** readFileAsDataURL 이 쓰는 FileReader 최소 인터페이스 — 순수 회귀(fake reader) 주입용. */
export interface DataUrlReaderLike {
  onload: (() => void) | null;
  onerror: (() => void) | null;
  readonly result: string | ArrayBuffer | null;
  readonly error: DOMException | null;
  readAsDataURL(blob: Blob): void;
  abort(): void;
}

/**
 * 이미지 파일을 data URL 로 읽는다(안드로이드 WebView blob: 프리뷰 깨짐 방지용 data URL).
 * onload → resolve, onerror → reject, **둘 다 미발화면 timeout 으로 reject**(lock stuck 방지).
 * timeout/성공 후 늦게 발화하는 이벤트는 handler 해제로 no-op. deps 는 순수 회귀 주입 포인트.
 */
export function readFileAsDataURL(
  f: Blob,
  deps?: {
    timeoutMs?: number;
    createReader?: () => DataUrlReaderLike;
    setTimer?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clearTimer?: (t: ReturnType<typeof setTimeout>) => void;
  },
): Promise<string> {
  const timeoutMs = deps?.timeoutMs ?? IMAGE_READ_TIMEOUT_MS;
  const createReader = deps?.createReader ?? (() => new FileReader() as DataUrlReaderLike);
  const setTimer = deps?.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer = deps?.clearTimer ?? ((t) => clearTimeout(t));
  return new Promise((resolve, reject) => {
    const r = createReader();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer != null) clearTimer(timer);
      timer = null;
      // 늦게 발화하는 onload/onerror 무력화(종결 후 상태 오염 방지)
      r.onload = null;
      r.onerror = null;
      fn();
    };
    r.onload = () => done(() => resolve(r.result as string));
    r.onerror = () => done(() => reject(r.error ?? new Error("file read failed")));
    timer = setTimer(() => {
      // onload/onerror 를 끝내 안 쏘는 File(안드로이드 content:// hang) — abort 후 reject 로 종결.
      try {
        r.abort();
      } catch {
        /* noop */
      }
      done(() => reject(new Error("file read timeout")));
    }, timeoutMs);
    r.readAsDataURL(f);
  });
}
