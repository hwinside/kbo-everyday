#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { fileURLToPath } from "node:url";
import { preserveExistingRosterPlayers } from "../lib/roster-preservation.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
let pass = 0;
const check = (name, fn) => {
  fn();
  console.log(`✓ ${name}`);
  pass++;
};

function assertActualCrawlerWiring(source) {
  const ast = ts.createSourceFile("crawl-roster-v2.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let helperLocal = null;
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement) || statement.moduleSpecifier.text !== "./lib/roster-preservation.mjs") continue;
    const imports = statement.importClause?.namedBindings;
    if (!imports || !ts.isNamedImports(imports)) continue;
    const helper = imports.elements.find((element) => (element.propertyName ?? element.name).text === "preserveExistingRosterPlayers");
    helperLocal = helper?.name.text ?? null;
  }
  assert.ok(helperLocal, "actual crawler가 roster preservation helper를 import해야 한다");

  let exactCalls = 0;
  const visit = (node) => {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === helperLocal
      && ["allPlayers", "existingMap", "canonicalKboId"].every(
        (name, index) => ts.isIdentifier(node.arguments[index]) && node.arguments[index].text === name,
      )
    ) exactCalls++;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.equal(exactCalls, 1, "actual crawler가 helper(allPlayers, existingMap, canonicalKboId)를 정확히 1회 호출해야 한다");
}

check("군입대 선수는 기록 수집에 없어도 기존 SSG roster에서 보존", () => {
  const armyPlayer = {
    name: "이율예",
    kboId: "55832",
    teamId: 4,
    position: "포수",
    backNo: "22",
    team: "SSG",
    birthDate: "2006-11-21",
    military: "상무",
    militaryAsOf: "2026-08-23",
    militarySource: "kbo-player-search",
  };
  const collected = new Map();
  const existing = new Map([[armyPlayer.kboId, armyPlayer]]);
  assert.equal(preserveExistingRosterPlayers(collected, existing, (id) => id), 1);
  assert.deepEqual(collected.get("55832"), armyPlayer);
});

check("이율예 roster·사진 매핑·JPEG가 함께 선적됨", () => {
  const roster = JSON.parse(fs.readFileSync(path.join(ROOT, "src/lib/constants/players-roster.json"), "utf8"));
  assert.deepEqual(roster.filter((player) => player.kboId === "55832"), [{
    name: "이율예",
    kboId: "55832",
    teamId: 4,
    position: "포수",
    backNo: "22",
    team: "SSG",
    birthDate: "2006-11-21",
    // 군 복무 표기 — team은 원소속(SSG) 유지, 프로필에 상무 별도 명시 (2026-08-23 하린아빠 지시)
    // 상태·기준일·출처 별도 필드 관리 — 전역/복귀 시 자동 종료용 (삼순 정책)
    military: "상무",
    militaryAsOf: "2026-08-23",
    militarySource: "kbo-player-search",
  }]);
  const photoIndex = fs.readFileSync(path.join(ROOT, "src/lib/constants/player-photos.ts"), "utf8");
  assert.match(photoIndex, /"이율예": "55832"/);
  assert.match(photoIndex, /"55832"/);
  const photo = fs.readFileSync(path.join(ROOT, "public/players/55832.jpg"));
  assert.ok(photo.length > 500);
  assert.deepEqual([...photo.subarray(0, 2)], [0xff, 0xd8], "JPEG SOI signature");
});

check("같은 ID가 이번 수집에 있으면 최신 수집값을 기존값으로 덮지 않음", () => {
  const fresh = { name: "이율예", kboId: "55832", teamId: 4, team: "SSG", backNo: "44" };
  const stale = { ...fresh, backNo: "22" };
  const collected = new Map([[fresh.kboId, fresh]]);
  const existing = new Map([[stale.kboId, stale]]);
  assert.equal(preserveExistingRosterPlayers(collected, existing, (id) => id), 0);
  assert.equal(collected.get("55832"), fresh);
});

check("외국인 숫자 alias는 canonical ID로 보존하고 중복 행을 만들지 않음", () => {
  const existing = new Map([["56146", { name: "히우라", kboId: "56146", teamId: 6 }]]);
  const collected = new Map([["FP021", { name: "히우라", kboId: "FP021", teamId: 6 }]]);
  const canonical = (id) => id === "56146" ? "FP021" : id;
  assert.equal(preserveExistingRosterPlayers(collected, existing, canonical), 0);
  assert.equal(collected.size, 1);
});

check("actual crawl-roster-v2가 보존 helper를 import하고 exact 인자로 호출", () => {
  const crawler = fs.readFileSync(path.join(ROOT, "scripts/crawl-roster-v2.mjs"), "utf8");
  assertActualCrawlerWiring(crawler);
});

check("actual crawler import·호출 제거 mutation은 RED", () => {
  const crawler = fs.readFileSync(path.join(ROOT, "scripts/crawl-roster-v2.mjs"), "utf8");
  const mutated = crawler
    .replace(/import \{ preserveExistingRosterPlayers \} from "\.\/lib\/roster-preservation\.mjs";\n/, "")
    .replace(
      "const preserved = preserveExistingRosterPlayers(allPlayers, existingMap, canonicalKboId);",
      "const preserved = 0;",
    );
  assert.notEqual(mutated, crawler, "mutation fixture가 실제 source를 바꿔야 한다");
  assert.throws(() => assertActualCrawlerWiring(mutated));
});

console.log(`\nPASS — roster preservation (${pass} pass)`);
