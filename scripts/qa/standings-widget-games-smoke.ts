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

console.log("PASS standings widgets games column (iOS + Android)");
