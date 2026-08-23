#!/usr/bin/env node
/**
 * qa:relay-substitution-render 의 검출력 증명 (#1294 삼순 NO-GO ② — 표시 제거/오결속 mutation RED).
 *
 * 렌더 게이트가 실제 DOM 산출물을 판정하는지, **production 소스(RelayInningCard.tsx)에 진짜
 * 결함을 주입**하고 게이트를 별도 프로세스로 실행해 RED 를 확인한다. 게이트가 사본을 태우면
 * 이 러너가 잡는다 — 게이트는 실제 소스를 import 하므로 변조가 그대로 판정에 걸려야 한다.
 *
 * M1: 교체 행 렌더 제거 (타석 사이 인포 행 소실 — 이번 PR 기능 자체의 회귀)
 * M2: 오결속 — 모든 교체 행을 play 0 앞에 몰아넣음 (playIndex 무시, 순서 계약 붕괴)
 * M3: tail(진행 중 타석) 교체 소실 — 라이브 즉시 노출 계약 붕괴
 *
 * 각 mutation 은 원본 백업 → 주입 → 게이트 실행 → 복원. anchor 문자열이 사라지면(리팩터링)
 * 조용히 통과하는 대신 그 자리에서 FAIL(anchor MISS = 러너 결함). 패치 미적용(원본==변조본)도 FAIL.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const CARD = path.join(ROOT, "src/components/game/RelayInningCard.tsx");

const MUTATIONS = [
  {
    id: "M1-remove-sub-rows",
    desc: "타석 사이 교체 행 렌더 제거",
    anchor: "{substitutionsAt(substitutions, i).map((e, j) => (",
    replace: "{substitutionsAt([], i).map((e, j) => (",
  },
  {
    id: "M2-bind-all-to-zero",
    desc: "오결속: 모든 교체 행을 play 0 앞으로",
    anchor: "return subs.filter((e) => e.playIndex === index);",
    replace: "return subs.filter(() => index === 0);",
  },
  {
    id: "M3-drop-trailing",
    desc: "진행 중 타석(tail) 교체 소실",
    anchor: "const trailingSubstitutions = substitutions.filter((e) => e.playIndex >= inning.plays.length);",
    replace: "const trailingSubstitutions = [] as typeof substitutions;",
  },
];

const runGate = () =>
  spawnSync("npx", ["tsx", "scripts/qa/relay-substitution-render-gate.mts"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 5 * 60 * 1000,
  });

const original = readFileSync(CARD, "utf8");
let failed = 0;

// ── 베이스라인: 무주입 GREEN 이어야 mutation RED 가 의미를 가진다.
{
  const r = runGate();
  if (r.status === 0) {
    console.log("  PASS  baseline: 무주입 게이트 GREEN (exit 0)");
  } else {
    failed++;
    console.error(`  FAIL  baseline: 무주입인데 게이트 RED (exit ${r.status})`);
    console.error((r.stdout + r.stderr).split("\n").slice(-6).join("\n"));
  }
}

for (const m of MUTATIONS) {
  if (!original.includes(m.anchor)) {
    failed++;
    console.error(`  FAIL  ${m.id}: anchor MISS — 소스에서 앵커를 못 찾음(러너 결함, 리팩터링 추적 필요)`);
    continue;
  }
  const mutated = original.replace(m.anchor, m.replace);
  if (mutated === original) {
    failed++;
    console.error(`  FAIL  ${m.id}: 패치 미적용(원본과 동일) — mutation 무효`);
    continue;
  }
  writeFileSync(CARD, mutated);
  try {
    const r = runGate();
    if (r.status !== 0) {
      console.log(`  PASS  ${m.id}: RED 검출 (${m.desc})`);
    } else {
      failed++;
      console.error(`  FAIL  ${m.id}: 결함 주입에도 GREEN — 게이트 검증력 없음 (${m.desc})`);
    }
  } finally {
    writeFileSync(CARD, original);
  }
}

// 복원 검증 — 러너가 워킹트리를 더럽힌 채 끝나면 안 된다.
if (readFileSync(CARD, "utf8") !== original) {
  failed++;
  console.error("  FAIL  restore: 원본 복원 실패 — 워킹트리 오염");
}

if (failed > 0) {
  console.error(`\nFAIL: ${failed}건`);
  process.exit(1);
}
console.log(`\nPASS: baseline GREEN + mutation ${MUTATIONS.length}/${MUTATIONS.length} RED + 원본 복원`);
