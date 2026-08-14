/**
 * 직관 스토리 이미지 진행바 WAAPI 배선 회귀 — 하린아빠 8/13 iPhone 리포트(댓글/더보기/닫기 더블탭).
 *
 * 배경: 이미지 스토리 진행바를 RAF+setState(초당 60회 리렌더·per-frame style 변이)로 굴리면
 * iOS WebKit ContentChangeObserver 가 탭 디스패치 창의 스크립트발 DOM 변이를 감지해 첫 탭을
 * hover 로 삼키고 click 을 안 보낸다(더블탭 요구). 근본 수정 = Web Animations API(엔진 구동)로
 * 전환해 per-frame 스크립트 변이를 0 으로 만든다.
 *
 * 이 게이트가 고정하는 계약(실제 VenueStoryViewer 렌더 + animate spy):
 *   1. 이미지 스토리 활성 바는 el.animate(scaleX 0→1, duration=VENUE_STORY_IMAGE_HOLD_MS,
 *      linear, fill:forwards) 로 구동된다.
 *   2. 더보기(menuOpen)·일시정지 동안 anim.pause(), 해제 시 anim.play().
 *   3. anim.onfinish → 다음 스토리로 진행(goNext 배선).
 *   4. 스토리 전환 시 이전 애니메이션 cancel() (fill:forwards 잔존이 이전 바 width 를 덮는 것 방지).
 *   5. 진행 구동 중 진행바 DOM 에 스크립트발 attribute(style) 변이 0 — RAF/setState 방식이
 *      재도입되면 이 assertion 이 붉어진다(회귀 고정).
 * 실행: npm run qa:venue-story-progress-waapi
 */
import "./_smoke-env";
import { JSDOM } from "jsdom";
import { VENUE_STORY_IMAGE_HOLD_MS } from "../../src/lib/venue-stories/types";

const dom = new JSDOM(`<!DOCTYPE html><body></body>`, { pretendToBeVisual: true, url: "http://localhost/" });
const win = dom.window as unknown as Record<string, unknown>;
const g = globalThis as unknown as Record<string, unknown>;
for (const k of [
  "window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "Node",
  "Event", "MouseEvent", "HTMLMediaElement", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "localStorage", "sessionStorage",
  "MutationObserver",
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

// jsdom 에는 Element.animate 가 없다 → spy 스텁을 심어 실제 컴포넌트 배선이 넘기는
// keyframes/options/play·pause·cancel/onfinish 를 그대로 관찰한다.
type AnimateCall = {
  el: HTMLElement;
  keyframes: Array<Record<string, string>>;
  options: Record<string, unknown>;
  playCalls: number;
  pauseCalls: number;
  cancelCalls: number;
  anim: { onfinish: (() => void) | null; play: () => void; pause: () => void; cancel: () => void };
};
const animateCalls: AnimateCall[] = [];
(win.HTMLElement as { prototype: HTMLElement }).prototype.animate = function (
  this: HTMLElement,
  keyframes: Array<Record<string, string>>,
  options: Record<string, unknown>,
) {
  const call: AnimateCall = {
    el: this,
    keyframes,
    options,
    playCalls: 0,
    pauseCalls: 0,
    cancelCalls: 0,
    anim: {
      onfinish: null,
      play() { call.playCalls++; },
      pause() { call.pauseCalls++; },
      cancel() { call.cancelCalls++; },
    },
  };
  animateCalls.push(call);
  return call.anim as unknown as Animation;
} as unknown as typeof HTMLElement.prototype.animate;

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

  const makeStory = (id: number) => ({
    id, gameId: "20260813HTLG0", userId: "author-1", mediaType: "image" as const,
    mediaUrl: `http://x/${id}.jpg`, thumbUrl: null, durationMs: null, width: 1080, height: 1920,
    caption: null, venueVerified: true, createdAt: new Date().toISOString(),
    author: { nickname: "테스터", avatarUrl: null, teamId: 1 },
  });
  const stories = [makeStory(1), makeStory(2)];

  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(React.createElement(AuthProvider, null,
      React.createElement(Viewer as never, {
        stories, startIndex: 0, currentUserId: null, onClose: () => {}, onChanged: () => {},
      } as never),
    ));
  });

  const scope = dom.window.document.body;
  const storyId = () => scope.querySelector("[data-venue-story-viewer]")?.getAttribute("data-story-id");

  // ① animate 호출 계약
  ok("이미지 스토리 렌더 시 진행바 animate() 1회 호출", animateCalls.length === 1);
  const first = animateCalls[0];
  ok("활성 진행바(data-story-progress=waapi)에 애니메이션이 붙음",
    first?.el?.getAttribute("data-story-progress") === "waapi");
  ok("keyframes = scaleX(0)→scaleX(1)",
    first?.keyframes?.length === 2
    && String(first.keyframes[0].transform) === "scaleX(0)"
    && String(first.keyframes[1].transform) === "scaleX(1)");
  ok(`duration = VENUE_STORY_IMAGE_HOLD_MS(${VENUE_STORY_IMAGE_HOLD_MS})`,
    first?.options?.duration === VENUE_STORY_IMAGE_HOLD_MS);
  ok("linear + fill:forwards",
    first?.options?.easing === "linear" && first?.options?.fill === "forwards");
  ok("초기 상태에서 play() 호출됨(자동 진행)", (first?.playCalls ?? 0) >= 1);

  // ② 진행 구동 중 스크립트발 style 변이 0 (RAF/setState 재도입 검출)
  let mutations = 0;
  const obs = new (win.MutationObserver as typeof MutationObserver)((records) => { mutations += records.length; });
  obs.observe(first.el, { attributes: true, attributeFilter: ["style"] });
  await act(async () => { await new Promise((r) => setTimeout(r, 350)); });
  obs.disconnect();
  ok("진행 350ms 동안 진행바 style 스크립트 변이 0건", mutations === 0);

  // ③ 더보기(menuOpen) → pause, 취소 → play
  const moreBtn = scope.querySelector('button[aria-label="더보기"]') as HTMLElement;
  const clickEv = () => new (win.MouseEvent as typeof MouseEvent)("click", { bubbles: true, cancelable: true });
  const pausesBefore = first.pauseCalls;
  await act(async () => { moreBtn.dispatchEvent(clickEv()); });
  ok("더보기(메뉴 오픈) 시 anim.pause()", first.pauseCalls > pausesBefore);
  const cancelBtn = Array.from(scope.querySelectorAll("button")).find((b) => b.textContent?.includes("취소")) as HTMLElement;
  const playsBefore = first.playCalls;
  await act(async () => { cancelBtn.dispatchEvent(clickEv()); });
  ok("메뉴 취소 시 anim.play() 재개", first.playCalls > playsBefore);

  // ④ onfinish → goNext (다음 스토리로 진행 + 이전 anim cancel)
  ok("onfinish 핸들러 배선됨", typeof first.anim.onfinish === "function");
  await act(async () => { first.anim.onfinish?.(); });
  ok("onfinish → 다음 스토리(story-id 2)로 진행", storyId() === "2");
  ok("스토리 전환 시 이전 애니메이션 cancel()", first.cancelCalls >= 1);
  ok("새 스토리의 진행바에 새 animate() 생성 + 자동 재생", animateCalls.length === 2 && animateCalls[1].playCalls >= 1);

  await act(async () => { root.unmount(); });
  globalThis.fetch = origFetch;

  console.log(`\nvenue-story progress WAAPI: ${pass} passed, ${fail} failed`);
  // jsdom pretendToBeVisual RAF 핸들(framer-motion)이 이벤트루프를 붙잡아 명시 종료
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
