#!/usr/bin/env node
// 크관 자동 포커싱 토글 게이트 (PR #1291)
// -----------------------------------------------------------------
// 계약:
//  A. KgwanTab LiveView 는 CurrentAtBatCard scrollOnUpdate 를
//     useKgwanAutoFocus().enabled 에 결속한다 (고정 true 금지).
//  B. GameChat 의 onHide 행에는 자동 포커싱 토글 버튼이 "채팅 끄기"
//     버튼보다 *앞*(왼쪽)에 있고, toggleAutoFocus 로 배선된다.
//  C. useKgwanAutoFocus 는 메모리 값을 1차 소스로 둔다 — localStorage
//     쓰기 실패 시에도 토글·이벤트 동기화가 동작해야 한다(삼순 blocker).
//     기본값 ON, 이벤트 브로드캐스트 필수.
// --selftest: 결함주입 mutant 소스를 *실행 게이트와 같은 predicate* 에
// 태워 RED 를 증명한다 (사본 seam 금지 — 게이트 본판정과 동일 함수).
// mutant 패치 미적용(target 문자열 부재)은 PASS 가 아니라 FAIL.
import { readFileSync } from "node:fs";

const SELFTEST = process.argv.includes("--selftest");
const HOOK_PATH = "src/hooks/useKgwanAutoFocus.ts";
const KGWAN_PATH = "src/components/game/KgwanTab.tsx";
const CHAT_PATH = "src/components/game/GameChat.tsx";

let pass = 0;
let fail = 0;

function ok(name, condition, detail = "") {
  if (condition) {
    pass += 1;
    console.log(`  ✓ ${name}`);
    return;
  }
  fail += 1;
  console.error(`  ✗ ${name}${detail ? ` (${detail})` : ""}`);
}

// 주석 문면이 assertion 을 만족시키는 false-green 차단 — 오프셋 보존 blank 처리.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

// ---- predicate (본판정과 selftest 가 공유하는 단일 seam) ----

