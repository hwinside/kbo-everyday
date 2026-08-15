/**
 * 뉴스 조회수 서명 배선 mutation RED 증명 (삼순 2차 리뷰 blocker — 2026-08-14).
 *
 * 서명 배선을 한 곳씩 벗긴 사본을 실제 wiring 스모크(같은 판정 경로)에 태워
 * 게이트가 RED 가 되는지 확인한다. GREEN 이 나오면 게이트 검증력이 없는 것이므로 실패.
 *   - cache: /api/news cache-hit 경로 unsigned (1차 결손 재현)
 *   - cold:  /api/news cold 경로 unsigned
 *   - batch: /api/news/batch unsigned
 * 실행: tsx scripts/qa/content-views-news-wiring-mutations.ts
 */
import { spawnSync } from "node:child_process";
import path from "node:path";

const ROOT = path.join(__dirname, "..", "..");
const MUTATIONS = ["cache", "cold", "batch"] as const;

let failed = false;
for (const mutation of MUTATIONS) {
  const result = spawnSync(
    process.execPath,
    ["node_modules/.bin/tsx", "--test", "scripts/qa/content-views-news-wiring-smoke.ts"],
    {
      cwd: ROOT,
      env: { ...process.env, CONTENT_VIEWS_MUTATION: mutation },
      encoding: "utf8",
    },
  );
  const red = result.status !== 0;
  console.log(`${red ? "RED(기대대로 검출)" : "GREEN(검출 실패!)"} mutation=${mutation}`);
  if (!red) {
    failed = true;
    console.error(result.stdout?.slice(-2000));
    console.error(result.stderr?.slice(-2000));
  }
}

if (failed) {
  console.error("\ncontent-views wiring mutation: 게이트가 unsigned 배선을 검출하지 못함");
  process.exit(1);
}
console.log(`\ncontent-views wiring mutations: ${MUTATIONS.length}/${MUTATIONS.length} RED`);
