// 야잘알봇 헤더 진입점 배선 계약.
//
// 이력: 2026-08-02 헤더 노출(#1057) → 2026-08-03 핫픽스로 미노출 계약 →
// **2026-08-21 하린아빠 "홈에 야잘알봇 꺼내기"로 재노출**. 홈 헤더(HomeClientShell)
// 쪽지 아이콘 왼쪽에 반드시 배선되어야 하고, 그 외 헤더(HeaderProfileLink)에는
// 붙이지 않는다(지시 범위가 "홈"). 같은 지시로 쪽지함 고정방은 제거됐으므로
// 이 버튼이 유일한 진입점이다 — 배선 누락은 진입점 증발이라 계약으로 잡는다.
// 브라우저 E2E(qa:genius-entry-browser)와 역할이 다르다 — 여기는 배선 계약,
// 저기는 실제 렌더/클릭.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { BASEBALL_GENIUS_USER_ID } from "../../src/lib/constants/baseball-genius";

let pass = 0;
const failures: string[] = [];
function check(name: string, fn: () => void) {
  try {
    fn();
    pass++;
  } catch (e) {
    failures.push(`${name}: ${(e as Error).message}`);
  }
}

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
const entry = read("src/components/ui/GeniusEntryButton.tsx");
const HOME_HEADER = "src/components/home/HomeClientShell.tsx";
const HEADERS_WITH_DM = [
  "src/components/ui/HeaderProfileLink.tsx",
  HOME_HEADER,
] as const;

// 홈 헤더: 반드시 노출 (2026-08-21 지시)
{
  const home = read(HOME_HEADER);
  check("[HomeClientShell] GeniusEntryButton을 노출한다", () => {
    assert.ok(/import\s+GeniusEntryButton\s+from/.test(home), "import 없음");
    assert.ok(/<GeniusEntryButton\s*\/>/.test(home), "렌더 없음");
  });
  check("[HomeClientShell] 버튼이 쪽지 링크 **왼쪽**에 있다", () => {
    const btnIdx = home.indexOf("<GeniusEntryButton");
    const dmIdx = home.indexOf('aria-label="\ucabd\uc9c0"');
    assert.ok(btnIdx >= 0 && dmIdx >= 0, "버튼 또는 쪽지 링크를 찾지 못함");
    assert.ok(btnIdx < dmIdx, "버튼이 쪽지 링크 뒤에 있다(지시: 왼쪽)");
  });
}

// 홈 외 헤더: 미노출 유지 (지시 범위는 홈)
{
  const header = read("src/components/ui/HeaderProfileLink.tsx");
  check("[HeaderProfileLink.tsx] GeniusEntryButton을 노출하지 않는다", () => {
    assert.ok(!/import\s+GeniusEntryButton\s+from/.test(header), "import가 남아 있음");
    assert.ok(!/<GeniusEntryButton\s*\/>/.test(header), "렌더가 남아 있음");
  });
}

// 쪽지함 목록: 야잘알봇 고정방 제거 (2026-08-21 "기본 쪽지함에서 야잘알봇 대화창 제거")
{
  const dmHook = read("src/lib/supabase/useDM.ts");
  check("[useDM.ts] 야잘알봇 고정방(pinnedGenius)이 없다", () => {
    assert.ok(!/pinnedGenius/.test(dmHook), "고정방이 남아 있음");
  });
  check("[useDM.ts] 목록에서 야잘알봇 대화를 필터한다", () => {
    assert.ok(
      /filter\(\(conversation\) => conversation\.other_user_id !== BASEBALL_GENIUS_USER_ID\)/.test(dmHook),
      "야잘알봇 제외 필터 없음",
    );
  });
  const unreadHook = read("src/lib/supabase/useUnreadDMCount.ts");
  check("[useUnreadDMCount.ts] 배지에서 야잘알봇 대화를 제외한다", () => {
    // 목록에서 숨긴 대화가 배지만 올리면 유저가 지울 수 없는 배지가 된다.
    assert.ok(/BASEBALL_GENIUS_USER_ID/.test(unreadHook), "야잘알봇 제외 필터 없음");
  });
}

check("쪽지 링크를 가진 헤더가 회귀 목록에서 누락되지 않는다", () => {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(path.join(process.cwd(), dir), { withFileTypes: true })) {
      const relative = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(relative);
      else if (entry.name.endsWith(".tsx")) {
        const source = read(relative);
        if (source.includes('href="/messages"') && source.includes('aria-label="쪽지"') && source.includes("min-h-[44px]")) {
          found.push(relative);
        }
      }
    }
  };
  walk("src/components");
  walk("src/app");
  assert.deepEqual(found.filter((file) => !HEADERS_WITH_DM.includes(file as never)), []);
});

