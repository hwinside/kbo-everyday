#!/usr/bin/env node
/**
 * featured(MY TEAM) 카드 전경 대비 게이트.
 *
 * 왜 필요한가 (삼순 2026-08-15 P1): featured 카드는 배경이 팀색 고정인데 전경을 흰색으로
 * 고정했다. 팀색이 밝으면(한화 #FF6600) 흰 글자 대비가 2.94:1 로 AA large 조차 미달한다.
 * 그래서 배경 팀색을 darkenForFeatured() 로 어둡게 섞는데, 그 비율이 **모든 구단에서**
 * 안전한지는 눈으로 볼 수 없다 → 전 구단 실제 색으로 대비를 계산해 판정한다.
 *
 * 검증 대상은 production 이 실제로 쓰는 함수/상수 그대로다(재구현 금지):
 *   - darkenForFeatured / FEATURED_DARKEN_MIX  ← CompactGameCard
 *   - TEAMS[].colorPrimary                     ← constants/teams
 *
 * 판정: gradient 시작색(가장 밝은 지점) ↔ 흰 전경이 WCAG AA(4.5:1) 이상.
 * --selftest: darken 을 무력화(mix=0)했을 때 실제로 RED 가 나는지 검증력 자체를 증명한다.
 */
import { pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");

/** WCAG 상대 휘도 */
function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (shift) => {
    const c = ((n >> shift) & 255) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(16) + 0.7152 * ch(8) + 0.0722 * ch(0);
}

/** WCAG 대비비 */
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const AA = 4.5;
const FOREGROUND = "#FFFFFF"; // FEATURED_SURFACE 가 --text-primary 로 고정하는 값

async function loadProduction() {
  // tsx 로 실행되므로 TS 소스를 그대로 import 한다 — 규칙을 재구현하지 않고 배포 함수를 태운다.
  const cardUrl = pathToFileURL(path.join(ROOT, "src/components/game/CompactGameCard.tsx")).href;
  const teamsUrl = pathToFileURL(path.join(ROOT, "src/lib/constants/teams.ts")).href;
  const [card, teams] = await Promise.all([import(cardUrl), import(teamsUrl)]);
  if (typeof card.darkenForFeatured !== "function") {
    throw new Error("darkenForFeatured export 를 찾을 수 없다 — 게이트가 production 함수를 못 태운다");
  }
  if (typeof card.FEATURED_DARKEN_MIX !== "number") {
    throw new Error("FEATURED_DARKEN_MIX export 를 찾을 수 없다");
  }
  if (!Array.isArray(teams.TEAMS) || teams.TEAMS.length === 0) {
    throw new Error("TEAMS 를 찾을 수 없다");
  }
  return { darken: card.darkenForFeatured, mix: card.FEATURED_DARKEN_MIX, TEAMS: teams.TEAMS };
}

async function run({ selftest }) {
  const { darken, mix, TEAMS } = await loadProduction();
  // selftest 는 darken 을 무력화(mix=0)해 "게이트가 실제로 RED 를 낼 수 있는가"를 증명한다.
  const usedMix = selftest ? 0 : mix;

  const rows = TEAMS.map((t) => {
    const bg = darken(t.colorPrimary, usedMix);
    return { team: t.shortName, raw: t.colorPrimary, bg, ratio: contrast(bg, FOREGROUND) };
  });

  const failed = rows.filter((r) => r.ratio < AA);
  const worst = rows.reduce((a, b) => (a.ratio < b.ratio ? a : b));

  for (const r of rows) {
    const mark = r.ratio >= AA ? "PASS" : "FAIL";
    console.log(`  ${mark}  ${r.team.padEnd(4)} ${r.raw} -> ${r.bg}  ${r.ratio.toFixed(2)}:1`);
  }
  console.log(`  mix=${usedMix} · worst=${worst.team} ${worst.ratio.toFixed(2)}:1 · AA(${AA}:1) ${rows.length - failed.length}/${rows.length}`);

  if (selftest) {
    if (failed.length === 0) {
      console.error("\n✗ SELFTEST FAILED — darken 을 무력화했는데도 전부 통과했다. 게이트에 검출력이 없다.");
      process.exit(1);
    }
    console.log(`\n✓ SELFTEST PASS — darken 제거 시 ${failed.length}건 RED (검출력 확인: ${failed.map((f) => f.team).join(", ")})`);
    return;
  }

  if (failed.length > 0) {
    console.error(`\n✗ FAIL — ${failed.length}개 구단이 AA 미달: ${failed.map((f) => `${f.team} ${f.ratio.toFixed(2)}:1`).join(", ")}`);
    process.exit(1);
  }
  console.log(`\n✓ PASS — ${rows.length}개 구단 전부 AA(${AA}:1) 이상`);
}

run({ selftest: process.argv.includes("--selftest") }).catch((e) => {
  console.error("✗ ERROR:", e.message);
  process.exit(1);
});
