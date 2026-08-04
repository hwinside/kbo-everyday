import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { BLOCKED_ANSWER } from "../../src/lib/baseball-qa/pipeline";
import {
  BASEBALL_GENIUS_BANNER_NOTICE,
  BASEBALL_GENIUS_SCOPE_NOTICE,
} from "../../src/lib/constants/baseball-genius";

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
const popup = read("src/components/home/GeniusLaunchPopup.tsx");
const home = read("src/components/home/HomeClientShell.tsx");
const dmList = read("src/lib/supabase/useDM.ts");
const dmChat = read("src/app/(main)/messages/[conversationId]/page.tsx");

let passed = 0;
const check = (name: string, fn: () => void) => {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
};

check("질문 범위 exact SSOT", () => {
  assert.equal(
    BASEBALL_GENIUS_SCOPE_NOTICE,
    "야구 룰, 구단, 선수, 기록 관련 질문만 답변할 수 있어요.",
  );
});
check("첫 안내 배너가 범위 SSOT 사용", () => {
  assert.equal(
    BASEBALL_GENIUS_BANNER_NOTICE,
    `${BASEBALL_GENIUS_SCOPE_NOTICE} 그리고 야잘알봇도 실수를 하거나 잘못된 정보를 제공하는 경우가 있어요.`,
  );
  assert.match(dmChat, /\? BASEBALL_GENIUS_BANNER_NOTICE/);
});
check("답변불가 문구가 범위 SSOT 사용", () => {
  assert.equal(BLOCKED_ANSWER, `${BASEBALL_GENIUS_SCOPE_NOTICE} 예: "보크가 뭐야?"`);
});
check("쪽지 목록 첫 안내가 범위 SSOT 사용", () => {
  assert.match(dmList, /last_message: `\$\{BASEBALL_GENIUS_SCOPE_NOTICE\} ⚾`/);
});
check("홈에 온보딩 충돌 방지와 함께 팝업 배선", () => {
  assert.match(home, /<GeniusLaunchPopup enabled=\{!showOnboarding && !showPlayerSelect\} \/>/);
});
check("팝업 제목·문구·CTA·캐릭터", () => {
  assert.match(popup, /야잘알봇이 더 똑똑해졌어요/);
  assert.match(popup, /\{BASEBALL_GENIUS_SCOPE_NOTICE\}/);
  assert.match(popup, /\{BASEBALL_GENIUS_NAME\}에게 물어보기/);
  assert.match(popup, /\/mascot\/yajalal-avatar\.png/);
});
check("계정 ID별 1회 노출 키", () => {
  assert.match(popup, /`\$\{STORAGE_KEY_PREFIX\}\$\{user\.id\}`/);
  assert.match(popup, /localStorage\.getItem/);
  assert.match(popup, /localStorage\.setItem/);
});
check("닫기와 CTA 모두 dismiss 계약 사용", () => {
  assert.match(popup, /onClick=\{dismiss\}[\s\S]*aria-label="닫기"/);
  assert.match(popup, /const enterConversation[\s\S]*dismiss\(\);[\s\S]*router\.push/);
});
check("CTA가 기존방 또는 신규 초안방으로 직접 진입", () => {
  assert.match(popup, /getExistingConversation\(user\.id, BASEBALL_GENIUS_USER_ID\)/);
  assert.match(popup, /`\/messages\/\$\{conversationId\}`/);
  assert.match(popup, /`\/messages\/new-\$\{BASEBALL_GENIUS_USER_ID\}`/);
});

console.log(`genius launch contract: ${passed}/9 PASS`);
