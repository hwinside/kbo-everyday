#!/usr/bin/env node
/**
 * 홈 헤더 '회원가입' 버튼 규격 회귀.
 *
 * 계약 (2026-08-02, 하린아빠 "회원가입 버튼 크기 축소"):
 *  - 보이는 알약(pill)은 헤더 44px 슬롯보다 작아야 한다 (h-8 = 32px).
 *  - 그러나 터치 타겟은 44px 유지 (전역 헤더 규격v2 / #909). pill 축소가
 *    터치 타겟 축소로 번지면 접근성 회귀이므로 두 축을 분리해서 잠근다.
 *  - 라벨은 pill 안에 있어야 한다 (button 직속 텍스트면 padding이 곧 크기라
 *    "작게 보이는데 터치는 44px"이 성립하지 않는다).
 */
import { readFileSync } from "node:fs";

const FILE = "src/components/home/HomeClientShell.tsx";
const src = readFileSync(FILE, "utf8");

let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) {
    console.log(`  ✅ ${name}`);
  } else {
    failures += 1;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

// 로그인 버튼 블록만 추출 (setShowLogin 트리거 + '회원가입' 라벨)
const match = src.match(/<button\s+onClick=\{\(\) => setShowLogin\(true\)\}[\s\S]*?<\/button>/);
check("[구조] 헤더 비로그인 회원가입 버튼 블록 존재", Boolean(match));
if (!match) {
  console.log("\nFAIL 1 / exit 1");
  process.exit(1);
}
const block = match[0];
check("[구조] 라벨이 회원가입", block.includes("회원가입"));

const buttonClass = (block.match(/className="([^"]*)"/) || [])[1] || "";
const pillMatch = block.match(/<span\s+className="([^"]*)"[\s\S]*?회원가입/);
const pillClass = pillMatch ? pillMatch[1] : "";

check("[분리] 라벨이 내부 span(pill)에 감싸져 있음", Boolean(pillMatch), "button 직속 텍스트면 터치타겟=시각크기라 축소 불가");

// 1) 터치 타겟 44px 유지
check(
  "[접근성] 터치 타겟 높이 44px 유지 (h-11)",
  /\bh-11\b/.test(buttonClass),
  `button class="${buttonClass}"`,
);

// 2) 보이는 pill은 44px 미만
check(
  "[축소] 보이는 pill 높이 32px (h-8)",
  /\bh-8\b/.test(pillClass),
  `pill class="${pillClass}"`,
);
check(
  "[축소] pill 높이가 h-11/h-10 로 되돌아가지 않음",
  !/\bh-1[01]\b/.test(pillClass),
  `pill class="${pillClass}"`,
);
check(
  "[축소] 축소 이전 규격(min-h-11 + px-4 + text-sm)이 button 에 남아있지 않음",
  !(/\bmin-h-11\b/.test(buttonClass) && /\bpx-4\b/.test(buttonClass)),
  `button class="${buttonClass}"`,
);
check(
  "[축소] 라벨 폰트가 축소본(text-[13px])",
  /text-\[13px\]/.test(pillClass),
  `pill class="${pillClass}"`,
);

// 3) 시각 스타일(액센트 배경/알약)은 pill 로 이전됐고 사라지지 않았다
check("[스타일] pill 이 accent 배경 유지", /\bbg-accent\b/.test(pillClass));
check("[스타일] pill 이 rounded-full 유지", /\brounded-full\b/.test(pillClass));
check("[스타일] button 에는 중복 배경이 남지 않음", !/\bbg-accent\b/.test(buttonClass));

// 4) 옆 아바타 슬롯은 건드리지 않았다 (헤더 규격v2)
check(
  "[무회귀] 마이페이지 아바타 슬롯 44px(h-11 w-11) 유지",
  /aria-label="마이페이지"[\s\S]{0,200}h-11 w-11/.test(src),
);
check(
  "[무회귀] 헤더 행 min-h-[44px] 유지",
  src.includes('className="flex items-center justify-between min-h-[44px]"'),
);

console.log(failures === 0 ? "\nPASS — 12/12" : `\nFAIL ${failures} / exit 1`);
process.exit(failures === 0 ? 0 : 1);
