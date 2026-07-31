import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import roster from "../../src/lib/constants/players-roster.json";
import {
  buildSourceInventory,
  inventoryCoverage,
  type RagSourceInventory,
  type RosterSourcePlayer,
} from "../../src/lib/baseball-qa/source-inventory";

const outputPath = resolve(
  process.cwd(),
  process.argv[2] ?? "data/baseball-qa/source-inventory.json",
);
const previous = existsSync(outputPath)
  ? JSON.parse(readFileSync(outputPath, "utf8")) as RagSourceInventory
  : undefined;
const inventory = buildSourceInventory(roster as RosterSourcePlayer[], previous);

mkdirSync(dirname(outputPath), { recursive: true });
const serialized = [
  "{",
  `  \"schemaVersion\": ${inventory.schemaVersion},`,
  `  \"inventoryVersion\": ${JSON.stringify(inventory.inventoryVersion)},`,
  "  \"sources\": [",
  inventory.sources.map((source) => `    ${JSON.stringify(source)}`).join(",\n"),
  "  ]",
  "}",
  "",
].join("\n");
writeFileSync(outputPath, serialized);

console.log(JSON.stringify({
  outputPath,
  inventoryVersion: inventory.inventoryVersion,
  sourceCount: inventory.sources.length,
  playerCoverage: inventoryCoverage(inventory),
}, null, 2));
