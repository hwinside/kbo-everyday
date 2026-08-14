/**
 * 직관 스토리 뷰어 이미지 로드 검은 화면 깜빡임 방지 회귀 — 하린아빠 8/14 11:39 리포트.
 *
 * 증상: <img src> 교체 순간 브라우저가 이전 프레임을 비우고 새 이미지 디코드 완료까지
 * 검은 배경(bg-black)이 노출 → 스토리 열기/전환마다 화면이 한 번씩 깜빡임.
 *
 * 계약(실제 VenueStoryViewer 렌더):
 *   1. 이미지 로드 완료 전: 본 이미지 opacity 0 + 트레이 썸네일(thumbUrl) placeholder 표시.
 *   2. load 이벤트 후: 본 이미지 표시(opacity 해제) + placeholder 제거.
 *   3. thumbUrl 없는 스토리: placeholder 없이도 크래시 없이 렌더(검은 배경 유지 = 기존과 동일).
 *   4. 스토리 전환 시 새 이미지도 같은 계약(로드 전 placeholder, 로드 후 본 이미지).
 *   5. 이미 로드된 URL 로 되돌아오면 placeholder 없이 즉시 본 이미지.
 *   6. 인접(다음) 이미지 스토리 선로드 요청 발생(window.Image 프리로드).
 * 실행: npm run qa:venue-story-media-flash
 */
import "./_smoke-env";
import { JSDOM } from "jsdom";

const dom = new JSDOM(`<!DOCTYPE html><body></body>`, { pretendToBeVisual: true, url: "http://localhost/" });
const win = dom.window as unknown as Record<string, unknown>;
const g = globalThis as unknown as Record<string, unknown>;
for (const k of [
  "window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "Node",
  "Event", "MouseEvent", "HTMLMediaElement", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "localStorage", "sessionStorage",
]) {
  g[k] = win[k];
}
(win.HTMLMediaElement as { prototype: HTMLMediaElement }).prototype.play = async () => {};
(win.HTMLMediaElement as { prototype: HTMLMediaElement }).prototype.pause = () => {};
(g as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// window.Image 프리로드 요청 추적 — jsdom 은 실제 네트워크 로드를 하지 않으므로 src 할당만 기록
const preloadRequests: string[] = [];
class TrackingImage {
  onload: (() => void) | null = null;
  private _src = "";
  set src(v: string) {
    this._src = v;
    preloadRequests.push(v);
  }
  get src() {
    return this._src;
  }
}
(win as Record<string, unknown>).Image = TrackingImage;

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.error(`  ❌ ${name}`); }
}

function pointer(type: string, opts: { clientX?: number; clientY?: number } = {}) {
  const MouseEventCtor = win.MouseEvent as typeof MouseEvent;
  const ev = new MouseEventCtor(type, {
    bubbles: true, cancelable: true, button: 0,
    clientX: opts.clientX ?? 0, clientY: opts.clientY ?? 0,
  });
  Object.defineProperty(ev, "isPrimary", { value: true, configurable: true });
  Object.defineProperty(ev, "pointerId", { value: 1, configurable: true });
  Object.defineProperty(ev, "pointerType", { value: "touch", configurable: true });
  return ev;
}

