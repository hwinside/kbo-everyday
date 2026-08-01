// 야잘알봇 헤더 진입점 배선 회귀 (2026-08-02 하린아빠 지시).
//
// 요구: "쪽지 왼쪽에 야잘알봇 아이콘 추가 > 아이콘 누르면 바로 대화창 진입 & 대화 시작"
//
// 종전 경로는 쪽지 아이콘 → /messages 목록 → 최상단 야잘알봇 카드 → 대화 시작(3탭).
// 이 회귀는 "한 탭에 대화창까지" 계약이 실제로 배선돼 있는지를 소스에서 검사한다.
// 브라우저 E2E(qa:genius-entry-browser)와 역할이 다르다 — 여기는 배선 계약,
// 저기는 실제 렌더/클릭. 배선 계약을 따로 두는 이유는 컴포넌트만 만들고
// 헤더에 안 붙이거나, 라우팅을 /messages 목록으로 되돌리는 회귀를 잡기 위함.
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

// 쪽지 아이콘을 렌더하는 헤더는 하나가 아니다.
// 홈(HomeClientShell)은 공용 HeaderProfileLink 를 쓰지 않고 자체 헤더를 직접 그린다.
// 공용 컴포넌트만 고치면 홈 유저에게는 진입점이 아예 안 붙는다(삼순 NO-GO P0-1 — 실제로 그랬다).
// 그래서 "쪽지 링크를 가진 헤더 파일 전부"를 대상으로 같은 계약을 건다.
const HEADERS_WITH_DM = [
  "src/components/ui/HeaderProfileLink.tsx",
  "src/components/home/HomeClientShell.tsx",
] as const;

// --- 헤더 배선: 존재 + 쪽지 아이콘 '왼쪽' (쪽지 헤더 전부) ---
for (const file of HEADERS_WITH_DM) {
  const src = read(file);
  const name = file.split("/").pop();
  check(`[${name}] GeniusEntryButton을 렌더한다`, () => {
    assert.ok(/import\s+GeniusEntryButton\s+from/.test(src), "import 없음");
    assert.ok(/<GeniusEntryButton\s*\/>/.test(src), "렌더 없음");
  });
  check(`[${name}] 마스코트가 쪽지 아이콘보다 왼쪽에 있다`, () => {
    const mascotIdx = src.indexOf("<GeniusEntryButton");
    const dmIdx = src.indexOf('href="/messages"');
    assert.ok(mascotIdx >= 0 && dmIdx >= 0, "둘 중 하나를 찾지 못함");
    assert.ok(mascotIdx < dmIdx, "마스코트가 쪽지 아이콘 오른쪽에 있음");
  });
}

// 위 목록이 실제와 어긋나면(새 헤더가 생겼는데 등록 안 하면) 같은 사고가 반복된다.
// 쪽지 링크를 가진 클라이언트 헤더 파일을 실제로 훑어 목록과 대조한다.
check("쪽지 링크를 가진 헤더 파일이 목록에 빠짐없이 등록돼 있다", () => {
  const roots = ["src/components", "src/app"];
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(path.join(process.cwd(), dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith(".tsx")) {
        const src = readFileSync(path.join(process.cwd(), rel), "utf8");
        // 헤더 규격(min-h-[44px]) + 쪽지 링크 + aria-label="쪽지" 를 모두 가진 파일 = 전역 헤더
        if (
          src.includes('href="/messages"') &&
          src.includes('aria-label="쪽지"') &&
          src.includes("min-h-[44px]")
        ) {
          found.push(rel);
        }
      }
    }
  };
  roots.forEach(walk);
  const missing = found.filter((f) => !HEADERS_WITH_DM.includes(f as never));
  assert.deepEqual(missing, [], `헤더인데 회귀 대상에 없음: ${missing.join(", ")}`);
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
