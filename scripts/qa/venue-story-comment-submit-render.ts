/**
 * 직관 스토리 댓글 전송 — 실제 VenueStoryViewer 렌더 + native pointer → POST spy (삼순 #948 5차 NO-GO).
 *
 * 배경: 기존 venue-story-comments-smoke 의 "1탭=1POST/trailing click 0중복/finally 뒤 2번째" 는
 * 로컬 posts++/endSubmit 모사라 실제 컴포넌트의 lock set/reset 을 제거해도 green 인 false-green 이었다.
 * 여기서는 진짜 VenueStoryViewer 를 jsdom 에 렌더해 실제 전송 버튼에 native pointer 이벤트를 던지고
 * fetch(POST /comments) 를 spy 한다. 실제 commentSubmitLockRef set/reset 과 pointerup 배선이 결과를 지배하므로:
 *   - lock SET 제거 → 동시 2탭이 2 POST 로 실패
 *   - lock RESET(finally) 제거 → 완료 뒤 2번째 탭이 0 POST 로 실패
 *   - pointerup→submit 배선 끊김 → 정상 탭이 0 POST 로 실패
 * = fault injection 이 회귀로 고정된다.
 * 실행: npm run qa:venue-story-comment-render
 */
import "./_smoke-env";
import { JSDOM } from "jsdom";

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

// jsdom 에 PointerEvent 가 없어 MouseEvent 로 'pointer*' 타입을 만들고 isPrimary/좌표를 심는다.
function pointer(type: string, opts: { clientX?: number; clientY?: number; button?: number; isPrimary?: boolean } = {}) {
  const MouseEventCtor = win.MouseEvent as typeof MouseEvent;
  const ev = new MouseEventCtor(type, {
    bubbles: true, cancelable: true,
    button: opts.button ?? 0, clientX: opts.clientX ?? 0, clientY: opts.clientY ?? 0,
  });
  Object.defineProperty(ev, "isPrimary", { value: opts.isPrimary ?? true, configurable: true });
  Object.defineProperty(ev, "pointerId", { value: 1, configurable: true });
  Object.defineProperty(ev, "pointerType", { value: "touch", configurable: true });
  return ev;
}
function setReactInputValue(input: HTMLInputElement, value: string) {
  const desc = Object.getOwnPropertyDescriptor(win.HTMLInputElement as typeof HTMLInputElement extends never ? never : object, "value")
    ?? Object.getOwnPropertyDescriptor((win.HTMLInputElement as { prototype: object }).prototype, "value");
  desc!.set!.call(input, value);
  input.dispatchEvent(new (win.Event as typeof Event)("input", { bubbles: true }));
}