async function main() {
  const React = (await import("react")).default;
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");

  const clientMod = await import("../../src/lib/supabase/client");
  (clientMod.supabase.auth as unknown as { getSession: () => Promise<unknown> }).getSession = async () => ({
    data: { session: null }, error: null,
  });
  (clientMod.supabase.auth as unknown as { onAuthStateChange: (cb: unknown) => unknown }).onAuthStateChange = () => ({
    data: { subscription: { unsubscribe: () => {} } },
  });

  const Viewer = (await import("../../src/components/game/VenueStoryViewer")).default;
  const { AuthProvider } = await import("../../src/lib/supabase/AuthContext");

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true, status: 200, json: async () => ({ comments: [], total: 0 }),
  })) as unknown as typeof fetch;

  const makeStory = (id: number, thumb: boolean) => ({
    id, gameId: "20260813HTLG0", userId: "author-1", mediaType: "image" as const,
    mediaUrl: `http://x/media-${id}.jpg`,
    thumbUrl: thumb ? `http://x/thumb-${id}.jpg` : null,
    durationMs: null, width: 1080, height: 1920,
    caption: null, venueVerified: true, createdAt: new Date().toISOString(),
    author: { nickname: "테스터", avatarUrl: null, teamId: 1 },
  });

  const scope = dom.window.document.body;
  const q = (sel: string) => scope.querySelector(sel) as HTMLElement | null;
  const mainImg = () => q('[data-story-media="image"]') as HTMLImageElement | null;
  const placeholder = () => q("[data-story-media-placeholder]") as HTMLImageElement | null;

  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(AuthProvider, null,
      React.createElement(Viewer as never, {
        stories: [makeStory(1, true), makeStory(2, true), makeStory(3, false)], startIndex: 0,
        currentUserId: null, onClose: () => {}, onChanged: () => {},
      } as never),
    ));
  });

  // ① 로드 전: 본 이미지 숨김 + placeholder = 썸네일
  ok("로드 전: 본 이미지 opacity 0", mainImg()?.style.opacity === "0");
  ok("로드 전: placeholder = 트레이 썸네일 표시", placeholder()?.getAttribute("src") === "http://x/thumb-1.jpg");

  // ⑥ 인접(다음) 이미지 선로드 요청 발생
  ok("인접 스토리 선로드 요청(window.Image) 발생", preloadRequests.includes("http://x/media-2.jpg"));

  // ② load 후: 본 이미지 표시 + placeholder 제거
  await act(async () => { mainImg()!.dispatchEvent(new (win.Event as typeof Event)("load")); });
  ok("load 후: 본 이미지 표시(opacity 해제)", (mainImg()?.style.opacity ?? "") !== "0");
  ok("load 후: placeholder 제거", placeholder() === null);

  // ④ 다음 스토리 전환(오른쪽 탭 존 pointerup) — 새 이미지도 같은 계약
  const nextZone = q('button[aria-label="다음"]')!;
  await act(async () => { nextZone.dispatchEvent(pointer("pointerdown")); });
  await act(async () => { nextZone.dispatchEvent(pointer("pointerup")); });
  ok("전환 직후: 새 이미지 로드 전 opacity 0", mainImg()?.getAttribute("src") === "http://x/media-2.jpg" && mainImg()?.style.opacity === "0");
  ok("전환 직후: 새 썸네일 placeholder 표시", placeholder()?.getAttribute("src") === "http://x/thumb-2.jpg");
  await act(async () => { mainImg()!.dispatchEvent(new (win.Event as typeof Event)("load")); });
  ok("전환 load 후: 본 이미지 표시 + placeholder 제거", (mainImg()?.style.opacity ?? "") !== "0" && placeholder() === null);

  // ③ thumbUrl 없는 스토리 — placeholder 없이 렌더(크래시 0)
  await act(async () => { nextZone.dispatchEvent(pointer("pointerdown")); });
  await act(async () => { nextZone.dispatchEvent(pointer("pointerup")); });
  ok("thumbUrl 없음: placeholder 미표시 + 본 이미지 렌더", placeholder() === null && mainImg()?.getAttribute("src") === "http://x/media-3.jpg");
  await act(async () => { mainImg()!.dispatchEvent(new (win.Event as typeof Event)("load")); });

  // ⑤ 이미 로드된 URL 로 복귀 — placeholder 없이 즉시 표시
  const prevZone = q('button[aria-label="이전"]')!;
  await act(async () => { prevZone.dispatchEvent(pointer("pointerdown")); });
  await act(async () => { prevZone.dispatchEvent(pointer("pointerup")); });
  ok("로드된 URL 복귀: placeholder 없이 즉시 표시", placeholder() === null && (mainImg()?.style.opacity ?? "") !== "0" && mainImg()?.getAttribute("src") === "http://x/media-2.jpg");

  await act(async () => { root.unmount(); });
  globalThis.fetch = origFetch;
  console.log(`\nvenue-story media flash: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
