/**
 * 직관 스토리 뷰어 영상 첫 프레임 계약 — poster(썸네일) + preload 실배선 회귀.
 *
 * 배경(하린아빠 2026-08-02 리포트): 업로드 직후 영상을 재생하면 10초 가까이 검은 화면이었다.
 * 업로드 직후 서빙되는 파일은 720p 최적화본이 아니라 **원본**이고(720p 는 5분 cron 이 나중에 생성),
 * 그동안 <video> 에 poster 가 없어 첫 프레임 도착 전까지 완전 검은 화면이 노출됐다.
 * 서버는 이미 thumbUrl(포스터 jpg, signed URL)을 내려주고 있었으므로 화면단에서 쓰기만 하면 된다.
 *
 * 이 스모크는 실제 VenueStoryViewer 를 jsdom 에 렌더해 DOM 속성을 직접 읽는다 —
 * 소스 문자열 매칭이 아니라 실제 렌더 결과라, poster 배선을 제거하면 RED 가 난다.
 *   - poster={story.thumbUrl} 제거 → "poster = thumbUrl" FAIL
 *   - preload 제거 → "preload=auto" FAIL
 *   - thumbUrl 이 null 인 레거시 행에 poster="" 를 박으면 → "thumbUrl 없으면 poster 속성 자체 없음" FAIL
 *
 * 실행: npm run qa:venue-story-video-poster
 */
import "./_smoke-env";
import { JSDOM } from "jsdom";

const dom = new JSDOM(`<!DOCTYPE html><body></body>`, {
  pretendToBeVisual: true,
  url: "http://localhost/",
});
const win = dom.window as unknown as Record<string, unknown>;
const g = globalThis as unknown as Record<string, unknown>;
for (const k of [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "HTMLInputElement",
  "Element",
  "Node",
  "Event",
  "MouseEvent",
  "HTMLMediaElement",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "localStorage",
  "sessionStorage",
]) {
  g[k] = win[k];
}
(win.HTMLMediaElement as { prototype: HTMLMediaElement }).prototype.play = async () => {};
(win.HTMLMediaElement as { prototype: HTMLMediaElement }).prototype.pause = () => {};
// jsdom 미구현 — 뷰어 unmount 시 scroll-lock 해제가 window.scrollTo 를 부른다(계약 무관).
(win.window as unknown as { scrollTo: (...args: unknown[]) => void }).scrollTo = () => {};
(g as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.error(`  ❌ ${name}`);
  }
}

const THUMB_URL = "https://cdn.test/venue-stories/poster.jpg?token=abc";
const VIDEO_URL = "https://cdn.test/venue-stories/original.mp4?token=abc";

