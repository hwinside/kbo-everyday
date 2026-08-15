#!/usr/bin/env node
/**
 * qa:games-card-render 의 검출력 증명 (삼순 2026-08-15 P1).
 *
 * 게이트가 computed 색·대비를 실제로 판정하는지, 소스에 진짜 결함을 주입해 RED 를 확인한다.
 * geometry 만 재던 시절에는 color:#fff 를 지워도 green 이었다 — 그 회귀를 영구히 막는 러너다.
 *
 * M1: FEATURED_SURFACE 의 `color: "#FFFFFF"` 제거
 *     → 라이트모드에서 featured 점수가 body 상속색(#1D1D1F)으로 떨어져 대비 붕괴 → RED 기대.
 * M2: 일반 카드 콜론을 `text-text-secondary` → `text-text-tertiary/70` 으로 복원
 *     → 라이트 1.39:1 / 다크 3.29:1 미달 → RED 기대.
 *
 * 각 mutation 은 원본을 백업하고 주입 → 게이트 실행 → 복원한다. 앵커 문자열이 소스에서
 * 사라지면(리팩터링 등) 조용히 통과하는 대신 그 자리에서 실패한다(anchor MISS = 러너 결함).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const CARD = path.join(ROOT, "src/components/game/CompactGameCard.tsx");

const MUTATIONS = [
  {
    id: "M1-featured-inherit-color",
    desc: "FEATURED_SURFACE color:#FFFFFF 제거 → 라이트모드 featured 점수 상속색 붕괴",
    anchor: 'color: "#FFFFFF",',
    replace: "",
  },
  {
    id: "M2-colon-tertiary70-revert",
    desc: "일반 카드 콜론 text-text-secondary → text-text-tertiary/70 복원",
    anchor: '"text-text-secondary"}`}>:</span>',
    replace: '"text-text-tertiary/70"}`}>:</span>',
  },
];

const runGate = () =>
  spawnSync("npx", ["tsx", "scripts/qa/featured-card-render-capture.mts"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 10 * 60 * 1000,
  });

const original = readFileSync(CARD, "utf8");
let failed = 0;

// ── 베이스라인: 무주입 상태에서 게이트가 GREEN 이어야 mutation RED 가 의미를 가진다.
{
  const r = runGate();
  if (r.status === 0) {
    console.log("  PASS  baseline: 무주입 게이트 GREEN (exit 0)");
  } else {
    failed++;
    console.error(`  FAIL  baseline: 무주입인데 게이트 RED (exit ${r.status}) — mutation 판정 불가`);
    console.error((r.stdout + r.stderr).split("\n").filter((l) => l.includes("❌")).slice(0, 5).join("\n"));
  }
}

for (const m of MUTATIONS) {
  if (!original.includes(m.anchor)) {
    failed++;
    console.error(`  FAIL  ${m.id}: 앵커 MISS — 소스에서 '${m.anchor}' 를 찾지 못함 (러너 결함, 즉시 수선 필요)`);
    continue;
  }
  writeFileSync(CARD, original.replace(m.anchor, m.replace), "utf8");
  try {
    const r = runGate();
    if (r.status !== 0 && r.status !== null) {
      const hits = (r.stdout + r.stderr).split("\n").filter((l) => l.includes("❌")).length;
      console.log(`  PASS  ${m.id}: RED 확인 (exit ${r.status}, 검출 ${hits}건) — ${m.desc}`);
    } else {
      failed++;
      console.error(`  FAIL  ${m.id}: 결함 주입에도 GREEN (exit ${r.status}) — 게이트에 검출력이 없다`);
    }
  } finally {
    writeFileSync(CARD, original, "utf8");
  }
}

// 복원 검증 — mutation 러너가 소스를 더럽힌 채 끝나면 그게 더 큰 사고다.
if (readFileSync(CARD, "utf8") !== original) {
  failed++;
  console.error("  FAIL  복원 실패: CompactGameCard.tsx 가 원본과 다르다");
}

console.log();
if (failed > 0) {
  console.error(`✗ FAIL — ${failed}건`);
  process.exit(1);
}
console.log(`✓ PASS — baseline GREEN + mutation ${MUTATIONS.length}종 전부 RED (검출력 증명)`);
