/**
 * 야잘알봇 picker 카드 비활성화 — **실제 렌더 결과**로 고정하는 회귀 게이트.
 *
 * ⚠️ 이 게이트가 생긴 이유 (삼순 7차 P0-1, 2026-08-04).
 *
 * answered-ID 누적이 깨지면 유저에게 실제로 생기는 일은 이거다:
 *   1. 유저가 동명이인 picker 를 받고 선수를 고른다 → 답변 도착
 *   2. Realtime 으로 무관한 새 메시지가 1건 들어온다
 *   3. answered 집합이 그 단건으로 **교체**되면 과거 answered id 가 전부 사라진다
 *   4. 완료된 picker 카드가 **다시 활성화**되고, 유저가 무심코 재탭한다
 *   5. 서버는 dedup 200 만 돌려주고 새 DM 이 안 생겨 **typing 인디케이터가 영원히 돈다**
 *
 * 그런데 종전 게이트는 helper 단위 테스트 + 소스 문자열 검사뿐이라, call-site 를
 * `merge(new Set(), ...)` 나 `factory([], ...)` 로 바꿔도 전부 GREEN 이었다.
 * helper 는 멀쩡하기 때문이다.
 *
 * 그래서 여기서는 **실제 React 로 카드를 마운트해 `<button disabled>` 를 읽는다.**
 * 중간 단계(집합 계산)가 어떻게 깨지든 최종 화면 상태로 잡힌다.
 *
 * 실행: npm run qa:genius-picker-disabled
 */
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  createBaseballQaAnsweredUpdater,
  type BaseballQaReplyMessage,
} from "../../src/lib/baseball-qa/client-outbox";
import {
  BASEBALL_GENIUS_USER_ID,
  isGeniusPickerDisabled,
  type GeniusPickerOption,
} from "../../src/lib/constants/baseball-genius";

