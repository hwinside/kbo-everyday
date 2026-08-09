// 비교형 후속 판정 mutation runner — PR #1139
//
// 판정축을 하나씩 죽여서 게이트(baseball-genius-context-smoke)가 RED 를 내는지 확인한다.
// 게이트가 어떤 축 제거에도 GREEN 이면 그 게이트는 그 축을 지키지 못하는 것이다.
//
// ⚠️ 운영 규칙 (2026-08-09 #1137 교훈 반영):
//   • 원복은 in-memory 백업 → 파일 재작성. `git checkout --` 는 쓰지 않는다(P0).
//   • 앵커가 없으면 "검출 성공"이 아니라 **runner 고장**으로 실패시킨다.
//   • 아무 nonzero exit 을 RED 로 세지 않는다 — AssertionError 마커가 있어야 검출이다.
//     (컴파일 오류·모듈 로드 실패는 검출이 아니라 mutation 자체의 부작용이다)
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const CONTEXT = path.join(root, "src/lib/baseball-qa/context.ts");
const PIPELINE = path.join(root, "src/lib/baseball-qa/pipeline.ts");

const MUTATIONS = [
  {
    id: "M1 비교 관계 표현 축 제거",
    file: CONTEXT,
    anchor: "return COMPARATIVE_RELATION_STEMS.some((stem) => compact.includes(stem));",
    replacement: "return false;",
    why: "관계 표현 판정이 죽으면 양성 4형태 전부 후속으로 안 잡힌다",
  },
  {
    id: "M2 엔티티 ≥2 자기완결 차단 제거",
    file: CONTEXT,
    anchor: "if (entityCount >= 2) return false;",
    replacement: "if (entityCount >= 2) return true;",
    why: "삼순 반례(그랜드슬램은 만루홈런이랑 비슷해?)가 후속으로 오판돼 무관 맥락이 주입된다",
  },
  {
    id: "M3 명시 지시어 축 제거",
    file: CONTEXT,
    anchor: "return hasComparativeDemonstrative(question);",
    replacement: "return false;",
    why: "`그거랑 비슷해?` 가 후속에서 빠진다",
  },
  {
    id: "M4 합성어 병합 제거 (조각별 계수)",
    file: PIPELINE,
    anchor: "if (segments >= 2 || hasEntitySegment) count += 1;",
    replacement: "count += segments;",
    why: "`만루홈런` 이 2개로 세져 제보 원형이 자기완결로 오판된다",
  },
  {
    id: "M5 광역 신호어 단독 인정",
    file: PIPELINE,
    anchor: "if (segments >= 2 || hasEntitySegment) count += 1;",
    replacement: "count += 1;",
    why: "`야구랑 비슷해?` 가 피연산자를 얻어 후속으로 오판된다",
  },
];

function runSmoke() {
  try {
    execFileSync("npx", ["tsx", "scripts/qa/baseball-genius-context-smoke.ts"], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      timeout: 300_000,
    });
    return { failed: false, output: "" };
  } catch (error) {
    const output = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
    return { failed: true, output };
  }
}

// mutation 을 걸기 전 게이트가 GREEN 인지 먼저 확인한다 — baseline 이 RED 면 검출력 판정 불가.
{
  const baseline = runSmoke();
  if (baseline.failed) {
    console.error("❌ baseline 게이트가 이미 RED 다 — mutation 검출력 판정 불가");
    process.exit(1);
  }
}

let detected = 0;
for (const mutation of MUTATIONS) {
  const original = readFileSync(mutation.file, "utf-8");
  if (!original.includes(mutation.anchor)) {
    // 앵커 부재 = 대상 코드가 바뀌었는데 runner 가 못 따라온 것. 검출 성공으로 세지 않는다.
    console.error(`❌ RUNNER 고장 — 앵커 부재: ${mutation.id}`);
    console.error(`   anchor: ${mutation.anchor}`);
    process.exit(1);
  }
  try {
    writeFileSync(mutation.file, original.replace(mutation.anchor, mutation.replacement));
    const result = runSmoke();
    const assertionRed = result.failed && /ERR_ASSERTION|AssertionError/.test(result.output);
    if (assertionRed) {
      console.log(`RED  ${mutation.id} — ${mutation.why}`);
      detected += 1;
    } else if (result.failed) {
      console.error(`❌ 검출 실패(비정상 종료만 있음, assertion 아님): ${mutation.id}`);
      process.exit(1);
    } else {
      console.error(`❌ 검출 실패(GREEN): ${mutation.id} — 게이트가 이 축을 지키지 못한다`);
      process.exit(1);
    }
  } finally {
    writeFileSync(mutation.file, original);
  }
}

// 원복 확인 — 원복이 안 됐으면 이후 게이트 전부가 오염된다.
{
  const restored = runSmoke();
  if (restored.failed) {
    console.error("❌ 원복 후 게이트 RED — 원복 실패");
    process.exit(1);
  }
}

console.log(`✅ comparative-followup mutation PASS (${detected}/${MUTATIONS.length} 전부 RED)`);
