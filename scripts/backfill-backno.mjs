import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PATH = join(__dirname, "..", "src/lib/constants/players-roster.json");

const roster = JSON.parse(readFileSync(PATH, "utf-8"));
const needs = roster.filter((p) =>
  (!p.backNo || !String(p.backNo).trim()) && /^\d+$/.test(String(p.kboId || ""))
);
console.log(`공란 ${needs.length}명 처리 시작...`);

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
});
const page = await context.newPage();
page.setDefaultTimeout(20000);

let filled = 0, failed = 0;
const failures = [];

for (let i = 0; i < needs.length; i++) {
  const p = needs[i];
  const urls = p.position === "투수"
    ? [
        `https://www.koreabaseball.com/Record/Player/PitcherDetail/Basic.aspx?playerId=${p.kboId}`,
        `https://www.koreabaseball.com/Record/Player/HitterDetail/Basic.aspx?playerId=${p.kboId}`,
      ]
    : [
        `https://www.koreabaseball.com/Record/Player/HitterDetail/Basic.aspx?playerId=${p.kboId}`,
        `https://www.koreabaseball.com/Record/Player/PitcherDetail/Basic.aspx?playerId=${p.kboId}`,
      ];
  let backNo = "";
  for (const url of urls) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 12000 });
      backNo = await page.$eval(
        "#cphContents_cphContents_cphContents_playerProfile_lblBackNo",
        (el) => el.textContent.trim()
      ).catch(() => "");
      if (backNo) break;
    } catch { /* try next */ }
  }
  if (backNo) {
    // 원본 roster에서 같은 kboId 찾아 update
    const target = roster.find(x => x.kboId === p.kboId);
    if (target) target.backNo = backNo;
    filled++;
  } else {
    failed++;
    failures.push({kboId: p.kboId, name: p.name, team: p.team, position: p.position});
  }
  if ((i + 1) % 10 === 0 || i === needs.length - 1) {
    console.log(`  ${i+1}/${needs.length} fill=${filled} fail=${failed}`);
  }
}

await browser.close();

writeFileSync(PATH, JSON.stringify(roster, null, 2) + "\n");
console.log(`\n✅ 완료: ${filled}명 등번호 채움, ${failed}명 실패`);
if (failures.length > 0) {
  console.log("\n실패 리스트:");
  for (const f of failures) console.log(` - ${f.kboId} ${f.name} ${f.team} ${f.position}`);
}