// ⚠️ React 의 `act` 는 **development 번들에만** 있다(react package.json 조건부 exports).
// Vercel prebuild 는 NODE_ENV=production 이라 production 번들이 로드돼
// `TypeError: act is not a function` 으로 죽는다 — 2026-08-03 에 `next-game-date-badge-render`
// 가 똑같이 당했고, 이 파일이 그 교훈을 놓쳐 같은 사고를 반복했다(삼순 8차 실측).
// 로컬에서만 통과하는 게이트는 게이트가 아니다.
//
// react 는 아래에서 **dynamic import** 하므로(정적 import 는 hoisting 돼 이 줄보다 먼저 평가된다)
// 이 시점 세팅이 조건부 export 해석에 반영된다.
process.env.NODE_ENV = "development";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
const globals = globalThis as Record<string, unknown>;
globals.window = dom.window;
globals.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", {
  value: dom.window.navigator,
  configurable: true,
});
for (const key of ["HTMLElement", "Element", "Node", "Event", "MouseEvent"]) {
  globals[key] = (dom.window as unknown as Record<string, unknown>)[key];
}
(globals as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const QUESTION_ID = 222;
const OPTIONS: GeniusPickerOption[] = [
  { kbo_id: "50167", name: "이주형", team: "키움", position: "외야수", back_no: "51" },
  { kbo_id: "51302", name: "이주형", team: "한화", position: "내야수", back_no: "7" },
];

/** 전체 히스토리 — 질문 222 에 최종 답변이 이미 달려 있다. */
const HISTORY: BaseballQaReplyMessage[] = [
  { sender_id: BASEBALL_GENIUS_USER_ID, dedup_key: `baseball-genius-picker:${QUESTION_ID}` },
  { sender_id: BASEBALL_GENIUS_USER_ID, dedup_key: `baseball-genius:${QUESTION_ID}` },
  { sender_id: BASEBALL_GENIUS_USER_ID, dedup_key: "baseball-genius:333" },
];

/** Realtime INSERT 단건 — 이 picker 와 무관한 메시지. */
const UNRELATED_DELTA: BaseballQaReplyMessage[] = [
  { sender_id: "some-other-user", dedup_key: null },
];

let pass = 0;
const failures: string[] = [];
function check(name: string, fn: () => void) {
  try {
    fn();
    pass++;
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failures.push(`${name}: ${(error as Error).message}`);
    console.error(`  ❌ ${name}: ${(error as Error).message}`);
  }
}

async function main() {
  const React = (await import("react")).default;
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  // 위 NODE_ENV 고정이 깨지면 여기서 **명시적으로** 죽는다 — 원인 불명 TypeError 대신
  // 무엇이 잘못됐는지 말해주는 실패로 만든다.
  assert.equal(typeof act, "function",
    "React.act 가 없다 — development 번들이 로드되지 않았다(NODE_ENV 고정이 import 보다 늦었는지 확인)");
  const GeniusPlayerPicker = (await import("../../src/components/dm/GeniusPlayerPicker")).default;

  /**
   * 관측 시퀀스를 그대로 재생해 answered 집합을 만든 뒤 카드를 렌더한다.
   *
   * `observe` 는 useDM 의 `observeBaseballQaMessages` 가 하는 일과 같은 모양이다 —
   * factory 로 updater 를 만들어 이전 상태에 적용한다.
   */
  function renderAfterObservations(sequences: BaseballQaReplyMessage[][]) {
    let answered: ReadonlySet<number> = new Set<number>();
    for (const messages of sequences) {
      answered = createBaseballQaAnsweredUpdater(messages, BASEBALL_GENIUS_USER_ID)(answered);
    }
    const picked: ReadonlySet<number> = new Set<number>();

    const host = dom.window.document.createElement("div");
    dom.window.document.body.appendChild(host);
    const root = createRoot(host);
    let picks = 0;
    void act(() => {
      root.render(
        React.createElement(GeniusPlayerPicker, {
          options: OPTIONS,
          onPick: () => { picks++; },
          disabled: isGeniusPickerDisabled(QUESTION_ID, answered, picked),
        }),
      );
    });
    const buttons = Array.from(
      host.querySelectorAll("[data-testid='genius-player-picker-option']"),
    ) as HTMLButtonElement[];
    return {
      answered,
      buttons,
      clickFirst: () => {
        void act(() => {
          buttons[0].dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
        });
        return picks;
      },
      cleanup: () => {
        void act(() => { root.unmount(); });
        host.remove();
      },
    };
  }

  // ── ① 전체 히스토리만 관측한 상태: 이미 답변된 picker 는 비활성화 ──────────────
  {
    const view = renderAfterObservations([HISTORY]);
    check("전체 히스토리 관측 후 완료 picker 는 disabled", () => {
      assert.equal(view.buttons.length, 2, "선택지 2개 렌더");
      for (const button of view.buttons) {
        assert.equal(button.disabled, true, "완료된 picker 버튼은 disabled 여야 한다");
      }
    });
    check("disabled 상태에서는 클릭해도 onPick 이 불리지 않는다", () => {
      assert.equal(view.clickFirst(), 0, "disabled 버튼 클릭은 요청을 만들지 않는다");
    });
    view.cleanup();
  }

  // ── ② 핵심: 히스토리 뒤 **무관한 Realtime 단건**이 와도 계속 disabled ──────────
  // 누적이 교체로 바뀌면 여기서 버튼이 다시 살아난다 → 영구 typing 재발 경로.
  {
    const view = renderAfterObservations([HISTORY, UNRELATED_DELTA]);
    check("무관한 Realtime 단건 뒤에도 완료 picker 는 여전히 disabled", () => {
      assert.deepEqual(
        [...view.answered].sort((a, b) => a - b),
        [222, 333],
        "answered 집합이 단건 증분으로 사라지면 안 된다",
      );
      for (const button of view.buttons) {
        assert.equal(
          button.disabled,
          true,
          "무관한 메시지 1건 때문에 완료된 picker 가 다시 활성화되면 영구 typing 이 재발한다",
        );
      }
    });
    check("증분 이후에도 클릭이 요청을 만들지 않는다", () => {
      assert.equal(view.clickFirst(), 0);
    });
    view.cleanup();
  }

  // ── ③ 반대 방향: 아직 답변이 없는 picker 는 **활성**이어야 한다 ────────────────
  // 전부 disabled 로 굳혀놓고 ①②를 통과시키는 false-green 을 막는다.
  {
    const view = renderAfterObservations([[{ sender_id: BASEBALL_GENIUS_USER_ID, dedup_key: `baseball-genius-picker:${QUESTION_ID}` }]]);
    check("미답변 picker 는 활성이고 클릭이 onPick 을 부른다", () => {
      assert.equal(view.answered.size, 0, "picker 쪽지만으로는 answered 가 아니다");
      for (const button of view.buttons) {
        assert.equal(button.disabled, false, "아직 답변이 없으면 고를 수 있어야 한다");
      }
      assert.equal(view.clickFirst(), 1, "활성 버튼 클릭은 onPick 1회");
    });
    view.cleanup();
  }

  // ── ④ question_message_id 부재는 fail-close ───────────────────────────────────
  check("question_message_id 가 없으면 fail-close(disabled)", () => {
    assert.equal(
      isGeniusPickerDisabled(undefined, new Set<number>(), new Set<number>()),
      true,
      "어느 질문인지 모르면 눌러도 재처리 대상을 특정할 수 없다",
    );
  });

  // ── ⑤ 이번 세션에 이미 고른 picker 도 disabled ────────────────────────────────
  check("이번 세션에 고른 picker 도 disabled", () => {
    assert.equal(
      isGeniusPickerDisabled(QUESTION_ID, new Set<number>(), new Set<number>([QUESTION_ID])),
      true,
    );
  });

  if (failures.length > 0) {
    console.error(`❌ genius picker disabled render: PASS=${pass} FAIL=${failures.length}`);
    process.exit(1);
  }
  console.log(`✅ genius picker disabled render: PASS=${pass} FAIL=0`);
}

main().catch((error) => {
  console.error("❌ genius picker disabled render FAIL:", error);
  process.exit(1);
});
