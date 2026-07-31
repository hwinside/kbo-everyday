#!/usr/bin/env node
/**
 * UI 스모크: 팀 기록 응답계약 fail-close (PR #1000 삼순 게이트)
 *
 * 용도:
 *   - malformed 200(LG 누락 + fake slug 10개 / 비수치 rate)이 화면에서
 *     "빈 표"가 아니라 inline 실패 문구로 떨어지는지 실브라우저로 고정
 *   - 정상 200(Naver 값)은 그대로 렌더되는지 확인
 *   - runtime TypeError / client-error telemetry 0 확인
 *
 * 사용법:
 *     node scripts/qa/ui-smoke-team-records-contract.mjs
 *     node scripts/qa/ui-smoke-team-records-contract.mjs --headed
 *     node scripts/qa/ui-smoke-team-records-contract.mjs --base-url=http://localhost:3003
 */
import playwright from "playwright";

const { chromium } = playwright;
const HEADED = process.argv.includes("--headed");
const BASE_URL =
  process.argv.find((a) => a.startsWith("--base-url="))?.split("=")[1] ||
  "http://localhost:3003";

const SLUGS = [
  "lg",
  "doosan",
  "kt",
  "ssg",
  "nc",
  "kia",
  "lotte",
  "samsung",
  "hanwha",
  "kiwoom",
];

const validPayload = {
  season: 2026,
  batting: SLUGS.map((slug, i) => ({
    teamId: i + 1,
    slug,
    avg: ".280",
    ops: "0.810",
    hr: 100 + i,
    runs: 500 + i,
    sb: 50 + i,
  })),
  pitching: SLUGS.map((slug, i) => ({
    teamId: i + 1,
    slug,
    era: "3.80",
    whip: "1.35",
    so: 900 + i,
    sv: 30 + i,
    hra: 90 + i,
  })),
};

// LG 누락 + fake slug 10개로 길이/unique만 만족시키는 malformed 200
const fakeSlugPayload = {
  season: 2026,
  batting: SLUGS.map((_, i) => ({
    teamId: i + 1,
    slug: `fake${i}`,
    avg: ".280",
    ops: "0.810",
    hr: 100 + i,
    runs: 500 + i,
    sb: 50 + i,
  })),
  pitching: SLUGS.map((_, i) => ({
    teamId: i + 1,
    slug: `fake${i}`,
    era: "3.80",
    whip: "1.35",
    so: 900 + i,
    sv: 30 + i,
    hra: 90 + i,
  })),
};

// 비수치 rate 문자열
const badRatePayload = JSON.parse(JSON.stringify(validPayload));
badRatePayload.batting[0].ops = "N/A";
badRatePayload.pitching[0].era = "-";

const FAIL_TEXT = "기록 데이터를 불러올 수 없습니다";

let failures = 0;
function check(label, ok, detail = "") {
  if (ok) {
    console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures += 1;
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function runCase(browser, { name, payload, expectFailClose }) {
  console.log(`\n[case] ${name}`);
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();

  const runtimeErrors = [];
  const telemetry = [];
  page.on("pageerror", (err) => runtimeErrors.push(String(err)));
  page.on("console", (msg) => {
    if (msg.type() === "error") runtimeErrors.push(msg.text());
  });
  page.on("request", (req) => {
    if (/client-error|telemetry/.test(req.url())) telemetry.push(req.url());
  });

  await page.route("**/api/team-records**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(payload),
    });
  });

  await page.goto(`${BASE_URL}/teams/lg/records`, {
    waitUntil: "networkidle",
  });
  await page.waitForTimeout(1200);

  const bodyText = await page.locator("body").innerText();
  const hasFailText = bodyText.includes(FAIL_TEXT);

  if (expectFailClose) {
    check(`inline 실패 문구 노출`, hasFailText);
    check(
      `빈 표(값 없는 타격/투구) 미노출`,
      !/0\.810|3\.80/.test(bodyText),
      "정상 수치가 렌더되지 않아야 함",
    );
  } else {
    check(`실패 문구 미노출`, !hasFailText);
    check(
      `Naver 값 렌더`,
      /0\.810/.test(bodyText) && /3\.80/.test(bodyText),
      "OPS 0.810 / ERA 3.80",
    );
  }

  check(`runtime error 0`, runtimeErrors.length === 0, `count=${runtimeErrors.length}`);
  if (runtimeErrors.length) console.log("     ", runtimeErrors.slice(0, 3));
  check(`client-error telemetry 0`, telemetry.length === 0, `count=${telemetry.length}`);

  await context.close();
}

async function main() {
  const browser = await chromium.launch({ headless: !HEADED });
  try {
    await runCase(browser, {
      name: "malformed 200 — LG 누락 + fake slug 10개",
      payload: fakeSlugPayload,
      expectFailClose: true,
    });
    await runCase(browser, {
      name: "malformed 200 — 비수치 rate(ops=N/A, era=-)",
      payload: badRatePayload,
      expectFailClose: true,
    });
    await runCase(browser, {
      name: "정상 200 — Naver 값 렌더",
      payload: validPayload,
      expectFailClose: false,
    });
  } finally {
    await browser.close();
  }

  console.log(
    `\nteam-records contract UI smoke: ${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
