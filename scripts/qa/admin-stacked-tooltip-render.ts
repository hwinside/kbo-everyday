/**
 * 어드민 스택 바차트 툴팁 합계 — 실제 recharts BarChart 렌더 회귀 (삼순 #1034 NO-GO).
 *
 * 배경: 합계 노출 여부를 hover payload.length 로 판단하면, recharts 기본 filterNull 이
 * null/undefined entry 를 payload 에서 제거하기 때문에 **2-series 로 구성된 차트라도**
 * 특정 일자에 한쪽 플랫폼 row 가 없으면 payload 가 1개가 되어 합계가 사라진다
 * (downloads chartData 는 API raw row 를 그대로 pivot 하므로 결측 key 를 채우지 않음).
 *
 * 그래서 합계는 **차트 configuration(showTotal prop)** 으로만 결정한다.
 * 여기서는 진짜 recharts BarChart + 진짜 StackedTooltip 을 jsdom 에 렌더해
 * defaultIndex 로 특정 데이터포인트를 활성화하고 실제 DOM 텍스트를 검사한다.
 *   - showTotal 을 payload.length > 1 로 되돌리면 sparse 케이스가 RED
 *   - showTotal=false 인 단일 series 에서 합계가 나오면 RED
 * 실행: npm run qa:admin-stacked-tooltip
 */
import { JSDOM } from "jsdom";

const dom = new JSDOM(`<!DOCTYPE html><body></body>`, { pretendToBeVisual: true, url: "http://localhost/" });
const win = dom.window as unknown as Record<string, unknown>;
const g = globalThis as unknown as Record<string, unknown>;
for (const k of [
  "window", "document", "HTMLElement", "Element", "Node", "Event", "MouseEvent",
  "SVGElement", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame",
]) {
  g[k] = win[k];
}
(g as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// recharts 3.x 는 렌더 애니메이션 중 act 밖 setState 경고를 쏟는다. 결과 판정과 무관하므로 억제.
const origError = console.error;
console.error = (...args: unknown[]) => {
  const first = typeof args[0] === "string" ? args[0] : "";
  if (first.includes("not wrapped in act")) return;
  origError(...args);
};

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}

type Series = { key: string; name: string; color: string };

async function main() {
  const React = (await import("react")).default;
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { BarChart, Bar, XAxis, YAxis, Tooltip } = await import("recharts");
  const StackedTooltip = (await import("../../src/components/admin/StackedTooltip")).default;

  /** 실제 BarChart 를 렌더하고 index 번째 데이터포인트의 툴팁 텍스트를 돌려준다. */
  async function tooltipTextAt(
    data: Record<string, string | number>[],
    series: Series[],
    showTotal: boolean,
    index: number,
  ): Promise<string> {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => {
      root.render(
        React.createElement(
          BarChart,
          { width: 400, height: 300, data },
          React.createElement(XAxis, { dataKey: "label" }),
          React.createElement(YAxis, null),
          React.createElement(Tooltip, {
            content: React.createElement(StackedTooltip, { showTotal }),
            defaultIndex: index,
            active: true,
          }),
          ...series.map((s) =>
            React.createElement(Bar, { key: s.key, dataKey: s.key, name: s.name, stackId: "s", fill: s.color }),
          ),
        ),
      );
    });
    const tip = el.querySelector(".recharts-tooltip-wrapper");
    const text = (tip?.textContent ?? "").replace(/\s+/g, " ").trim();
    await act(async () => { root.unmount(); });
    el.remove();
    return text;
  }

  const twoSeries: Series[] = [
    { key: "ios", name: "iOS", color: "#0A84FF" },
    { key: "android", name: "안드로이드", color: "#3DDC84" },
  ];
  // downloads 와 동일한 형태: 결측 플랫폼 key 를 채우지 않는 sparse row.
  const sparseData = [
    { label: "07-30", ios: 1200, android: 34 },
    { label: "07-31", ios: 7 },
  ];

  console.log("\n[1] 2-series 구성 + 양쪽 값 존재");
  {
    const t = await tooltipTextAt(sparseData, twoSeries, true, 0);
    ok("개별값 2개 노출", t.includes("iOS : 1,200") && t.includes("안드로이드 : 34"), t);
    ok("합계 ko-KR 로케일 합산 1,234", t.includes("합계 : 1,234"), t);
  }

  console.log("\n[2] 2-series 구성 + sparse hover(한쪽 결측) ← 삼순 blocker 재현 지점");
  {
    const t = await tooltipTextAt(sparseData, twoSeries, true, 1);
    ok("payload 가 1개로 줄어듦(filterNull)", !t.includes("안드로이드"), t);
    ok("그래도 합계 줄 유지", t.includes("합계 : 7"), t);
  }

  console.log("\n[3] 진짜 단일 series 구성(showTotal=false)");
  {
    const single: Series[] = [{ key: "posts", name: "게시글", color: "#6366F1" }];
    const t = await tooltipTextAt([{ label: "07-31", posts: 42 }], single, false, 0);
    ok("개별값 노출", t.includes("게시글 : 42"), t);
    ok("합계 줄 숨김(값 중복 방지)", !t.includes("합계"), t);
  }

  console.log("\n[4] 합계는 configuration 으로만 결정 — 단일 series 여도 showTotal=true 면 표시");
  {
    const single: Series[] = [{ key: "ios", name: "iOS", color: "#0A84FF" }];
    const t = await tooltipTextAt([{ label: "07-31", ios: 7 }], single, true, 0);
    ok("showTotal=true 면 payload 1개여도 합계", t.includes("합계 : 7"), t);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { origError(e); process.exit(1); });
