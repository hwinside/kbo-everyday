/**
 * iOS 26 post-keyboard visualViewport 완화 스모크.
 * 순수 판정 함수(키보드 열림/닫힘 전이·offsetTop 잔존 리셋 게이트·스냅샷) 회귀 +
 * 전역 가드 배선(마운트·resize/route 리셋·fixed TabBar 에 transform/backdrop 미도입) 정적 검증.
 * 이 스모크는 scroll nudge의 실제 WKWebView 복구 효능을 증명하지 않는다.
 * 실행: npm run qa:viewport-reset
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  isKeyboardOpen,
  detectKeyboardClose,
  shouldResetViewport,
  snapshotViewport,
  KEYBOARD_OPEN_GAP_PX,
  VIEWPORT_OFFSET_EPSILON,
} from "../../src/lib/utils/viewport-reset";
import type { VisualViewportLike } from "../../src/lib/venue-stories/keyboard-inset";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error("  ✗ " + name);
  }
}

// ── isKeyboardOpen ──
ok("gap>임계 → 열림", isKeyboardOpen(844, 844 - (KEYBOARD_OPEN_GAP_PX + 200)) === true);
ok("gap==임계 → 닫힘(경계 비포함)", isKeyboardOpen(844, 844 - KEYBOARD_OPEN_GAP_PX) === false);
ok("gap<임계(주소창 축소 등) → 닫힘", isKeyboardOpen(844, 844 - 50) === false);
ok("갭 0 → 닫힘", isKeyboardOpen(844, 844) === false);

// ── detectKeyboardClose ──
ok("open→closed = true", detectKeyboardClose(true, false) === true);
ok("closed→open = false", detectKeyboardClose(false, true) === false);
ok("open 유지 = false", detectKeyboardClose(true, true) === false);
ok("closed 유지 = false", detectKeyboardClose(false, false) === false);

// ── shouldResetViewport (정상 플랫폼 no-op / 버그시 리셋) ──
ok("offsetTop 0 → no-op", shouldResetViewport(0) === false);
ok("offsetTop 0.5(<eps) → no-op", shouldResetViewport(0.5) === false);
ok("offsetTop == eps → 리셋", shouldResetViewport(VIEWPORT_OFFSET_EPSILON) === true);
ok("offsetTop 잔존 → 완화 시도", shouldResetViewport(120) === true);
ok("음수 offsetTop 도 절대값 기준 리셋", shouldResetViewport(-40) === true);

// ── snapshotViewport (계측) ──
const vv: VisualViewportLike = {
  height: 500,
  offsetTop: 120,
  addEventListener() {},
  removeEventListener() {},
};
const snap = snapshotViewport(vv, 844);
ok("스냅샷 gap = inner - vvHeight", snap.gap === 344);
ok("스냅샷 keyboardOpen 반영", snap.keyboardOpen === true);
ok("스냅샷 offsetTop 전달", snap.offsetTop === 120);

// ── 시나리오: DM 키보드 열고 → 닫힘 → offsetTop 잔존 → 리셋 트리거 ──
let kbOpen = false;
// 열림
let open = isKeyboardOpen(844, 500);
let closeTransition = detectKeyboardClose(kbOpen, open);
kbOpen = open;
ok("1) DM 입력=열림, 닫힘전이 아님", open === true && closeTransition === false);
// 닫힘(높이 복귀) 하지만 offsetTop 잔존(iOS26)
open = isKeyboardOpen(844, 844);
closeTransition = detectKeyboardClose(kbOpen, open);
kbOpen = open;
ok("2) 키보드 닫힘 전이 감지", closeTransition === true);
ok("3) 닫혔는데 offsetTop 잔존 → 리셋 발동", closeTransition && shouldResetViewport(120) === true);
// 정상 플랫폼(닫힘 + offsetTop 0) → 리셋 안 함
ok("4) 정상 플랫폼 닫힘(offsetTop 0) → no-op", shouldResetViewport(0) === false);

// ── 배선 정적 검증 ──
const root = path.resolve(__dirname, "../..");
const guard = readFileSync(path.join(root, "src/components/ui/KeyboardViewportReset.tsx"), "utf8");
ok("가드: resize 리스너 구독", /addEventListener\("resize"/.test(guard));
ok("가드: 라우트 변경 리셋(usePathname 의존)", /usePathname/.test(guard) && /\[pathname\]/.test(guard));
ok("가드: coarse 포인터 게이팅", /pointer: coarse/.test(guard));
ok("가드: shouldResetViewport 게이트 사용", /shouldResetViewport/.test(guard));
ok("가드: nudge 전후 vv-debug 계측", /before-nudge/.test(guard) && /after-nudge/.test(guard));

const layout = readFileSync(path.join(root, "src/app/(main)/layout.tsx"), "utf8");
ok("layout: KeyboardViewportReset 마운트", /<KeyboardViewportReset\s*\/>/.test(layout));
ok("layout: KeyboardTabBarGuard 잔재 없음(회수)", !/KeyboardTabBarGuard/.test(layout));

const tabbar = readFileSync(path.join(root, "src/components/ui/TabBar.tsx"), "utf8");
const navLine = tabbar.split("\n").find((l) => l.includes("data-global-tabbar")) ?? "";
ok("TabBar: fixed nav 에 transform/will-change 없음(#445)", !/\btransform\b|will-change/.test(navLine));
ok("TabBar: fixed nav 자체에 backdrop-blur 없음(내부 레이어로 분리)", !/backdrop-blur/.test(navLine));

console.log(`\nviewport-reset smoke: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
