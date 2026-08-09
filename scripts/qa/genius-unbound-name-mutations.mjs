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
    from: `  if (resolveUnboundName(question, players) !== null) return "name_suggest";`,
    to: `  if (false) return "name_suggest";`,
    expect: "source=",
  },
  {
    name: "N-B alias map 을 near-miss 규칙으로 되돌리기 (`보크`→`보스` 47회 오제안)",
    // 이 PR 이 폐기한 그 접근이다. 되살리면 운영 로그 67종이 통째로 오제안이 된다.
    from: `      const suggestion = MEASURED_TYPO_ALIASES.get(token);
      if (suggestion === undefined) continue;`,
    to: `      const near = players.map((p) => p.name).filter((n) =>
        n.length === token.length && [...n].filter((c, i) => c !== token[i]).length === 1);
      const suggestion = near.length === 1 ? near[0] : undefined;
      if (suggestion === undefined) continue;`,
    expect: "야구 용어·기능어를 사람 이름으로 오인",
  },
  {
    name: "N-C 조사 분해 제거 (`임창규는 어느 팀이야` 누수)",
    from: `    for (const token of stripTokenSuffix(raw)) {`,
    to: `    for (const token of [raw]) {`,
    expect: "source=",
  },
  {
    name: "N-D quota 반납 제거 (오타에 한도 2배)",
    from: `    if (route === "name_suggest" && deps.releaseDaily) {`,
    to: `    if (false && deps.releaseDaily) {`,
    expect: "반납이 없다",
  },
  {
    name: "N-E 로스터 존재 확인 제거 (없는 선수를 되묻는다)",
    from: `      if (!rosterNames.has(suggestion)) continue;`,
    to: `      if (false) continue;`,
    expect: "없는 선수를 되물었다",
  },
  {
    name: "N-F 오타 키의 실존 선수 배제 제거 (결함의 거울상)",
    from: `      if (rosterNames.has(token)) continue;`,
    to: `      if (false) continue;`,
    expect: "실존 선수를 오타로 취급해 되물었다",
  },
  {
    name: "N-G alias 엔트리 삭제 (`임창규` 가 generic LLM 으로 간다)",
    from: `  ["임창규", "임찬규"],`,
    to: `  // MUT-NG`,
    expect: "source=",
  },
  {
    name: "N-H 두 번째 alias 삭제 (`양혅종` 누수)",
    from: `  ["양혅종", "양현종"],`,
    to: `  // MUT-NH`,
    expect: "source=",
  },
  {
    name: "N-I 문구 생성 fail-close 제거 (라우팅만 하고 문구가 없다)",
    from: `        ? (unbound === null ? UNCLEAR_ANSWER : NAME_SUGGEST_ANSWER(unbound.suggestion))`,
    to: `        ? NAME_SUGGEST_ANSWER("")`,
    expect: "answer",
  },
  {
    name: "N-J 캐시 우회 제거 (미결속 실명 답이 캐시를 탄다)",
    from: `  if (resolveUnboundName(question, players) !== null) return "name_suggest";
`,
    to: `
`,
    expect: "source=",
  },
];

// (구 N-J 동등변이 메모는 삭제했다 — 그 축의 코드가 이 판에서 통째로 사라졌다.)
// 아래는 낡은 메모다.
// N-J-old — **동등변이**로 판정해 제외했었다.
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
