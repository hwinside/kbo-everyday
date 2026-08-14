/**
 * 직관 스토리 뷰어 이미지 로드 검은 화면 깜빡임 방지 회귀 — 하린아빠 8/14 11:39 리포트.
 *
 * 원인 축 2개(삼순 8/14 리뷰):
 *   A. <img src> 교체 순간 브라우저가 이전 프레임을 비우고 새 이미지 디코드 완료까지
 *      검은 배경(bg-black) 노출.
 *   B. 스토리 진입 즉시 signed URL 재발급(onRefreshUrl)이 stories prop 의
 *      mediaUrl·thumbUrl 을 교체 → 표시 중인 src 가 바뀌며 재로드 = 깜빡임 재발.
 *
 * 계약(실제 VenueStoryViewer + 실제 onRefreshUrl 배선 — 부모 harness 가 실제 앱과 동일하게
 * applyVenueStoryUrlRefresh 로 stories 를 갱신한다):
 *   1. 진입 즉시 refresh 가 URL A→B 로 갱신돼도 활성 DOM src=A 유지(latch) — 재로드 0.
 *   2. placeholder 도 진입 시점 썸네일(A) 유지 — 갱신된 썸네일로 재마운트 0.
 *   3. 로드 완료 전: 본 이미지 opacity 0 + placeholder 표시 / load 후: 표시 + placeholder 제거.
 *   4. 실제 로드 오류(error) 시에만 최신 URL 로 교체 — URL 별 1회 시도(삼순 3차 계약):
 *      같은 URL 재시도 0(무한 재로드 방지)이되, B 도 실패하면 나중에 도착하는 새 C URL 에
 *      다시 교체 기회가 열려야 한다(swapped 영구 고정 금지 — 빈 화면 지속 방지).
 *   5. 다음 스토리 전환: 새 스토리도 같은 계약(진입 시점 URL latch + placeholder→load).
 *   6. thumbUrl 없는 스토리: placeholder 없이 크래시 0.
 *   7. 인접(다음) 이미지 스토리 선로드 요청 발생(window.Image).
 * 실행: npm run qa:venue-story-media-flash (prebuild 결속 — Vercel required 체크에서 실행)
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
  const { applyVenueStoryUrlRefresh } = await import("../../src/lib/venue-stories/refresh-policy");
  type Story = Parameters<typeof applyVenueStoryUrlRefresh>[0][number];

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true, status: 200, json: async () => ({ comments: [], total: 0 }),
  })) as unknown as typeof fetch;

  const makeStory = (id: number, thumb: boolean): Story => ({
    id, gameId: "20260813HTLG0", userId: "author-1", mediaType: "image",
    mediaUrl: `http://x/media-${id}-A.jpg`,
    thumbUrl: thumb ? `http://x/thumb-${id}-A.jpg` : null,
    durationMs: null, width: 1080, height: 1920,
    caption: null, venueVerified: true, createdAt: new Date().toISOString(),
    author: { nickname: "테스터", avatarUrl: null, teamId: 1 },
  } as Story);

  // 실제 앱 배선과 동일: onRefreshUrl 이 단건 재발급 결과를 applyVenueStoryUrlRefresh 로 stories 에 반영.
  // applyLaterRefresh 는 4분 주기/retry 루프가 나중에 새 세대 URL 을 발급하는 상황을 재현한다(같은 prop 경로).
  const refreshCalls: number[] = [];
  let latestStories: Story[] = [];
  let applyLaterRefresh: (storyId: number, gen: string) => void = () => {};
  function Harness() {
    const [stories, setStories] = React.useState<Story[]>(
      () => [makeStory(1, true), makeStory(2, true), makeStory(3, false)],
    );
    latestStories = stories;
    applyLaterRefresh = (storyId: number, gen: string) => {
      setStories((prev) => applyVenueStoryUrlRefresh(prev, {
        id: storyId,
        mediaUrl: `http://x/media-${storyId}-${gen}.jpg`,
        thumbUrl: `http://x/thumb-${storyId}-${gen}.jpg`,
      }));
    };
    const onRefreshUrl = React.useCallback(async (storyId: number) => {
      refreshCalls.push(storyId);
      setStories((prev) => applyVenueStoryUrlRefresh(prev, {
        id: storyId,
        mediaUrl: `http://x/media-${storyId}-B.jpg`,
        thumbUrl: `http://x/thumb-${storyId}-B.jpg`,
      }));
      return true;
    }, []);
    return React.createElement(AuthProvider, null,
      React.createElement(Viewer as never, {
        stories, startIndex: 0, currentUserId: null,
        onRefreshUrl,
        onClose: () => {}, onChanged: () => {},
      } as never),
    );
  }

  const scope = dom.window.document.body;
  const q = (sel: string) => scope.querySelector(sel) as HTMLElement | null;
  const mainImg = () => q('[data-story-media="image"]') as HTMLImageElement | null;
  const placeholder = () => q("[data-story-media-placeholder]") as HTMLImageElement | null;

  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(React.createElement(Harness)); });
  // refresh(async setState) settle
  await act(async () => { await Promise.resolve(); });

  // ① 진입 즉시 URL 재발급이 실제로 발생했고 stories prop 은 B 로 갱신됨 — 그래도 DOM src 는 A(latch)
  ok("진입 refresh 실행됨(onRefreshUrl 호출)", refreshCalls.includes(1));
  ok("stories prop 은 B 로 갱신됨(실경로 결속 확인)", latestStories[0]?.mediaUrl === "http://x/media-1-B.jpg");
  ok("활성 DOM src=A 유지(latch) — 갱신에도 재로드 0", mainImg()?.getAttribute("src") === "http://x/media-1-A.jpg");
  // ② placeholder 도 진입 시점 썸네일(A) 유지
  ok("placeholder = 진입 시점 썸네일(A) 유지", placeholder()?.getAttribute("src") === "http://x/thumb-1-A.jpg");
  // ③ 로드 전 opacity 0 → load 후 표시+placeholder 제거
  ok("로드 전: 본 이미지 opacity 0", mainImg()?.style.opacity === "0");
  await act(async () => { mainImg()!.dispatchEvent(new (win.Event as typeof Event)("load")); });
  ok("load 후: 본 이미지 표시 + placeholder 제거", (mainImg()?.style.opacity ?? "") !== "0" && placeholder() === null);
  // load 후에도 src 는 여전히 A(성공 로드는 교체 사유가 아님)
  ok("load 후에도 src=A 유지(성공 시 교체 0)", mainImg()?.getAttribute("src") === "http://x/media-1-A.jpg");

  // ⑦ 인접(다음) 스토리 선로드 요청 발생
  ok("인접 스토리 선로드 요청(window.Image) 발생", preloadRequests.some((u) => u.startsWith("http://x/media-2-")));

  // ④ 실제 로드 오류 시에만 최신 URL B 로 1회 교체
  await act(async () => { mainImg()!.dispatchEvent(new (win.Event as typeof Event)("error")); });
  ok("error 후: 최신 URL B 로 1회 교체", mainImg()?.getAttribute("src") === "http://x/media-1-B.jpg");
  ok("교체 직후: B 미로드 상태라 placeholder(B 썸네일) 표시", placeholder()?.getAttribute("src") === "http://x/thumb-1-B.jpg");
  await act(async () => { mainImg()!.dispatchEvent(new (win.Event as typeof Event)("load")); });
  ok("B load 후: 본 이미지 표시", (mainImg()?.style.opacity ?? "") !== "0");
  // 추가 오류(같은 URL B 유지 상태) → 같은 URL 재시도 0 (무한 재로드 방지)
  await act(async () => { mainImg()!.dispatchEvent(new (win.Event as typeof Event)("error")); });
  await act(async () => { await Promise.resolve(); });
  ok("B error 후 새 URL 도착 전: 같은 URL 재시도 0(src=B 유지)", mainImg()?.getAttribute("src") === "http://x/media-1-B.jpg");
  // 삼순 3차 계약: B 도 실패한 뒤 4분 주기/retry 가 새 C URL 을 발급하면 교체 기회가 다시 열려야 한다.
  await act(async () => { applyLaterRefresh(1, "C"); });
  ok("B 실패 후 새 C URL 도착: C 로 교체(빈 화면 고정 방지)", mainImg()?.getAttribute("src") === "http://x/media-1-C.jpg");
  await act(async () => { mainImg()!.dispatchEvent(new (win.Event as typeof Event)("load")); });
  ok("C load 후: 본 이미지 표시(복구 완료)", (mainImg()?.style.opacity ?? "") !== "0");
  // C 성공 후 추가 error 없이 새 URL 이 와도 교체 0(성공 상태에서는 latch 유지)
  await act(async () => { applyLaterRefresh(1, "D"); });
  ok("C 성공 상태에서 새 D 도착: 교체 0(src=C 유지)", mainImg()?.getAttribute("src") === "http://x/media-1-C.jpg");

  // ⑤ 다음 스토리 전환 — 진입 시점 URL latch + 같은 계약 (전환 시 스토리 2 refresh 도 발생)
  const nextZone = q('button[aria-label="다음"]')!;
  await act(async () => { nextZone.dispatchEvent(pointer("pointerdown")); });
  await act(async () => { nextZone.dispatchEvent(pointer("pointerup")); });
  await act(async () => { await Promise.resolve(); });
  ok("전환: 스토리 2 refresh 실행", refreshCalls.includes(2));
  const img2src = mainImg()?.getAttribute("src") ?? "";
  ok("전환 직후: 진입 시점 URL latch(A 또는 B 중 진입 순간 값) + opacity 0", img2src.startsWith("http://x/media-2-") && mainImg()?.style.opacity === "0");
  ok("전환 직후: 같은 세대 썸네일 placeholder 표시", (placeholder()?.getAttribute("src") ?? "").startsWith("http://x/thumb-2-"));
  const src2Before = mainImg()?.getAttribute("src");
  await act(async () => { await Promise.resolve(); });
  ok("전환 후 refresh 가 도착해도 src 불변(latch)", mainImg()?.getAttribute("src") === src2Before);
  await act(async () => { mainImg()!.dispatchEvent(new (win.Event as typeof Event)("load")); });
  ok("전환 load 후: 표시 + placeholder 제거", (mainImg()?.style.opacity ?? "") !== "0" && placeholder() === null);

  // ⑥ thumbUrl 없는 스토리 — placeholder 없이 크래시 0
  await act(async () => { nextZone.dispatchEvent(pointer("pointerdown")); });
  await act(async () => { nextZone.dispatchEvent(pointer("pointerup")); });
  await act(async () => { await Promise.resolve(); });
  // 스토리 3 진입 순간 latch — refresh(B) 반영 전이면 A, 후면 B. 어느 쪽이든 placeholder 는 진입 latch 기준.
  // 진입 시점 thumbUrl=null(A 세대)이면 placeholder 없음.
  const img3 = mainImg();
  ok("thumbUrl 없음(진입 세대): 크래시 0 + 본 이미지 렌더", !!img3 && (img3.getAttribute("src") ?? "").startsWith("http://x/media-3-"));

  await act(async () => { root.unmount(); });
  globalThis.fetch = origFetch;
  console.log(`\nvenue-story media flash: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
