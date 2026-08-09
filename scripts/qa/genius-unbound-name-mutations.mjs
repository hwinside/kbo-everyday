#!/usr/bin/env node
//
// `qa:genius-unbound-name` 게이트의 **검출력 증명** — 결함주입 runner.
//
// ⚠️ 왜 Node 로 다시 썼는가 (2026-08-09).
//   직전 판은 bash + `perl`/`diff`/`mktemp` 였다. 이 게이트를 required CI(`prebuild`)에
//   결속하는 순간 **빌드 컨테이너에서 통째로 깨진다** — Vercel 빌드 이미지에 `diff` 가
//   없어서 같은 트랙의 corpus mutation runner 가 `diff: command not found` 로 죽고
//   `npm run build` 가 exit 1 이 됐다(실측). 게이트를 CI 에 묶으려면 runner 가
//   **빌드 환경 도구에 의존하면 안 된다.** 외부 프로세스는 `npm` 하나만 쓴다.
//
// ⚠️ 왜 exit code 가 아니라 **assertion 문구**로 판정하는가 (삼순 2026-08-08 ④).
//   종전엔 "게이트가 nonzero 로 끝나면 RED" 로 셌다. 그러면 변이가 만든 **컴파일 오류**나
//   모듈 로드 실패까지 "검출 성공" 으로 둔갑한다 — 게이트가 그 결함을 본 게 아닌데도.
//   그래서 변이마다 **깨져야 할 assertion 문구**를 지정하고, 게이트 출력에 그 문구가
//   있을 때만 RED 로 센다. 컴파일 오류는 검출 실패로 분류한다.
//
// 계약: 각 변이는 **배포 소스**(`src/lib/baseball-qa/pipeline.ts`)를 실제로 훼손하고,
//       게이트가 지정된 assertion 으로 RED 여야 통과다.
//       원본은 시작 시 백업하고 매 변이 후 복원한다(정상/예외/시그널 모두).
//
// 실행: node scripts/qa/genius-unbound-name-mutations.mjs
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const TARGET = "src/lib/baseball-qa/pipeline.ts";

if (!fs.existsSync(TARGET)) {
  console.error(`❌ ${TARGET} 이 없다 — repo 루트에서 실행해야 한다`);
  process.exit(1);
}

const ORIGINAL = fs.readFileSync(TARGET, "utf8");
const restore = () => fs.writeFileSync(TARGET, ORIGINAL);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { restore(); process.exit(130); });
}

/**
 * 변이 정의.
 *
 *   from     — 원본에 정확히 1번 나와야 하는 문자열(0번/2번 이상이면 "패턴이 낡음" 으로 실패)
 *   to       — 대체 문자열
 *   expect   — 게이트 출력에 반드시 나와야 하는 **assertion 근거 문구**.
 *              이게 없으면 RED 여도 검출 실패로 센다(컴파일 오류로 죽은 것과 구분).
 */
const MUTATIONS = [
  {
    name: "N-A fail-close 제거 (원래 사고 재현)",
    from: `  if (unboundName !== null) {
    return unboundName.suggestion === null ? "name_unknown" : "name_suggest";
  }`,
    to: `  if (false && unboundName !== null) { return "name_suggest"; }`,
    expect: "source=",
  },
  {
    name: "N-B 후보 1명 제한 해제 (엉뚱한 이름 제안)",
    from: `    return candidates.length === 1 ? candidates[0] : null;`,
    to: `    return candidates[0] ?? null;`,
    expect: "엉뚱한 이름을 제안했다",
  },
  {
    name: "N-C 축1(near-miss) 제거 — 표현 무관 fail-close 상실",
    from: `    const suggestion = uniqueNearMiss(token);
    if (suggestion === null) continue;`,
    to: `    const suggestion = uniqueNearMiss(token);
    if (suggestion === null || true) continue;`,
    expect: "source=",
  },
  {
    name: "N-D quota 반납 제거 (오타에 한도 2배)",
    from: `    if (isUnboundNameRoute && deps.releaseDaily) {`,
    to: `    if (false && deps.releaseDaily) {`,
    expect: "반납이 없다",
  },
  {
    name: "N-E 축2 사람 신호 요구 제거 (룰 질문 누수)",
    from: `  if (!hasPersonWord) return null;`,
    to: `  if (false) return null;`,
    expect: "오탐",
  },
  {
    name: "N-F 성씨 결속 제거 (아무 3음절이나 이름)",
    from: `    if (!surnames.has(token[0])) return false;`,
    to: `    if (false) return false;`,
    expect: "오탐",
  },
  {
    name: "N-G 머리 어절 제약 제거 (용언이 이름으로 먹힌다)",
    from: `  const cores = [...new Set(stripTokenSuffix(headRaw))].sort((a, b) => a.length - b.length);`,
    to: `  const cores = [...new Set(tokens.flatMap((t) => stripTokenSuffix(t)))].sort((a, b) => a.length - b.length);`,
    expect: "오탐",
  },
  {
    name: "N-H 한국 성씨 폐쇄집합 제거 (은퇴 선수 누수)",
    from: `  const surnames = new Set([...KOREAN_SURNAMES, ...rosterNames.map((name) => name[0])]);`,
    to: `  const surnames = new Set(rosterNames.map((name) => name[0]));`,
    expect: "현역 로스터에 없는 성씨",
  },
  {
    name: "N-I 축2 조사형 배제 제거 (`김치는` 이 이름)",
    from: `    if (SUBJECT_PARTICLES.some((particle) => token.endsWith(particle))) continue;
    if (!isNameShaped(token)) continue;`,
    to: `    if (!isNameShaped(token)) continue;`,
    expect: "오탐",
  },
  {
    name: "N-K 음절 하한 완화 (`김치`·`안타` 가 이름 후보)",
    from: `    if (token.length < 3 || token.length > 4) return false;`,
    to: `    if (token.length < 2 || token.length > 4) return false;`,
    expect: "오탐",
  },
  {
    name: "N-L 기능어 분해형 배제 제거 (`저번에` 우회)",
    from: `  if (cores.some((core) => NON_NAME_FUNCTION_WORDS.has(core))) return null;`,
    to: `  if (false) return null;`,
    expect: "오탐",
  },
  {
    name: "N-M 담화 표지 건너뛰기 제거 (`혹시 임창규 알아?` 누수)",
    from: `  const headIndex = tokens.findIndex((token) => !DISCOURSE_FILLERS.has(token));`,
    to: `  const headIndex = tokens.length > 0 ? 0 : -1;`,
    expect: "source=",
  },
  {
    name: "N-N 축1 조사자리 차이 배제 제거 (`박수는`→`박수종`)",
    from: `    if (SUBJECT_PARTICLES.some((particle) => token.endsWith(particle))
      && token[token.length - 1] !== suggestion[suggestion.length - 1]) continue;`,
    to: `    if (false) continue;`,
    expect: "오탐",
  },
  {
    name: "N-O `name_unknown` 라벨 병합 (감사 분모 오염)",
    from: `    return unboundName.suggestion === null ? "name_unknown" : "name_suggest";`,
    to: `    return "name_suggest";`,
    expect: "name_unknown",
  },
];

