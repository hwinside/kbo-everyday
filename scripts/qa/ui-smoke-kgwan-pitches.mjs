#!/usr/bin/env node
import playwright from "playwright";

const { chromium } = playwright;
const BASE_URL =
  process.argv.find((arg) => arg.startsWith("--base-url="))?.split("=")[1]
  ?? "http://localhost:3000";
const WIDTHS = [320, 390];

let pass = 0;
let fail = 0;
function check(name, condition, detail = "") {
  if (condition) pass++;
  else {
    fail++;
    console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const browser = await chromium.launch();
try {
  for (const width of WIDTHS) {
    const page = await browser.newPage({ viewport: { width, height: 800 }, deviceScaleFactor: 2 });
    await page.goto(`${BASE_URL}/qa/relay-font`, { waitUntil: "networkidle" });
    const tag = `${width}px`;

    const current = page.locator('[data-qa="current-at-bat"]');
    check(`${tag} 현재 타석 자동 펼침`, await current.count() === 1);
    check(`${tag} 현재 타자 타순 표시`, await current.locator('[data-qa="current-bat-order"]').innerText() === "4번");
    const currentVisible = async () => current.evaluate((element) => {
      const root = element.closest('[data-qa="relay-root"]');
      const cardRect = element.getBoundingClientRect();
      const rootRect = root.getBoundingClientRect();
      return cardRect.top >= rootRect.top && cardRect.bottom <= rootRect.bottom;
    });
    const latestVisible = async () => current.locator('[data-qa="live-pitch-latest"]').evaluate((element) => {
      const root = element.closest('[data-qa="relay-root"]');
      const rowRect = element.getBoundingClientRect();
      const rootRect = root.getBoundingClientRect();
      return rowRect.top >= rootRect.top && rowRect.bottom <= rootRect.bottom;
    });
    check(`${tag} 초기 현재 타석 viewport 노출`, await currentVisible());
    check(`${tag} 현재 투구 4줄`, await current.locator('[data-qa^="live-pitch-"]').count() === 4);
    check(`${tag} 최신 공 accent 1개`, await current.locator('[data-qa="live-pitch-latest"]').count() === 1);

    // 볼카운트 도트 배지 (전광판식) — fixture balls=2/strikes=2/outs=1 → B●●○ / S●● / O●○
    check(`${tag} 카운트 배지 존재`, await current.locator('[data-qa="count-badge"]').count() === 1);
    check(`${tag} B 도트 3칸`, await current.locator('[data-qa="count-b"] [data-filled]').count() === 3);
    check(`${tag} B 채움 2`, await current.locator('[data-qa="count-b"] [data-filled="true"]').count() === 2);
    check(`${tag} S 도트 2칸`, await current.locator('[data-qa="count-s"] [data-filled]').count() === 2);
    check(`${tag} S 채움 2`, await current.locator('[data-qa="count-s"] [data-filled="true"]').count() === 2);
    check(`${tag} O 도트 2칸`, await current.locator('[data-qa="count-o"] [data-filled]').count() === 2);
    check(`${tag} O 채움 1`, await current.locator('[data-qa="count-o"] [data-filled="true"]').count() === 1);
    check(
      `${tag} B/S/O 순서`,
      await current.locator('[data-qa="count-badge"] > span').evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("data-qa")).join(",") === "count-b,count-s,count-o"),
    );

    const completed = page.locator('[data-qa="completed-at-bat"]').first();
    check(`${tag} 지난 타석 타순 표시`, await completed.locator('[data-qa="completed-bat-order"]').innerText() === "1번");
    check(`${tag} 이전 타석 기본 접힘`, await completed.locator('[data-qa^="live-pitch-"]').count() === 0);
    await completed.locator("button").click();
    check(`${tag} 이전 타석 탭 펼침`, await completed.locator('[data-qa^="live-pitch-"]').count() === 3);

    await page.locator('[data-qa="relay-root"]').evaluate((root) => {
      root.scrollTop = root.scrollHeight;
    });
    check(`${tag} 완료 타석 탐색 중 현재 카드 이탈`, !(await currentVisible()));
    for (let pitch = 5; pitch <= 7; pitch++) {
      await page.locator('[data-qa="add-live-pitch"]').evaluate((button) => button.click());
    }
    await page.waitForFunction(() => {
      const root = document.querySelector('[data-qa="relay-root"]');
      const latest = document.querySelector('[data-qa="live-pitch-latest"]');
      if (!root || !latest) return false;
      const rootRect = root.getBoundingClientRect();
      const rowRect = latest.getBoundingClientRect();
      return rowRect.top >= rootRect.top && rowRect.bottom <= rootRect.bottom;
    });
    check(`${tag} 7구 갱신 후 최신 공 자동 노출`, await latestVisible());

    const updatedText = await current.locator('[data-qa="relay-updated-at"]').innerText();
    check(`${tag} 실제 갱신 age 표시`, /^(방금|\d+초 전|\d+분 전) 갱신$/.test(updatedText), updatedText);

    const layout = await page.evaluate(() => {
      const root = document.querySelector('[data-qa="relay-root"]');
      const chat = document.querySelector('[data-qa="chat-space"]');
      return {
        overflow: root.scrollWidth > root.clientWidth,
        relayHeight: root.getBoundingClientRect().height,
        chatTop: chat.getBoundingClientRect().top,
      };
    });
    check(`${tag} 가로 overflow 없음`, !layout.overflow, JSON.stringify(layout));
    check(`${tag} relay 40vh 상한`, layout.relayHeight <= 321, JSON.stringify(layout));
    check(`${tag} 채팅 영역 보존`, layout.chatTop < 800, JSON.stringify(layout));
    await page.close();
  }
} finally {
  await browser.close();
}

console.log(`kgwan-pitches UI: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
