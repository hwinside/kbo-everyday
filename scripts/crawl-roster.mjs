import { chromium } from 'playwright';
import fs from 'fs';

const allPlayers = {};
const TEAMS = [
  ["HT", "KIA", 6], ["OB", "두산", 2], ["LT", "롯데", 7],
  ["SS", "삼성", 8], ["SK", "SSG", 4], ["NC", "NC", 5],
  ["HH", "한화", 9], ["WO", "키움", 10], ["LG", "LG", 1], ["KT", "KT", 3],
];

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

// API 응답 캡처
page.on('response', async (response) => {
  if (response.url().includes('GetSearchPlayer')) {
    try {
      const json = await response.json();
      const data = json.d ? JSON.parse(json.d) : json;
      if (Array.isArray(data)) {
        data.forEach(p => {
          const pid = String(p.P_ID || '');
          if (pid && !allPlayers[pid]) {
            allPlayers[pid] = {
              name: p.P_NM || '',
              kboId: pid,
              backNo: p.BACK_NO || '',
              position: p.POS_NO || '',
              teamCode: p.T_ID || '',
              team: p.T_NM || '',
            };
          }
        });
      }
    } catch (e) {
      console.error('Parse error:', e.message);
    }
  }
});

console.log('Opening KBO search page...');
await page.goto('https://www.koreabaseball.com/Record/Player/Search.aspx', { waitUntil: 'networkidle' });

// 각 팀별 크롤링
for (const [teamCode, teamName, teamId] of TEAMS) {
  console.log(`Searching ${teamName}...`);
  
  await page.selectOption('select#ddlTeam', teamCode);
  await page.waitForTimeout(500);
  await page.click('input[type="submit"]');
  await page.waitForTimeout(3000);
  
  // teamId 매핑
  Object.values(allPlayers).forEach(p => {
    if (p.teamCode === teamCode && !p.teamId) {
      p.teamId = teamId;
    }
  });
  
  console.log(`  ${teamName}: ${Object.values(allPlayers).filter(p => p.teamId === teamId).length}명`);
}

await browser.close();

const roster = Object.values(allPlayers).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
console.log(`\nTotal: ${roster.length} players`);

fs.writeFileSync('src/lib/constants/players-roster.json', JSON.stringify(roster, null, 2));
console.log('Saved to src/lib/constants/players-roster.json');
