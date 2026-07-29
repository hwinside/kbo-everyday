import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ios = readFileSync(
  resolve("ios/App/LiveActivity/KBOTeamRankWidget.swift"),
  "utf8",
);
const android = readFileSync(
  resolve("android/app/src/main/java/fan/keubo/app/TeamRankWidget.java"),
  "utf8",
);

assert.match(ios, /headerCell\("경기", wGames\)/, "iOS 위젯 경기 헤더");
assert.match(
  ios,
  /row\.wins \+ row\.losses \+ row\.draws/,
  "iOS 위젯 경기수 = 승+패+무",
);
assert.match(android, /drawMixed\(cv, "경기", xGamesR/, "Android 위젯 경기 헤더");
assert.match(
  android,
  /wins \+ losses \+ draws/,
  "Android 위젯 경기수 = 승+패+무",
);

// iOS systemLarge 최소 실폭(329pt, contentMarginsDisabled + 좌우 12pt)에서
// 실제 10개 구단 중 폭이 가장 긴 SSG+24pt 로고와 극단 수치가 고정 열 안에 들어간다.
const iosContentWidth = 329 - 24;
const iosFixedWidths = [20, 32, 24, 24, 20, 40, 30, 36];
const iosTeamWidth = iosContentWidth - iosFixedWidths.reduce((a, b) => a + b, 0);
assert.equal(iosTeamWidth, 79, "iOS systemLarge 최소폭 팀 열");

// Montserrat/Noto/System 13pt 실측 상한(pt). 값은 실제 폰트보다 0.5pt 올림.
const iosFixtureWidths = {
  teamSSG: 28.2,
  games144: 24.5,
  pct1000: 36.7,
  gb245: 29.5,
  streak123Loss: 35.5,
};
assert.ok(6 + 24 + 5 + iosFixtureWidths.teamSSG <= iosTeamWidth, "iOS SSG+로고 무말줄임");
assert.ok(iosFixtureWidths.games144 <= 32, "iOS 3자리 경기수 무말줄임");
assert.ok(iosFixtureWidths.pct1000 <= 40, "iOS 승률 1.000 무말줄임");
assert.ok(iosFixtureWidths.gb245 <= 30, "iOS 게임차 24.5 무말줄임");
assert.ok(iosFixtureWidths.streak123Loss * 0.65 <= 36, "iOS 3자리 연속 최소축소 내 무말줄임");
assert.match(ios, /mixedScriptText\(row\.name, 13, \.heavy\)[\s\S]*?minimumScaleFactor\(0\.65\)/);
assert.match(ios, /mixedScriptText\(s, 13, \.semibold\)[\s\S]*?minimumScaleFactor\(0\.65\)/);

// Android production 렌더가 drawMixed와 동일한 Paint 측정값으로 모든 가변 문자열을
// 열 예산에 맞춘다. 250/320/340/500dp 좌표도 오른쪽부터 단조 증가해야 한다.
assert.match(android, /float gamesLeft = xGamesR - mixedWidth\(games, fs, mont, noto, false\)/);
assert.match(android, /drawMixedFitted\(cv, s\.optString\("teamName", ""\)/);
for (const value of ["games", "win", "loss", "draw", "pct", "gb"]) {
  assert.match(android, new RegExp(`drawMixedFitted\\(cv, ${value},`), `Android ${value} 실폭 fit`);
}
assert.match(android, /drawMixedFitted\(cv, streak\.isEmpty\(\) \? "-" : streak/);

for (const width of [250, 320, 340, 500]) {
  const k = Math.min(1, width / 340);
  const u = k;
  const pad = 12 * u;
  const streak = width - pad;
  const gb = streak - 40 * u;
  const pct = gb - 36 * u;
  const draw = pct - 46 * u;
  const loss = draw - 26 * u;
  const win = loss - 30 * u;
  const games = win - 30 * u;
  assert.ok(games < win && win < loss && loss < draw && draw < pct && pct < gb && gb < streak);
  assert.ok(games > (12 + 22 + 6) * u, `Android ${width}dp 팀/경기 열 양의 예산`);
}

console.log("PASS standings widgets 9-column layout (iOS systemLarge + Android 250-500dp)");
