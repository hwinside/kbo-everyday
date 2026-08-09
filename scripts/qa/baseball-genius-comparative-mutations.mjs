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
    anchor: "if (spans.length >= 2) return false;",
    replacement: "if (spans.length >= 2) return true;",
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
    id: "M4 최장 우선 선택 제거 (짧은 조각이 먼저 잡힘)",
    file: PIPELINE,
    anchor: "spans.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start);",
    replacement: "spans.sort((a, b) => (a.end - a.start) - (b.end - b.start) || a.start - b.start);",
    why: "`만루홈런`/`엘지트윈스` 가 조각으로 갈라져 계수가 갈린다",
  },
  {
    id: "M5 광역 신호어 계수 편입",
    file: PIPELINE,
    anchor: "for (const word of RULE_TERM_HINT_WORDS) {",
    replacement: "for (const word of [...RULE_TERM_HINT_WORDS, ...BASEBALL_WORDS]) {",
    why: "`야구랑 비슷해?` 가 피연산자를 얻어 후속으로 오판된다",
  },
  {
    id: "M6 ASCII 단어 경계 제거",
    file: PIPELINE,
    anchor: `    const lead = /^[a-z0-9]/.test(parts[0]) ? "(?<![a-z0-9])" : "";
    const trailPart = parts[parts.length - 1];
    const trail = /[a-z0-9]$/.test(trailPart) ? "(?![a-z0-9])" : "";`,
    replacement: `    const lead = "";
    const trailPart = parts[parts.length - 1];
    const trail = "";`,
    why: "ASCII 어휘가 단어 안 부분문자열로 잡힌다 (walkbalker 안의 balk)",
  },
  {
    id: "M8 roster 선수 계수 제거",
    file: PIPELINE,
    anchor: 'for (const player of players) addSpans(player.name ?? "", "other");',
    replacement: ";",
    why: "`김도영이랑 비슷해?` 가 엔티티 0개가 되어 후속에서 빠진다",
  },
  {
    id: "M14 비야구 stem + 야구 엔티티 차단 제거",
    file: CONTEXT,
    anchor: "if (explicitNonBaseball.length >= 1 && spans.length >= 1) return false;",
    replacement: "if (false) return false;",
    why: "`애플이랑 한화 차이?` 가 후속으로 오판된다",
  },
  {
    id: "M15 질문형 target 차단 제거",
    file: CONTEXT,
    anchor: "if (hasInterrogativeTarget && (spans.length >= 1 || explicitStems.length >= 1)) return false;",
    replacement: "if (false) return false;",
    why: "`한화랑 뭐가 비슷해?` 가 후속으로 오판된다",
  },
  {
    id: "M10 구단 잔여 검증 제거 (LG화학이 구단으로 잡힘)",
    file: PIPELINE,
    anchor: "if (isGrammaticalTail(rest)) return true;",
    replacement: "return true;",
    why: "`LG화학이랑 비슷해?` 가 구단 1개로 세져 비야구 질문에 야구 맥락이 주입된다",
  },
  {
    id: "M11 다어절 유연 매칭 제거 (조각을 붙여쓰기로만 결합 — grand slam alias 포함)",
    file: PIPELINE,
    anchor: 'const body = parts.map(escapeRegExp).join("\\\\s*");',
    replacement: 'const body = parts.map(escapeRegExp).join("");',
    why: "`기예르모 에레디아랑 비슷해?` 가 0개가 되어 후속에서 끊긴다",
  },
  {
    id: "M12 결합형 span 등록 제거 (띄어쓰기 팀명이 2개로 갈라짐)",
    file: PIPELINE,
    anchor: "      for (const nick of nicks) addSpans(`${base} ${nick}`, \"team\");",
    replacement: "      ;",
    why: "`LG 트윈스랑 비슷해?` 가 2개로 세져 후속이 차단된다",
  },
  {
    id: "M9 인접 span 병합 회귀 (겹침 판정을 ≤ 로)",
    file: PIPELINE,
    anchor: "if (chosen.some((other) => span.start < other.end && other.start < span.end)) continue;",
    replacement: "if (chosen.some((other) => span.start <= other.end && other.start <= span.end)) continue;",
    why: "`LG한화 차이?` 가 1개로 병합돼 자기완결 질문에 맥락이 붙는다",
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
const failures = [];
for (const mutation of MUTATIONS) {
  const original = readFileSync(mutation.file, "utf-8");
  if (!original.includes(mutation.anchor)) {
    // 앵커 부재 = 대상 코드가 바뀌었는데 runner 가 못 따라온 것. 검출 성공으로 세지 않는다.
    console.error(`❌ RUNNER 고장 — 앵커 부재: ${mutation.id}`);
    console.error(`   anchor: ${mutation.anchor}`);
    failures.push(`anchor-missing: ${mutation.id}`);
    continue;
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
      failures.push(`abnormal: ${mutation.id}`);
    } else {
      console.error(`❌ 검출 실패(GREEN): ${mutation.id} — 게이트가 이 축을 지키지 못한다`);
      failures.push(`green: ${mutation.id}`);
    }
  } finally {
    // ⚠️ 여기서 process.exit 을 부르면 finally 가 건너뛰어져 **변이가 파일에 남는다**
    //   (2026-08-10 실측 — M13 GREEN 직후 exit 으로 context.ts 에 변이 잔류).
    //   실패는 모아서 루프 밖에서 종료한다.
    writeFileSync(mutation.file, original);
  }
}
if (failures.length > 0) {
  console.error(`❌ mutation 실패 ${failures.length}건: ${failures.join(", ")}`);
  process.exit(1);
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
