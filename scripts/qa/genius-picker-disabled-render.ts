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
  const GeniusQuestionCorrectionPicker = (await import("../../src/components/dm/GeniusQuestionCorrectionPicker")).default;

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

  // ── 교정 카드: 실제 prop(`onRespond`)로 선택·거절 종단 흐름을 검증한다 ────────
  //
  // 🔴 직전 회차 결손(삼순 2026-08-13): 이 게이트가 죽은 `onPick` 을 넘겨서, 핸들러가
  //    아예 결속되지 않은 상태로도 disabled 2건만 PASS 하는 false-green 이었다.
  //    그래서 여기서는 **컴포넌트가 실제로 요구하는 prop 이름**을 타입으로 강제하고
  //    (`ComponentProps` 추출), 클릭 → outbox → API body 까지 종단으로 태운다.
  type CorrectionProps = React.ComponentProps<typeof GeniusQuestionCorrectionPicker>;

  /** 카드를 렌더하고 두 버튼과 수집된 응답을 돌려준다. */
  function renderCorrectionCard(disabled: boolean) {
    const host = dom.window.document.createElement("div");
    dom.window.document.body.appendChild(host);
    const root = createRoot(host);
    const responses: (string | null)[] = [];
    const props: CorrectionProps = {
      options: ["보크가 뭐야?"],
      onRespond: (q) => { responses.push(q); },
      disabled,
    };
    void act(() => { root.render(React.createElement(GeniusQuestionCorrectionPicker, props)); });
    const q = (id: string) => {
      const el = host.querySelector(`[data-testid='${id}']`) as HTMLButtonElement | null;
      // 버튼이 없으면 이후 단계는 null 에 대고 TypeError 로 죽는다 — 그러면 "게이트 고장"과
      // "산출물 결함"을 구분할 수 없다. 부재 자체를 **assertion 으로** 즉시 죽인다.
      assert.ok(el, `교정 카드에 [${id}] 버튼이 없다`);
      return el;
    };
    return {
      responses,
      accept: q("genius-question-correction-option"),
      decline: q("genius-question-correction-decline"),
      click: (btn: HTMLButtonElement) => {
        void act(() => { btn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
      },
      cleanup: () => { void act(() => root.unmount()); host.remove(); },
    };
  }

  // ⑥-a 활성 카드: 두 버튼이 실제로 그려지고 각각 제 값을 올린다.
  {
    const card = renderCorrectionCard(false);
    check("활성 교정 카드는 선택·거절 두 버튼을 모두 그린다", () => {
      assert.equal(card.accept.disabled, false);
      assert.equal(card.decline.disabled, false);
    });
    card.click(card.accept);
    check("선택 클릭은 서버 발급 exact 후보를 그대로 올린다", () => {
      assert.deepEqual(card.responses, ["보크가 뭐야?"]);
    });
    card.cleanup();
  }
  {
    const card = renderCorrectionCard(false);
    card.click(card.decline);
    check("거절 클릭은 null 을 올린다(원문 그대로 진행)", () => {
      assert.deepEqual(card.responses, [null]);
    });
    card.cleanup();
  }

  // ⑥-b 상호 잠금: 한쪽을 누른 뒤 다른 쪽을 눌러도 두 번째 응답은 나가지 않는다.
  //     서버는 선택+거절 동시 수신을 400 으로 막지만, 애초에 클라가 두 개를 만들면 안 된다.
  for (const first of ["accept", "decline"] as const) {
    const host = dom.window.document.createElement("div");
    dom.window.document.body.appendChild(host);
    const root = createRoot(host);
    const responses: (string | null)[] = [];
    // useDM 의 잠금과 같은 모양: 한 번 응답하면 그 messageId 는 corrected 집합에 들어가
    // 카드가 곧바로 disabled 로 재렌더된다.
    const corrected = new Set<number>();
    const draw = () => {
      const props: CorrectionProps = {
        options: ["보크가 뭐야?"],
        onRespond: (q) => {
          if (corrected.has(QUESTION_ID)) return;
          corrected.add(QUESTION_ID); responses.push(q); draw();
        },
        disabled: isGeniusPickerDisabled(QUESTION_ID, new Set<number>(), corrected),
      };
      void act(() => { root.render(React.createElement(GeniusQuestionCorrectionPicker, props)); });
    };
    draw();
    const btn = (id: string) => host.querySelector(`[data-testid='${id}']`) as HTMLButtonElement;
    const order = first === "accept"
      ? ["genius-question-correction-option", "genius-question-correction-decline"]
      : ["genius-question-correction-decline", "genius-question-correction-option"];
    void act(() => { btn(order[0]).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
    check(`${first} 먼저 누르면 나머지 버튼이 즉시 비활성`, () => {
      assert.equal(btn(order[1]).disabled, true);
      assert.equal(btn(order[0]).disabled, true);
    });
    void act(() => { btn(order[1]).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
    check(`${first} 확정 뒤 반대 버튼 클릭은 두 번째 응답을 만들지 않는다`, () => {
      assert.equal(responses.length, 1, "선택+거절 두 응답이 동시에 나가면 서버가 400 이다");
    });
    void act(() => root.unmount()); host.remove();
  }

  // ⑥-c 완료된 카드는 두 버튼 다 죽어 있고 아무 요청도 만들지 않는다.
  {
    const card = renderCorrectionCard(isGeniusPickerDisabled(QUESTION_ID, new Set([QUESTION_ID]), new Set()));
    check("완료된 교정 카드는 선택·거절 둘 다 disabled", () => {
      assert.equal(card.accept.disabled, true);
      assert.equal(card.decline.disabled, true);
    });
    card.click(card.accept); card.click(card.decline);
    check("disabled 교정 카드는 재요청하지 않는다", () => assert.equal(card.responses.length, 0));
    card.cleanup();
  }

  // ── ⑦ outbox → API body 종단: 클릭이 만든 응답이 실제 전송 payload 가 되는지 ──
  //
  // 컴포넌트가 값을 올려도 outbox 가 그 값을 body 에 안 실으면 서버는 아무것도 못 받는다.
  // 그 구간이 이 PR 의 핵심 배선이므로 실제 outbox 헬퍼와 fetch 로 태운다.
  {
    const {
      applyBaseballQaQuestionCorrection, declineBaseballQaQuestionCorrection, readBaseballQaOutbox,
    } = await import("../../src/lib/baseball-qa/client-outbox");

    const makeStorage = () => {
      const map = new Map<string, string>();
      return {
        getItem: (k: string) => map.get(k) ?? null,
        setItem: (k: string, v: string) => { map.set(k, v); },
        removeItem: (k: string) => { map.delete(k); },
      };
    };

    {
      const storage = makeStorage();
      const card = renderCorrectionCard(false);
      card.click(card.accept);
      applyBaseballQaQuestionCorrection(storage, "conv-1", QUESTION_ID, card.responses[0] as string);
      const row = readBaseballQaOutbox(storage).find((r) => r.messageId === QUESTION_ID)!;
      check("선택 클릭 값이 outbox 에 그대로 적재된다", () => {
        assert.equal(row.pickedNormalizedQuestion, "보크가 뭐야?");
        assert.notEqual(row.declineCorrection, true);
      });
      card.cleanup();
    }
    {
      const storage = makeStorage();
      const card = renderCorrectionCard(false);
      card.click(card.decline);
      assert.equal(card.responses[0], null);
      declineBaseballQaQuestionCorrection(storage, "conv-1", QUESTION_ID);
      const row = readBaseballQaOutbox(storage).find((r) => r.messageId === QUESTION_ID)!;
      check("거절 클릭 값이 outbox 에 거절로 적재된다", () => {
        assert.equal(row.declineCorrection, true);
        assert.equal(row.pickedNormalizedQuestion ?? null, null);
      });
      card.cleanup();
    }
    {
      // 이미 선택이 확정된 행은 거절로 덮이지 않는다 — 먼저 확정된 응답이 이긴다(서버와 같은 계약).
      const storage = makeStorage();
      applyBaseballQaQuestionCorrection(storage, "conv-1", QUESTION_ID, "보크가 뭐야?");
      const overwritten = declineBaseballQaQuestionCorrection(storage, "conv-1", QUESTION_ID);
      const row = readBaseballQaOutbox(storage).find((r) => r.messageId === QUESTION_ID)!;
      check("선택 확정 행은 거절로 덮이지 않는다", () => {
        assert.equal(overwritten, false);
        assert.equal(row.pickedNormalizedQuestion, "보크가 뭐야?");
        assert.notEqual(row.declineCorrection, true);
      });
    }

    // 실제 전송 body 확인: outbox 처리기가 만든 요청에 값이 실려 나가는가.
    for (const c of [
      { name: "선택", seed: (s: ReturnType<typeof makeStorage>) =>
        applyBaseballQaQuestionCorrection(s, "conv-1", QUESTION_ID, "보크가 뭐야?"),
        expect: (b: Record<string, unknown>) => {
          assert.equal(b.pickedNormalizedQuestion, "보크가 뭐야?");
          assert.notEqual(b.declineCorrection, true);
        } },
      { name: "거절", seed: (s: ReturnType<typeof makeStorage>) =>
        declineBaseballQaQuestionCorrection(s, "conv-1", QUESTION_ID),
        expect: (b: Record<string, unknown>) => {
          assert.equal(b.declineCorrection, true);
          assert.equal(b.pickedNormalizedQuestion ?? null, null);
        } },
    ]) {
      const storage = makeStorage();
      c.seed(storage);
      const bodies: Record<string, unknown>[] = [];
      const { attemptBaseballQaOutbox } = await import("../../src/lib/baseball-qa/client-outbox");
      // 실제 전송 함수를 그대로 태우고 fetch 만 가로챘다 — body 조립은 이 함수 안에 있다.
      await attemptBaseballQaOutbox(storage, null, (async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body ?? "{}")));
        return { ok: true, status: 200, json: async () => ({ status: "completed" }) } as Response;
      }) as unknown as typeof fetch);
      check(`${c.name} 응답이 API body 에 실려 나간다`, () => {
        assert.equal(bodies.length, 1, "요청이 정확히 1건");
        c.expect(bodies[0]);
        assert.equal(bodies[0].messageId, QUESTION_ID);
      });
    }
  }

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
