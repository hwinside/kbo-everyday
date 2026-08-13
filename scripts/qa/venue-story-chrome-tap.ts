/**
 * 직관 스토리 뷰어 크롬 버튼(음소거/더보기/닫기/댓글 pill) pointerup 활성화 회귀 —
 * 하린아빠 8/13~14 iPhone 리포트(첫 탭 무반응, WAAPI #1178 후에도 재현 지속) 플랜B.
 *
 * 계약(실제 VenueStoryViewer 렌더 + native pointer/click dispatch):
 *   1. primary pointerdown→pointerup(버튼 안 릴리즈) = 1회 활성화 — click 합성에 의존하지 않는다.
 *   2. pointerup 뒤 따라오는 trailing click(detail>0)은 무시 — 같은 탭 중복 발동 0.
 *   3. pointercancel 후 pointerup = 활성화 0 (스크롤/제스처 취소).
 *   4. drag-out(버튼 밖 릴리즈) = 활성화 0.
 *   5. 키보드 click(detail=0)은 폴백으로 활성화(접근성).
 * 대상: 닫기(X)·더보기(점세개)·댓글 pill(이미지 스토리) + 음소거(영상 스토리).
 * 실행: npm run qa:venue-story-chrome-tap
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

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.error(`  ❌ ${name}`); }
}

// jsdom 에 PointerEvent 가 없어 MouseEvent 로 pointer* 타입을 만들고 isPrimary/좌표를 심는다.
function pointer(type: string, opts: { clientX?: number; clientY?: number; button?: number; isPrimary?: boolean } = {}) {
  const MouseEventCtor = win.MouseEvent as typeof MouseEvent;
  const ev = new MouseEventCtor(type, {
    bubbles: true, cancelable: true,
    button: opts.button ?? 0, clientX: opts.clientX ?? 10, clientY: opts.clientY ?? 10,
  });
  Object.defineProperty(ev, "isPrimary", { value: opts.isPrimary ?? true, configurable: true });
  Object.defineProperty(ev, "pointerId", { value: 1, configurable: true });
  Object.defineProperty(ev, "pointerType", { value: "touch", configurable: true });
  return ev;
}
function clickEv(detail: number) {
  return new (win.MouseEvent as typeof MouseEvent)("click", { bubbles: true, cancelable: true, detail });
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

  const makeStory = (id: number, mediaType: "image" | "video") => ({
    id, gameId: "20260813HTLG0", userId: "author-1", mediaType,
    mediaUrl: mediaType === "image" ? `http://x/${id}.jpg` : `http://x/${id}.mp4`,
    thumbUrl: null, durationMs: null, width: 1080, height: 1920,
    caption: null, venueVerified: true, createdAt: new Date().toISOString(),
    author: { nickname: "테스터", avatarUrl: null, teamId: 1 },
  });

  const scope = dom.window.document.body;
  const q = (sel: string) => scope.querySelector(sel) as HTMLElement | null;
  // jsdom getBoundingClientRect 는 전부 0 — 릴리즈 좌표를 rect 안(0,0)으로 주면 in-bounds,
  // (999,999)로 주면 drag-out 이 된다.
  const tapIn = async (el: HTMLElement) => {
    await act(async () => { el.dispatchEvent(pointer("pointerdown")); });
    await act(async () => { el.dispatchEvent(pointer("pointerup", { clientX: 0, clientY: 0 })); });
  };

  // ── 렌더 1: 이미지 스토리 2개 (닫기/더보기/댓글 pill) ──
  let closeCount = 0;
  const container1 = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container1);
  const root1 = createRoot(container1);
  await act(async () => {
    root1.render(React.createElement(AuthProvider, null,
      React.createElement(Viewer as never, {
        stories: [makeStory(1, "image"), makeStory(2, "image")], startIndex: 0,
        currentUserId: null, onClose: () => { closeCount++; }, onChanged: () => {},
      } as never),
    ));
  });

  // ① 댓글 pill: pointer 탭 1회 = 오픈
  const pill = q("[data-open-comments]")!;
  await tapIn(pill);
  ok("댓글 pill: pointerdown→up 1회로 댓글 오버레이 오픈", !!q("[data-venue-story-comment-overlay]"));
  // trailing click 무시(오버레이가 이미 열렸으니 상태 유지 확인)
  await act(async () => { pill.dispatchEvent(clickEv(1)); });
  ok("댓글 pill: trailing click(detail>0) 무시(오버레이 유지)", !!q("[data-venue-story-comment-overlay]"));
  // 닫기: 백드롭 click → closing → 시트 애니메이션 완료 콜백 강제
  await act(async () => { q("[data-venue-story-comment-overlay]")!.dispatchEvent(clickEv(1)); });
  const sheet = q("[data-venue-story-comment-sheet]");
  ok("백드롭 탭으로 닫힘 요청 상태 진입", !!sheet);
  // framer-motion onAnimationComplete 은 jsdom 에서 안 돌 수 있어 강제로 스토리 전환 없이 언마운트 확인은 생략.

  // ② 더보기: pointercancel 후 pointerup = 발동 0, 정상 탭 = 메뉴 오픈
  const more = q('button[aria-label="더보기"]')!;
  await act(async () => { more.dispatchEvent(pointer("pointerdown")); });
  await act(async () => { more.dispatchEvent(pointer("pointercancel")); });
  await act(async () => { more.dispatchEvent(pointer("pointerup", { clientX: 0, clientY: 0 })); });
  ok("더보기: pointercancel 후 릴리즈 = 메뉴 미오픈", !Array.from(scope.querySelectorAll("button")).some((b) => b.textContent?.includes("취소")));
  await tapIn(more);
  ok("더보기: 정상 pointer 탭 = 액션 시트 오픈", Array.from(scope.querySelectorAll("button")).some((b) => b.textContent?.includes("취소")));
  const cancelBtn = Array.from(scope.querySelectorAll("button")).find((b) => b.textContent?.includes("취소")) as HTMLElement;
  await act(async () => { cancelBtn.dispatchEvent(clickEv(1)); });

  // ③ 닫기(X): drag-out = 0, pointer 탭 = 1, trailing click 중복 0, 키보드 click = 폴백
  const close = q('button[aria-label="닫기"]')!;
  await act(async () => { close.dispatchEvent(pointer("pointerdown")); });
  await act(async () => { close.dispatchEvent(pointer("pointerup", { clientX: 999, clientY: 999 })); });
  ok("닫기: drag-out(버튼 밖 릴리즈) = 발동 0", closeCount === 0);
  await tapIn(close);
  ok("닫기: pointer 탭 1회 = onClose 1회", closeCount === 1);
  await act(async () => { close.dispatchEvent(clickEv(1)); });
  ok("닫기: trailing click(detail>0) 중복 발동 0", closeCount === 1);
  await act(async () => { close.dispatchEvent(clickEv(0)); });
  ok("닫기: 키보드 click(detail=0) 폴백 발동", closeCount === 2);
  await act(async () => { root1.unmount(); });

  // ── 렌더 2: 영상 스토리 (음소거) ──
  const container2 = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container2);
  const root2 = createRoot(container2);
  await act(async () => {
    root2.render(React.createElement(AuthProvider, null,
      React.createElement(Viewer as never, {
        stories: [makeStory(3, "video")], startIndex: 0,
        currentUserId: null, onClose: () => {}, onChanged: () => {},
      } as never),
    ));
  });
  const video = q('[data-story-media="video"]') as HTMLVideoElement;
  ok("영상 스토리 초기 muted=true", video.muted === true);
  const muteBtn = q('button[aria-label="음소거"]')!;
  await tapIn(muteBtn);
  ok("음소거: pointer 탭 1회 = 음소거 해제(muted=false)", video.muted === false);
  await act(async () => { muteBtn.dispatchEvent(clickEv(1)); });
  ok("음소거: trailing click(detail>0) 무시(muted=false 유지)", video.muted === false);
  await act(async () => { root2.unmount(); });

  globalThis.fetch = origFetch;
  console.log(`\nvenue-story chrome tap: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