export function evaluateKgwanBinding(rawSrc) {
  const src = stripComments(rawSrc);
  const failures = [];
  if (!/const \{ enabled: autoFocusEnabled \} = useKgwanAutoFocus\(\);/.test(src)) {
    failures.push("LiveView가 useKgwanAutoFocus를 구독하지 않는다");
  }
  if (!/scrollOnUpdate=\{autoFocusEnabled\}/.test(src)) {
    failures.push("scrollOnUpdate가 autoFocusEnabled에 결속되지 않았다");
  }
  // 고정 true(bare prop) 잔존 금지 — `scrollOnUpdate` 뒤에 `={`가 없는 사용처 검출.
  if (/scrollOnUpdate(?!=\{)/.test(src.replace(/scrollOnUpdate\?:/g, ""))) {
    failures.push("결속 없는 bare scrollOnUpdate 사용이 남아 있다");
  }
  return { ok: failures.length === 0, failures };
}

export function evaluateChatButtonRow(rawSrc) {
  const src = stripComments(rawSrc);
  const failures = [];
  if (!/const \{ enabled: autoFocusEnabled, toggle: toggleAutoFocus \} = useKgwanAutoFocus\(\);/.test(src)) {
    failures.push("GameChat이 useKgwanAutoFocus를 구독하지 않는다");
  }
  const toggleIdx = src.indexOf("onClick={toggleAutoFocus}");
  const hideIdx = src.indexOf('aria-label="전체 채팅 끄기"');
  if (toggleIdx === -1) failures.push("자동 포커싱 토글 버튼이 없다");
  if (hideIdx === -1) failures.push("채팅 끄기 버튼이 없다");
  if (toggleIdx !== -1 && hideIdx !== -1 && toggleIdx > hideIdx) {
    failures.push("토글 버튼이 채팅 끄기 오른쪽에 있다 (왼쪽 배치 계약 위반)");
  }
  if (!/aria-label=\{autoFocusEnabled \? "자동 포커싱 끄기" : "자동 포커싱 켜기"\}/.test(src)) {
    failures.push("토글 aria-label 상태 분기가 없다");
  }
  return { ok: failures.length === 0, failures };
}

export function evaluateHookContract(rawSrc) {
  const src = stripComments(rawSrc);
  const failures = [];
  if (!/let memoryEnabled: boolean \| null = null;/.test(src)) {
    failures.push("메모리 1차 소스(memoryEnabled)가 없다");
  }
  if (!/if \(memoryEnabled !== null\) return memoryEnabled;/.test(src)) {
    failures.push("readEnabled가 메모리 값을 우선하지 않는다");
  }
  if (!/window\.localStorage\.getItem\(STORAGE_KEY\) !== "off"/.test(src)) {
    failures.push("기본값 ON 계약(미설정=ON)이 깨졌다");
  }
  const memWriteIdx = src.indexOf("memoryEnabled = next;");
  const storageWriteIdx = src.indexOf("window.localStorage.setItem(STORAGE_KEY");
  const dispatchIdx = src.indexOf("window.dispatchEvent(new Event(EVENT_NAME));");
  if (memWriteIdx === -1) {
    failures.push("toggle이 메모리 값을 갱신하지 않는다 (localStorage 실패 시 토글 무효화)");
  }
  if (storageWriteIdx === -1) failures.push("localStorage 영속 쓰기가 없다");
  if (dispatchIdx === -1) failures.push("변경 이벤트 브로드캐스트가 없다");
  if (memWriteIdx !== -1 && storageWriteIdx !== -1 && memWriteIdx > storageWriteIdx) {
    failures.push("메모리 갱신이 localStorage 쓰기(실패 가능 지점) 뒤에 있다");
  }
  if (dispatchIdx !== -1 && memWriteIdx !== -1 && dispatchIdx < memWriteIdx) {
    failures.push("이벤트가 메모리 갱신 전에 발화된다");
  }
  return { ok: failures.length === 0, failures };
}

// ---- 실행 ----

function read(path) {
  return readFileSync(path, "utf8");
}

function runGate() {
  const kgwan = evaluateKgwanBinding(read(KGWAN_PATH));
  ok("A. KgwanTab scrollOnUpdate ↔ autoFocusEnabled 결속", kgwan.ok, kgwan.failures.join(" / "));
  const chat = evaluateChatButtonRow(read(CHAT_PATH));
  ok("B. GameChat 토글 버튼 — 채팅 끄기 왼쪽 + 배선", chat.ok, chat.failures.join(" / "));
  const hook = evaluateHookContract(read(HOOK_PATH));
  ok("C. useKgwanAutoFocus 메모리 1차 소스 + 기본 ON + 이벤트", hook.ok, hook.failures.join(" / "));
}

function mutate(src, from, to) {
  if (!src.includes(from)) throw new Error(`mutation target missing: ${JSON.stringify(from.slice(0, 60))}`);
  return src.replace(from, to);
}

function runSelfTest() {
  const kgwanSrc = read(KGWAN_PATH);
  const chatSrc = read(CHAT_PATH);
  const hookSrc = read(HOOK_PATH);

  // baseline GREEN — mutant 판정이 "항상 RED"가 아님을 먼저 증명.
  ok("baseline: 세 파일 모두 GREEN",
    evaluateKgwanBinding(kgwanSrc).ok && evaluateChatButtonRow(chatSrc).ok && evaluateHookContract(hookSrc).ok);

  const cases = [
    {
      name: "M1 scrollOnUpdate 고정 true 회귀 (결속 제거)",
      red: () => !evaluateKgwanBinding(
        mutate(kgwanSrc, "scrollOnUpdate={autoFocusEnabled}", "scrollOnUpdate"),
      ).ok,
    },
    {
      name: "M2 KgwanTab hook 구독 제거",
      red: () => !evaluateKgwanBinding(
        mutate(kgwanSrc, "const { enabled: autoFocusEnabled } = useKgwanAutoFocus();", ""),
      ).ok,
    },
    {
      name: "M3 토글 버튼을 채팅 끄기 오른쪽으로 이동",
      red: () => {
        // onClick 앵커를 맞바꿔 순서 반전을 시뮬레이트 — 위치 판정이 실제로 순서를 본다.
        const swapped = mutate(
          mutate(
            mutate(chatSrc, "onClick={toggleAutoFocus}", "onClick={__TMP__}"),
            'aria-label="전체 채팅 끄기"',
            "onClick={toggleAutoFocus}",
          ),
          "onClick={__TMP__}",
          'aria-label="전체 채팅 끄기"',
        );
        return !evaluateChatButtonRow(swapped).ok;
      },
    },
    {
      name: "M4 토글 버튼 삭제",
      red: () => !evaluateChatButtonRow(
        mutate(chatSrc, "onClick={toggleAutoFocus}", "onClick={undefined}"),
      ).ok,
    },
    {
      name: "M5 기본값 OFF 회귀 (!== \"off\" → === \"on\")",
      red: () => !evaluateHookContract(
        mutate(hookSrc, 'window.localStorage.getItem(STORAGE_KEY) !== "off"', 'window.localStorage.getItem(STORAGE_KEY) === "on"'),
      ).ok,
    },
    {
      name: "M6 메모리 갱신 제거 (localStorage 실패 시 토글 무효화 재현)",
      red: () => !evaluateHookContract(
        mutate(hookSrc, "memoryEnabled = next;", ""),
      ).ok,
    },
    {
      name: "M7 이벤트 브로드캐스트 제거",
      red: () => !evaluateHookContract(
        mutate(hookSrc, "window.dispatchEvent(new Event(EVENT_NAME));", ""),
      ).ok,
    },
    {
      name: "M8 메모리 우선 read 제거",
      red: () => !evaluateHookContract(
        mutate(hookSrc, "if (memoryEnabled !== null) return memoryEnabled;", ""),
      ).ok,
    },
  ];

  for (const c of cases) {
    let red = false;
    let error = "";
    try {
      red = c.red();
    } catch (e) {
      error = String(e?.message ?? e);
    }
    ok(`mutant RED: ${c.name}`, red && !error, error || "mutant가 GREEN으로 통과했다");
  }
}

if (SELFTEST) {
  console.log("[kgwan-autofocus-gate] --selftest (결함주입 mutant는 RED여야 함)");
  runSelfTest();
} else {
  console.log("[kgwan-autofocus-gate] 계약 검사");
  runGate();
}

console.log(`kgwan-autofocus-gate: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
