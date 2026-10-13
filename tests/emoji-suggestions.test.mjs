import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

test("emoji shortcuts preserve the draft, selection, focus and send guards", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "http://localhost", pretendToBeVisual: true });
  for (const key of ["window", "document", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Event", "MouseEvent"]) {
    globalThis[key] = dom.window[key];
  }
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { createElement: h, useRef, useState, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { default: EmojiSuggestions } = await import("../src/components/community/EmojiSuggestions.tsx");
  const root = createRoot(document.getElementById("root"));
  let sends = 0;
  function Composer({ initial = "", disabled = false, textarea = false, maxLength }) {
    const [value, setValue] = useState(initial);
    const inputRef = useRef(null);
    return h("form", { onSubmit: (event) => { event.preventDefault(); sends++; } },
      h(textarea ? "textarea" : "input", { ref: inputRef, value, maxLength, onChange: (event) => setValue(event.target.value) }),
      h(EmojiSuggestions, { inputRef, onChange: setValue, disabled, maxLength }));
  }
  async function mount(props) {
    await act(async () => root.render(h(Composer, { ...props, key: JSON.stringify(props) })));
    const input = document.querySelector("input, textarea");
    input.focus();
    return input;
  }
  async function pick(label) {
    const button = document.querySelector(`[aria-label='${label} 이모지 추가']`);
    await act(async () => {
      button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      button.click();
    });
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  try {
    const input = await mount({ initial: "오늘 승리" });
    input.setSelectionRange(3, 3);
    await pick("불꽃");
    assert.equal(input.value, "오늘 🔥승리");
    assert.equal(input.selectionStart, 5);
    assert.equal(document.activeElement, input);
    input.setSelectionRange(3, 5);
    await pick("박수");
    assert.equal(input.value, "오늘 👏승리");

    const chat = await mount({ initial: "가".repeat(119), textarea: true, maxLength: 120 });
    chat.setSelectionRange(119, 119);
    await pick("불꽃");
    assert.equal(chat.value, "가".repeat(119), "reject a whole two-unit emoji at the limit");
    chat.setSelectionRange(118, 119);
    await pick("불꽃");
    assert.equal(chat.value, "가".repeat(118) + "🔥", "selection replacement can fit at 120");
    assert.equal(chat.selectionStart, 120);

    const blocked = await mount({ initial: "대기", disabled: true });
    await pick("최고");
    assert.equal(blocked.value, "대기");
    const blank = await mount({ initial: "" });
    await pick("야구");
    assert.equal(blank.value, "⚾");
    assert.equal(sends, 0, "shortcuts must never submit the form");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
