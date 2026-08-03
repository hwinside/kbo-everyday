// 야잘알봇 쪽지 푸시 제외 회귀 (2026-08-02 하린아빠 지시).
//
// 사고: 야잘알봇 답변이 dm_messages에 INSERT되면 push_dispatch_on_dm 트리거 →
// /api/notifications/dispatch → handleDm의 일반 DM 분기를 타서 '✉️ 야잘알봇님의 쪽지'
// 푸시가 유저에게 발송된다. 유저는 방금 질문하고 앱을 보고 있는데 알림이 또 울린다.
//
// 검증 축 2개:
//  (A) 순수 판정 함수 isBaseballGeniusDmParticipant — 양방향 true, 무관 유저 false
//  (B) 실제 배선 — dispatch route 소스가 그 함수를 sender/receiver 둘 다 넘겨 호출하고,
//      일반 DM 푸시(prefKey "dm") 생성보다 앞에서 return 하는가
// (B)는 "함수만 만들고 route에 안 붙이는" false-green을 막는다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  BASEBALL_GENIUS_USER_ID,
  isBaseballGeniusDmParticipant,
} from "../../src/lib/constants/baseball-genius";

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

const USER_A = "00000000-0000-0000-0000-0000000000a1";
const USER_B = "00000000-0000-0000-0000-0000000000b2";

// --- (A) 순수 판정 ---
check("답변(봇→유저)은 제외 대상", () => {
  assert.equal(isBaseballGeniusDmParticipant(BASEBALL_GENIUS_USER_ID, USER_A), true);
});
check("질문(유저→봇)도 제외 대상", () => {
  assert.equal(isBaseballGeniusDmParticipant(USER_A, BASEBALL_GENIUS_USER_ID), true);
});
check("무관한 유저끼리 쪽지는 제외 아님(일반 푸시 유지)", () => {
  assert.equal(isBaseballGeniusDmParticipant(USER_A, USER_B), false);
});
check("null/undefined는 제외 아님", () => {
  assert.equal(isBaseballGeniusDmParticipant(null, undefined), false);
  assert.equal(isBaseballGeniusDmParticipant(undefined, null), false);
});

// --- (B) 실제 배선 ---
const routePath = path.join(process.cwd(), "src/app/api/notifications/dispatch/route.ts");
const route = readFileSync(routePath, "utf8");

const handleDmStart = route.indexOf("async function handleDm(");
check("handleDm이 dispatch route에 존재", () => {
  assert.ok(handleDmStart >= 0, "handleDm not found");
});
const handleDmEnd = route.indexOf("\nasync function handlePost(", handleDmStart);
const handleDm = route.slice(handleDmStart, handleDmEnd > 0 ? handleDmEnd : undefined);

const gateIdx = handleDm.search(
  /if\s*\(\s*isBaseballGeniusDmParticipant\s*\(\s*senderId\s*,\s*receiver[^)]*\)\s*\)\s*return\s*\[\s*\]\s*;/,
);
check("handleDm이 sender·receiver 둘 다 넘겨 게이트한다", () => {
  assert.ok(gateIdx >= 0, "야잘알봇 양방향 게이트 호출을 찾지 못함");
});

// 일반 DM 푸시(prefKey "dm") 생성보다 앞서야 실제로 차단된다.
const generalDmIdx = handleDm.lastIndexOf('prefKey: "dm"');
check("게이트가 일반 DM 푸시 생성보다 앞에 있다", () => {
  assert.ok(generalDmIdx >= 0, 'prefKey: "dm" 분기를 찾지 못함');
  assert.ok(gateIdx < generalDmIdx, "게이트가 일반 DM 푸시 뒤에 있어 차단되지 않음");
});

// 수신자 단방향만 보던 구계약이 남아 있으면 답변 푸시가 다시 새어나간다.
check("수신자 단방향 비교가 남아 있지 않다", () => {
  assert.ok(
    !/receiver\s*===\s*BASEBALL_GENIUS_USER_ID/.test(handleDm),
    "구 단방향 게이트(receiver only) 잔존",
  );
});

if (failures.length > 0) {
  console.error(`FAIL ${failures.length}`);
  for (const f of failures) console.error("  ✗ " + f);
  process.exit(1);
}
console.log(`✅ genius DM push exclusion: PASS=${pass} FAIL=0`);