const chatPage = read("src/app/(main)/messages/[conversationId]/page.tsx");
check("비로그인 직접 URL은 /messages로 이탈한다", () => {
  assert.match(chatPage, /if\s*\(!authLoading\s*&&\s*!user\)\s*router\.replace\("\/messages"\)/);
  assert.match(chatPage, /if\s*\(authLoading\s*\|\|\s*!user\)\s*return null/);
});

// --- 라우팅: 한 탭에 대화창 ---
check("기존 대화가 있으면 그 방으로 간다", () => {
  assert.ok(
    /router\.push\(\s*convId\s*\?\s*`\/messages\/\$\{convId\}`/.test(entry),
    "기존 대화 라우팅 없음",
  );
});
check("대화가 없으면 초안 방(new-)으로 바로 간다 — 목록 경유 금지", () => {
  assert.ok(
    /`\/messages\/new-\$\{BASEBALL_GENIUS_USER_ID\}`/.test(entry),
    "new- 초안 방 라우팅 없음",
  );
  // 목록으로 보내면 요구사항("바로 대화창 진입")이 깨진다.
  assert.ok(
    !/router\.push\(\s*["'`]\/messages["'`]\s*\)/.test(entry),
    "쪽지 목록으로 보내는 경로가 남아 있음",
  );
});
check("대상은 야잘알봇 상수 — 하드코딩 UUID 금지", () => {
  assert.ok(/BASEBALL_GENIUS_USER_ID/.test(entry), "상수 미사용");
  assert.ok(
    !entry.includes(BASEBALL_GENIUS_USER_ID),
    "UUID 리터럴이 하드코딩됨(상수와 어긋나면 조용히 엉뚱한 방으로 감)",
  );
});

// --- 비로그인: 진입 자체가 불가능해야 한다 (2026-08-02 하린아빠 지시) ---
// 종전 구현은 "버튼은 보이고 누르면 LoginSheet" 였다. 지시는 그게 아니라
// **비로그인이면 진입 불가** — 버튼을 아예 노출하지 않는다.
check("비로그인이면 버튼을 렌더하지 않는다(early return)", () => {
  const bodyStart = entry.indexOf("export default function GeniusEntryButton");
  assert.ok(bodyStart >= 0, "컴포넌트 선언을 찾지 못함");
  const body = entry.slice(bodyStart);

  const guardIdx = body.search(/if\s*\(\s*loading\s*\|\|\s*!user\s*\)\s*return null/);
  assert.ok(guardIdx >= 0, "비로그인/세션 미확정 early return 가드 없음");

  // 가드는 JSX 를 만들기 전에 있어야 한다. 뒤에 있으면 버튼이 이미 그려진 뒤다.
  const renderIdx = body.indexOf("return (");
  assert.ok(renderIdx >= 0, "렌더 return 을 찾지 못함");
  assert.ok(guardIdx < renderIdx, "가드가 렌더보다 뒤에 있어 비로그인에게도 버튼이 보인다");
});

check("로그인 유도 시트로 대체하지 않는다 — 진입 불가가 계약", () => {
  assert.ok(!/LoginSheet/.test(entry), "LoginSheet 가 남아 있음(비로그인에게 진입 경로를 열어줌)");
});

check("세션 미확정(loading) 구간에도 노출하지 않는다", () => {
  // 잠깐 보였다 사라지면 그 찰나에 눌릴 수 있고, 비로그인에게 '있었는데 없어진' 진입점이 된다.
  assert.ok(/const\s*\{\s*user\s*,\s*loading\s*\}\s*=\s*useAuth\(\)/.test(entry),
    "useAuth 에서 loading 을 읽지 않음");
});

check("클릭 핸들러에도 방어 가드가 남아 있다(클릭 시점 세션 만료)", () => {
  const bodyStart = entry.indexOf("const handleClick");
  assert.ok(bodyStart >= 0, "handleClick 핸들러를 찾지 못함");
  const body = entry.slice(bodyStart);
  const guardIdx = body.indexOf("if (!user) return");
  const lookupIdx = body.indexOf("getExistingConversation(");
  assert.ok(guardIdx >= 0, "클릭 시점 가드 없음");
  assert.ok(lookupIdx >= 0, "대화 조회 호출 없음");
  assert.ok(guardIdx < lookupIdx, "가드가 대화 조회 뒤에 있어 빈 대화가 생길 수 있음");
});

// --- 접근성/터치 타깃 ---
check("aria-label과 44px 터치 타깃이 있다", () => {
  assert.ok(/aria-label=/.test(entry), "aria-label 없음");
  assert.ok(/h-11\s+w-11/.test(entry), "헤더 공용 44px 터치 타깃(h-11 w-11) 아님");
});

if (failures.length > 0) {
  console.error(`FAIL ${failures.length}`);
  for (const f of failures) console.error("  ✗ " + f);
  process.exit(1);
}
console.log(`✅ genius entry wiring: PASS=${pass} FAIL=0`);
