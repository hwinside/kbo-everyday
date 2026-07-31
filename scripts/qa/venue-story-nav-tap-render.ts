/**
 * 직관 스토리 뷰어 넘기기/닫기 — 실제 VenueStoryViewer 렌더 + native pointer 회귀 (하린아빠 7/31 iOS).
 *
 * 고정하는 결손 2건:
 *   ② 닫기 X 가 잘 안 눌림 — 36px 터치타깃 + top-0 넘기기 존이 헤더 밑에 깔려, X 빗맞은 탭이
 *      onClose 대신 goNext 로 새어 스토리가 넘어갔다.
 *   ③ 다음 영상으로 가려면 오른쪽을 두 번 눌러야 함 — pointerdown 즉시 setPaused(true) /
 *      pointerup setPaused(false) 토글이 첫 탭을 먹어 click 이 씨혔다. 인스타처럼 1탭 = 1이동.
 *
 * 정적 정규식 가드(venue-story-comments-smoke)와 달리 여기선 진짜 컴포넌트에 네이티브 pointer 를
 * 던져 index 이동/onClose 호출 횟수를 센다 → 배선이 끊기면 실제로 fail 한다.
 * 실행: npm run qa:venue-story-nav-tap
 */
import "./_smoke-env";
import { JSDOM } from "jsdom";
import { STORY_NAV_TAP_MAX_MS } from "../../src/lib/venue-stories/story-tap-zone";

const dom = new JSDOM(`<!DOCTYPE html><body></body>`, { pretendToBeVisual: true, url: "http://localhost/" });
const win = dom.window as unknown as Record<string, unknown>;
const g = globalThis as unknown as Record<string, unknown>;
for (const k of [
  "window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "Node",
  "Event", "MouseEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "localStorage",
]) {
  g[k] = win[k];
}
(g as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.error(`  ❌ ${name}`); }
}

// jsdom 에 PointerEvent 가 없어 MouseEvent 로 'pointer*' 타입을 만든다(comment-submit-render 동일 패턴).
function pointer(type: string, opts: { clientX?: number; clientY?: number } = {}) {
  const MouseEventCtor = win.MouseEvent as typeof MouseEvent;
  const ev = new MouseEventCtor(type, {
    bubbles: true, cancelable: true, button: 0,
    clientX: opts.clientX ?? 100, clientY: opts.clientY ?? 400,
  });
  Object.defineProperty(ev, "isPrimary", { value: true, configurable: true });
  Object.defineProperty(ev, "pointerType", { value: "touch", configurable: true });
  return ev;
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function makeStory(id: number) {
  return {
    id, gameId: "20260731KTNC0", userId: `author-${id}`, mediaType: "image" as const,
    mediaUrl: `http://x/${id}.jpg`, thumbUrl: null, durationMs: null, width: 1080, height: 1920,
    caption: null, venueVerified: true, createdAt: new Date().toISOString(),
    author: { nickname: `작성자${id}`, avatarUrl: null, teamId: 1 },
  };
}

async function main() {
  const React = (await import("react")).default;
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true, status: 200, json: async () => ({ comments: [], total: 0 }),
  })) as unknown as typeof fetch;

  const Viewer = (await import("../../src/components/game/VenueStoryViewer")).default;

  let closeCount = 0;
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(Viewer as never, {
      stories: [makeStory(11), makeStory(12), makeStory(13)],
      startIndex: 0, currentUserId: "viewer-1",
      onClose: () => { closeCount++; }, onChanged: () => {},
    } as never));
  });

  const scope = dom.window.document.body;
  const currentStoryId = () =>
    scope.querySelector("[data-venue-story-viewer]")?.getAttribute("data-story-id") ?? null;
  const nextZone = scope.querySelector('button[aria-label="다음"]') as HTMLElement | null;
  const prevZone = scope.querySelector('button[aria-label="이전"]') as HTMLElement | null;
  const closeBtn = scope.querySelector('button[aria-label="닫기"]') as HTMLElement | null;

  ok("넘기기 존(이전/다음)·닫기 X 렌더됨", !!nextZone && !!prevZone && !!closeBtn);
  ok("시작 스토리 = 11", currentStoryId() === "11");

  // 브라우저 실제 순서: pointerdown → pointerup → (합성) click. 한 탭에 전부 던진다.
  const tapZone = async (el: HTMLElement) => {
    await act(async () => {
      el.dispatchEvent(pointer("pointerdown"));
      el.dispatchEvent(pointer("pointerup"));
      el.dispatchEvent(new (win.MouseEvent as typeof MouseEvent)("click", { bubbles: true, cancelable: true }));
    });
  };

  // ── ③ 1탭 = 1이동 ──
  await tapZone(nextZone!);
  ok("오른쪽 1탭 → 다음 스토리(12) 이동 (두 번 눌러야 하는 결손 회귀)", currentStoryId() === "12");
  await tapZone(nextZone!);
  ok("오른쪽 1탭 더 → 13 이동", currentStoryId() === "13");
  await tapZone(prevZone!);
  ok("왼쪽 1탭 → 이전 스토리(12) 이동", currentStoryId() === "12");

  // 1탭이 pointerup + trailing click 으로 2칸 점프하지 않아야 한다(중복 이동 방지)
  await tapZone(prevZone!);
  ok("1탭당 정확히 1칸(11로 복귀 — 2칸 점프 없음)", currentStoryId() === "11");

  // ── long-press 는 이동하지 않고 일시정지 ──
  const before = currentStoryId();
  await act(async () => { nextZone!.dispatchEvent(pointer("pointerdown")); });
  await act(async () => { await sleep(STORY_NAV_TAP_MAX_MS + 120); });
  await act(async () => {
    nextZone!.dispatchEvent(pointer("pointerup"));
    nextZone!.dispatchEvent(new (win.MouseEvent as typeof MouseEvent)("click", { bubbles: true, cancelable: true }));
  });
  ok("길게 누르기(>200ms) → 이동 없음(일시정지 경로 유지)", currentStoryId() === before);

  // ── 스와이프(큰 이동) 는 넘기지 않는다 ──
  await act(async () => {
    nextZone!.dispatchEvent(pointer("pointerdown", { clientX: 100, clientY: 400 }));
    nextZone!.dispatchEvent(pointer("pointerup", { clientX: 100, clientY: 480 }));
    nextZone!.dispatchEvent(new (win.MouseEvent as typeof MouseEvent)("click", { bubbles: true, cancelable: true }));
  });
  ok("세로 스와이프(80px) → 이동 없음", currentStoryId() === before);

  // ── ② 닫기 X ──
  ok("닫기 전 onClose 호출 0", closeCount === 0);
  await act(async () => {
    closeBtn!.dispatchEvent(new (win.MouseEvent as typeof MouseEvent)("click", { bubbles: true, cancelable: true }));
  });
  ok("X 탭 → onClose 1회", closeCount === 1);
  ok("X 탭이 스토리를 넘기지 않음", currentStoryId() === before);

  // 헤더 컨트롤 44px 터치타깃(애플 최소) — 클래스 기준(jsdom 은 레이아웃 계산 없음)
  for (const [label, el] of [
    ["닫기", closeBtn],
    ["더보기", scope.querySelector('button[aria-label="더보기"]')],
  ] as const) {
    ok(`헤더 ${label} 버튼 44px 터치타깃(w-11 h-11)`,
      (el as HTMLElement | null)?.className.includes("w-11 h-11") === true);
  }

  globalThis.fetch = origFetch;
  console.log(`\nvenue-story nav tap render: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("NAV RENDER HARNESS ERROR:", e instanceof Error ? e.stack : e); process.exit(1); });
