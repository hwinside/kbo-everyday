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
import { readFileSync } from "node:fs";
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
const header = read("src/components/ui/HeaderProfileLink.tsx");

// --- 헤더 배선: 존재 + 쪽지 아이콘 '왼쪽' ---
check("헤더가 GeniusEntryButton을 렌더한다", () => {
  assert.ok(/import\s+GeniusEntryButton\s+from/.test(header), "import 없음");
  assert.ok(/<GeniusEntryButton\s*\/>/.test(header), "렌더 없음");
});
check("마스코트가 쪽지 아이콘보다 왼쪽에 있다", () => {
  const mascotIdx = header.indexOf("<GeniusEntryButton");
  const dmIdx = header.indexOf('href="/messages"');
  assert.ok(mascotIdx >= 0 && dmIdx >= 0, "둘 중 하나를 찾지 못함");
  assert.ok(mascotIdx < dmIdx, "마스코트가 쪽지 아이콘 오른쪽에 있음");
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

// --- 비로그인: 방을 만들지 않는다 ---
check("비로그인은 LoginSheet — 대화 조회/생성 전에 중단", () => {
  assert.ok(/LoginSheet/.test(entry), "LoginSheet 없음");
  // ⚠️ 파일 전체에서 indexOf 하면 상단 import 행이 잡혀 항상 "조회가 먼저"로 보인다.
  // 순서 계약은 클릭 핸들러 본문 안에서만 의미가 있으므로 범위를 좌힌다.
  const bodyStart = entry.indexOf("const handleClick");
  assert.ok(bodyStart >= 0, "handleClick 핸들러를 찾지 못함");
  const body = entry.slice(bodyStart);
  const guardIdx = body.indexOf("if (!user)");
  const lookupIdx = body.indexOf("getExistingConversation(");
  assert.ok(guardIdx >= 0, "비로그인 가드 없음");
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