// N-J — **동등변이**로 판정해 제외했다 (검출 실패가 아니다).
//
//   "핵 우선 정렬(`a.length - b.length`)을 뒤집는" 변이를 넣었는데 게이트가 GREEN 이었다.
//   원인을 파보니 게이트 결손이 아니라 **정렬이 이미 결과를 바꿀 수 없는 상태**였다:
//     `임창규는 어느 팀이야` → 분해형 [`임창규는`, `임창규`]
//     축1 은 조사자리 차이를 배제하므로 정렬 방향과 무관하게 `임창규` 만 남는다(실측).
//   즉 프로그램 행동을 바꾸지 않는 동등변이라 어떤 게이트로도 RED 가 될 수 없다.
//   ⚠️ "게이트가 못 잡는다"와 "변이가 행동을 안 바꾼다"는 다르다 — 전자만 결손이다.

function runGate() {
  const result = spawnSync("npm", ["run", "-s", "qa:genius-unbound-name"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    code: result.status ?? 1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

console.log("=== genius-unbound-name mutation runner ===");

let red = 0;
let missed = 0;

try {
  for (const mutation of MUTATIONS) {
    const occurrences = ORIGINAL.split(mutation.from).length - 1;
    if (occurrences !== 1) {
      console.log(`❌ ${mutation.name} → 패턴이 낡음 (원본에서 ${occurrences}번 발견, 1번이어야 한다)`);
      missed += 1;
      continue;
    }
    fs.writeFileSync(TARGET, ORIGINAL.replace(mutation.from, mutation.to));
    const { code, output } = runGate();
    restore();

    if (code === 0) {
      console.log(`❌ ${mutation.name} → GREEN (게이트가 이 결함을 못 잡는다)`);
      missed += 1;
      continue;
    }
    // ⚠️ 여기가 핵심. nonzero 만으로는 부족하다 — **기대한 assertion 으로** 죽어야 한다.
    //   컴파일 오류·모듈 로드 실패로 죽은 것을 "검출 성공" 으로 세면 검출력을 부풀린다.
    if (!output.includes(mutation.expect)) {
      const head = output.split("\n").find((line) => line.trim().length > 0) ?? "";
      console.log(`❌ ${mutation.name} → RED 이지만 기대 assertion(\`${mutation.expect}\`)이 아니다: ${head.slice(0, 120)}`);
      missed += 1;
      continue;
    }
    console.log(`✅ ${mutation.name} → RED (\`${mutation.expect}\`)`);
    red += 1;
  }
} finally {
  restore();
}

console.log("----------------------------------------");
console.log(`RED ${red} · 검출실패 ${missed}`);

// 원본 무결성 확인 — 스크립트가 소스를 오염시킨 채 끝나면 안 된다.
if (fs.readFileSync(TARGET, "utf8") !== ORIGINAL) {
  console.error(`❌ 원본 복원 실패: ${path.resolve(TARGET)}`);
  process.exit(1);
}

if (missed !== 0) {
  console.error(`❌ mutation: 검출 실패 ${missed}건 — 게이트가 그 축을 보지 못한다`);
  process.exit(1);
}
console.log("✅ mutation: 전 축 RED (게이트 검출력 확인)");