async function main() {
  const React = (await import("react")).default;
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");

  // getSafeSession 이 토큰을 반환하도록 supabase 클라 객체의 메서드만 교체(ESM 재바인딩 아님).
  const clientMod = await import("../../src/lib/supabase/client");
  (clientMod.supabase.auth as unknown as { getSession: () => Promise<unknown> }).getSession = async () => ({
    data: { session: { access_token: "test-token", user: { id: "author-1" } } }, error: null,
  });

  const Viewer = (await import("../../src/components/game/VenueStoryViewer")).default;

  // ③ 아바타 회귀 결속용 GET 댓글 셋 — custom:/preset:/null 각 1건.
  // getAvatarPath 해석이 헤더·CommentAvatar 양쪽에서 실제 <img src> 로 렌더돼야 한다(삼순 #948 ③ NO-GO).
  const HEADER_AVATAR_RAW = "custom:https://cdn.test/header.jpg";
  const HEADER_AVATAR_URL = "https://cdn.test/header.jpg";
  const COMMENT_CUSTOM_RAW = "custom:https://cdn.test/comment.jpg";
  const COMMENT_CUSTOM_URL = "https://cdn.test/comment.jpg";
  const COMMENT_PRESET_RAW = "preset:baseball";
  const COMMENT_PRESET_URL = "/avatars/baseball.svg";
  const getComments = [
    { id: 101, content: "커스텀 아바타", userId: "u-custom", createdAt: new Date().toISOString(), author: { nickname: "커스텀", avatarUrl: COMMENT_CUSTOM_RAW, teamId: 1 } },
    { id: 102, content: "프리셋 아바타", userId: "u-preset", createdAt: new Date().toISOString(), author: { nickname: "프리셋", avatarUrl: COMMENT_PRESET_RAW, teamId: 2 } },
    { id: 103, content: "널 아바타", userId: "u-null", createdAt: new Date().toISOString(), author: { nickname: "널테스터", avatarUrl: null, teamId: 3 } },
  ];

  // fetch spy: POST /comments 카운트 + 필요 시 hold(동시성 검증), GET 은 위 아바타 댓글 셋.
  let postCount = 0;
  let holdPost = false;
  let releasers: Array<() => void> = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.includes("/comments") && method === "POST") {
      postCount++;
      const content = (() => { try { return JSON.parse(init?.body ?? "{}").content; } catch { return ""; } })();
      if (holdPost) await new Promise<void>((r) => releasers.push(r));
      return {
        ok: true, status: 200,
        json: async () => ({ comment: { id: 200 + postCount, content, userId: "author-1", createdAt: new Date().toISOString(), author: { nickname: "t", avatarUrl: null, teamId: 1 } } }),
      } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({ comments: getComments, total: getComments.length }) } as unknown as Response;
  }) as typeof fetch;

  const story = {
    id: 1, gameId: "20260729KTNC0", userId: "author-1", mediaType: "image" as const,
    mediaUrl: "http://x/y.jpg", thumbUrl: null, durationMs: null, width: 1080, height: 1920,
    caption: "테스트", venueVerified: true, createdAt: new Date().toISOString(),
    author: { nickname: "테스터", avatarUrl: HEADER_AVATAR_RAW, teamId: 1 },
  };

  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(React.createElement(Viewer as never, {
      stories: [story], startIndex: 0, currentUserId: "viewer-1", onClose: () => {}, onChanged: () => {},
    } as never));
  });

  // 뷰어는 document.body 로 createPortal 되므로 body 기준으로 쿼리.
  const scope = dom.window.document.body;
  // 댓글 시트 오픈
  const openBtn = scope.querySelector("[data-open-comments]") as HTMLElement | null;
  ok("전송 배선 전제: 댓글 열기 pill 렌더됨", !!openBtn);
  await act(async () => { openBtn!.dispatchEvent(new (win.MouseEvent as typeof MouseEvent)("click", { bubbles: true, cancelable: true })); });

  const input = scope.querySelector('input[placeholder="댓글을 입력하세요"]') as HTMLInputElement | null;
  ok("댓글 입력창 렌더됨", !!input);
  const sendBtn = scope.querySelector('button[aria-label="댓글 등록"]') as HTMLElement | null;
  ok("전송 버튼 렌더됨", !!sendBtn);

  // ── ③ 아바타 렌더 결속(삼순 #948 NO-GO 보완조건 1~4) ──
  // getAvatarPath 해석을 헤더/CommentAvatar 어느 한쪽이라도 제거하면 아래 assertion 이 fail 한다.
  const imgSrcs = Array.from(scope.querySelectorAll("img")).map((el) => (el as HTMLImageElement).getAttribute("src") ?? "");
  // 1) story header custom: → 실제 URL 렌더
  ok("헤더 아바타 custom: → 실제 URL <img src> 렌더", imgSrcs.includes(HEADER_AVATAR_URL));
  // 2) GET 댓글 작성자 custom: → 실제 URL 렌더
  ok("댓글 작성자 아바타 custom: → 실제 URL <img src> 렌더", imgSrcs.includes(COMMENT_CUSTOM_URL));
  // 3a) preset: → /avatars svg 경로 렌더
  ok("댓글 작성자 아바타 preset: → /avatars svg 경로 렌더", imgSrcs.includes(COMMENT_PRESET_URL));
  // 4) raw prefix 미해석 잔류 0 — getAvatarPath 제거 시 여기에 custom:/preset: 가 남아 fail
  ok("DOM 에 raw 'custom:'/'preset:' <img src> 잔류 0",
    !imgSrcs.some((s) => s.startsWith("custom:") || s.startsWith("preset:")));
  // 3b) null 아바타 → 이니셜 폴백(이미지 아님, 닉네임 첫 글자)
  const nullCommentBody = Array.from(scope.querySelectorAll("p"))
    .find((el) => el.textContent === "널 아바타");
  const nullCommentRow = nullCommentBody?.parentElement?.parentElement;
  const nullCommentAvatar = nullCommentRow?.firstElementChild as HTMLElement | null;
  const nullCommentInitial = nullCommentAvatar?.firstElementChild as HTMLElement | null;
  ok("null 아바타 댓글 row 직접 식별", nullCommentRow?.textContent?.includes("널테스터") === true);
  ok("null 아바타 댓글 → avatar child 에 img 0",
    nullCommentAvatar?.querySelectorAll("img").length === 0);
  ok("null 아바타 댓글 → 이니셜 정확히 '널'",
    nullCommentInitial?.textContent?.trim() === "널");
  ok("null 아바타 댓글 → 이니셜 visible",
    nullCommentInitial?.classList.contains("flex") === true
      && nullCommentInitial.classList.contains("hidden") === false);

  const typeContent = async (text: string) => { await act(async () => { setReactInputValue(input!, text); }); };
  const tap = async (opts: { clientX?: number; clientY?: number } = {}) => {
    await act(async () => {
      sendBtn!.dispatchEvent(pointer("pointerdown", opts));
      sendBtn!.dispatchEvent(pointer("pointerup", opts));
      // 브라우저가 pointerup 뒤 합성하는 trailing click 도 던져 중복 여부 확인
      sendBtn!.dispatchEvent(new (win.MouseEvent as typeof MouseEvent)("click", { bubbles: true, cancelable: true }));
    });
  };

  // ── (1) 정상 1탭 = 1 POST (+ trailing click 0 중복) ──
  await typeContent("첫 댓글");
  await tap({ clientX: 0, clientY: 0 });
  ok("1탭 → POST 정확히 1건(trailing click 중복 0)", postCount === 1);

  // ── (2) finally 뒤 lock reset → 2번째 댓글 전송 가능 ──
  await typeContent("두번째 댓글");
  await tap({ clientX: 0, clientY: 0 });
  ok("완료(finally 리셋) 뒤 2번째 탭 → POST 2건", postCount === 2);

  // ── (3) 동시 2탭(POST hold 로 lock 유지) → lock SET 이 두번째를 막아 1 POST ──
  holdPost = true;
  await typeContent("동시 탭");
  await act(async () => {
    // 탭A
    sendBtn!.dispatchEvent(pointer("pointerdown"));
    sendBtn!.dispatchEvent(pointer("pointerup"));
    // 탭B (A 의 POST 가 hold 로 in-flight = lock 보유 중)
    sendBtn!.dispatchEvent(pointer("pointerdown"));
    sendBtn!.dispatchEvent(pointer("pointerup"));
  });
  ok("동시 2탭(lock 보유) → POST 3건째만(누적 3, 두번째 탭 차단)", postCount === 3);
  // hold 해제 → in-flight 완료 + lock reset
  await act(async () => { holdPost = false; releasers.forEach((r) => r()); releasers = []; });

  // ── (4) pointercancel(스크롤 제스처) → 제출 안 함 ──
  await typeContent("취소 탭");
  await act(async () => {
    sendBtn!.dispatchEvent(pointer("pointerdown"));
    sendBtn!.dispatchEvent(pointer("pointercancel"));
    sendBtn!.dispatchEvent(pointer("pointerup"));
  });
  ok("pointercancel 후 pointerup → POST 증가 없음(누적 3 유지)", postCount === 3);

  // ── (5) drag-out(버튼 밖 좌표 릴리즈, touch implicit-capture) → 제출 안 함 ──
  await act(async () => {
    sendBtn!.dispatchEvent(pointer("pointerdown"));
    sendBtn!.dispatchEvent(pointer("pointerup", { clientX: 9999, clientY: 9999 }));
  });
  ok("drag-out(버튼 밖 릴리즈) → POST 증가 없음(누적 3 유지)", postCount === 3);

  // 취소 후에도 정상 탭은 다시 전송돼야 함(press 소비만, 영구 잠금 아님)
  await tap({ clientX: 0, clientY: 0 });
  ok("취소/드래그아웃 뒤 정상 탭 → POST 재개(누적 4)", postCount === 4);

  globalThis.fetch = origFetch;
  console.log(`\nvenue-story comment submit render: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("RENDER HARNESS ERROR:", e instanceof Error ? e.stack : e); process.exit(1); });