async function main() {
  const React = (await import("react")).default;
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");

  const clientMod = await import("../../src/lib/supabase/client");
  (clientMod.supabase.auth as unknown as { getSession: () => Promise<unknown> }).getSession =
    async () => ({
      data: { session: { access_token: "test-token", user: { id: "viewer-1" } } },
      error: null,
    });
  (
    clientMod.supabase.auth as unknown as { onAuthStateChange: (cb: unknown) => unknown }
  ).onAuthStateChange = () => ({ data: { subscription: { unsubscribe: () => {} } } });

  globalThis.fetch = (async () =>
    ({ ok: true, status: 200, json: async () => ({ comments: [], total: 0 }) }) as unknown as Response) as typeof fetch;

  const Viewer = (await import("../../src/components/game/VenueStoryViewer")).default;
  const { AuthProvider } = await import("../../src/lib/supabase/AuthContext");

  const baseStory = {
    gameId: "20260802LGOB0",
    userId: "author-1",
    durationMs: 10_000,
    width: 1080,
    height: 1920,
    caption: null,
    venueVerified: true,
    createdAt: new Date().toISOString(),
    author: { nickname: "테스터", avatarUrl: null, teamId: 1 },
  };
  const stories = [
    // ① 정상 영상 — 서버가 포스터 썸네일 signed URL 을 함께 내려준 행
    { ...baseStory, id: 1, mediaType: "video" as const, mediaUrl: VIDEO_URL, thumbUrl: THUMB_URL },
    // ② 레거시/포스터 검증 실패 행 — thumbUrl null
    { ...baseStory, id: 2, mediaType: "video" as const, mediaUrl: VIDEO_URL, thumbUrl: null },
    // ③ 사진 행 — poster 계약 무관(video 엘리먼트 자체가 없어야 함)
    {
      ...baseStory,
      id: 3,
      mediaType: "image" as const,
      mediaUrl: "https://cdn.test/photo.jpg",
      thumbUrl: THUMB_URL,
    },
  ];

  // ⚠️ 동일 root 에 startIndex 만 바꿔 re-render 하면 뷰어의 index 는 **초기값**이라 그대로여
  // 첫 스토리만 계속 보게 된다(하네스 결함 — 첫 작성 때 실제로 거짓 FAIL 발생).
  // 케이스마다 fresh mount/unmount 해야 의도한 스토리가 실제로 렌더된다.
  const scope = dom.window.document.body;
  let activeRoot: { unmount: () => void } | null = null;
  const render = async (startIndex: number) => {
    if (activeRoot) {
      const prev = activeRoot;
      await act(async () => prev.unmount());
      activeRoot = null;
    }
    const container = dom.window.document.createElement("div");
    dom.window.document.body.appendChild(container);
    const root = createRoot(container);
    activeRoot = root;
    await act(async () => {
      root.render(
        React.createElement(
          AuthProvider,
          null,
          React.createElement(Viewer as never, {
            stories,
            startIndex,
            currentUserId: "viewer-1",
            onClose: () => {},
            onChanged: () => {},
          } as never),
        ),
      );
    });
  };
  const videoEl = () =>
    scope.querySelector('video[data-story-media="video"]') as HTMLVideoElement | null;

  console.log("[① 영상 + 포스터 썸네일 — 첫 프레임 도착 전 검은 화면 방지]");
  await render(0);
  const v1 = videoEl();
  ok("영상 스토리는 <video> 렌더", v1 != null);
  ok(
    "poster = 서버가 내려준 thumbUrl(정확히 일치) — 원본 다운로드 전 정지컷 노출",
    v1?.getAttribute("poster") === THUMB_URL,
  );
  ok(
    "poster 는 mediaUrl(영상 본문)이 아니다 — 잘못 배선하면 포스터가 안 뜬다",
    v1?.getAttribute("poster") !== VIDEO_URL,
  );
  ok("preload=auto — 첫 프레임까지 선행 버퍼링", v1?.getAttribute("preload") === "auto");
  ok("src 는 그대로 mediaUrl", v1?.getAttribute("src") === VIDEO_URL);
  ok("자동재생/인라인 계약 유지", v1?.hasAttribute("autoplay") && v1?.hasAttribute("playsinline"));

  console.log("[② thumbUrl 없는 레거시 행 — 빈 poster 로 깨진 이미지 요청 금지]");
  await render(1);
  const v2 = videoEl();
  ok("영상 스토리는 <video> 렌더(레거시 행)", v2 != null);
  ok(
    "thumbUrl 이 null 이면 poster 속성 자체가 없다(poster=\"\" 로 빈 요청 발생 금지)",
    v2 != null && !v2.hasAttribute("poster"),
  );
  ok("preload 계약은 레거시 행에도 동일 적용", v2?.getAttribute("preload") === "auto");

  console.log("[③ 사진 행 — 영상 계약 비적용]");
  await render(2);
  ok("사진 스토리에는 <video> 없음", videoEl() == null);
  ok(
    "사진은 <img> 로 mediaUrl 렌더(포스터로 대체되지 않음)",
    Array.from(scope.querySelectorAll("img")).some(
      (im) => im.getAttribute("src") === "https://cdn.test/photo.jpg",
    ),
  );

  if (activeRoot) {
    const prev = activeRoot;
    await act(async () => prev.unmount());
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("  ❌ smoke threw:", e);
  process.exit(1);
});
