#!/usr/bin/env node
/**
 * `qa:baseball-corpus-identity` 게이트의 **검출력 증명** — 결함주입 runner.
 *
 * ⚠️ 왜 Node 인가 (2026-08-09 실측): 직전 판은 bash + `diff`/`perl`/`mktemp` 였고, **Vercel 빌드
 *   컨테이너에 `diff` 가 없어서** prebuild 가 통째로 깨졌다(`line 37: diff: command not found`
 *   → RED 0 · 검출실패 16 → `npm run build` exit 1). 게이트를 required CI 에 결속하려면
 *   runner 자체가 빌드 환경 도구에 의존하면 안 된다. 문자열 치환·비교·복원을 전부 Node 로 한다.
 *
 * ⚠️ 왜 assertion-specific 인가 (삼순 NO-GO ④): 종전 runner 는 **아무 nonzero exit** 를 RED 로 셌다.
 *   그러면 변이가 만든 컴파일 오류·모듈 로드 실패까지 "검출 성공" 이 된다. 게이트가 실제로
 *   그 결함을 *판정으로* 잡았는지는 증명되지 않는다.
 *   그래서 변이마다 **어떤 assertion 이 깨져야 하는지**를 지정하고, 게이트 출력에 그 문구가
 *   있을 때만 RED 로 센다.
 *
 * 계약:
 *   - 변이는 배포 소스를 실제로 훼손해야 한다(치환이 0건이면 패턴이 낡은 것 → 실패).
 *   - 게이트는 non-zero 로 끝나야 한다.
 *   - 게이트 출력에 **지정한 assertion 문구**가 있어야 한다.
 *   - 매 변이 후 원본을 복원하고, 종료 시 원본 일치를 확인한다.
 *
 * 실행: node scripts/qa/corpus-identity-mutations.mjs  (npm run qa:baseball-corpus-identity:mutations)
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const TARGET = "src/lib/baseball-qa/rag/corpus-identity.ts";
/** 신원 지문 모듈 — F 축 변이의 대상(#1162 재발 방지). */
const FINGERPRINT_TARGET = "scripts/qa/roster-identity-fingerprint.ts";

/** @type {{id: string, name: string, expect: string, target?: string, apply: (source: string) => string}[]} */
const MUTATIONS = [
  // ── A. 레이아웃 축 ───────────────────────────────────────────────────────
  {
    id: "A-1",
    name: "listed 레이아웃 파싱 제거(한 줄 파서로 회귀)",
    expect: "listed 레이아웃이다",
    apply: (s) => s.replace(
      'if (labels.length === 0) return { layout: "absent", labels: [] };\n  return { layout: "listed", labels };',
      'return { layout: "absent", labels: [] };',
    ),
  },
  {
    id: "A-2",
    name: "listed 라벨 블록 조기 종료(첫 줄만)",
    expect: "listed 라벨 블록이",
    apply: (s) => s.replace(
      "const stop = Math.min(lines.length, markerIndex + 1 + CATEGORY_LISTED_MAX_LINES);",
      "const stop = Math.min(lines.length, markerIndex + 2);",
    ),
  },
  {
    id: "A-3",
    name: "listed 라벨 블록 무제한 확장(본문까지 흡수)",
    expect: "라벨 블록이 본문까지 먹었다",
    apply: (s) => s.replace(
      "if (!isCorpusCategoryLabelLine(lines[index])) break;",
      "if (lines[index].trim().length === 0) break;",
    ),
  },
  {
    id: "A-4",
    name: "분류 스캔 줄 상한 축소(분류 줄을 못 찾음)",
    expect: "김도영은 inline 레이아웃이다",
    apply: (s) => s.replace("const CATEGORY_HEAD_LINES = 40;", "const CATEGORY_HEAD_LINES = 3;"),
  },
  {
    // ⚠️ 긴 분류가 잘리는 건 **inline 레이아웃**의 문제다(양의지 428자, 한 줄).
    //   listed 라벨 검사를 건드리면 이 축을 못 건드린다 — 첫 시도가 실제로 GREEN 이었다.
    id: "A-5",
    name: "inline 분류 300자 상한 복귀(양의지 잘림)",
    expect: "스캔 상한이 되살아났다",
    apply: (s) => s.replace(
      'const inline = markerLine.slice(markerLine.indexOf("분류") + 2).trim();',
      'const inline = markerLine.slice(markerLine.indexOf("분류") + 2).trim().slice(0, 300);',
    ),
  },

  // ── B. 평탄화 fail-open 축 (삼순 NO-GO ②) ────────────────────────────────
  {
    id: "B-1",
    name: "본문 마커 검사 제거(평탄화 문서를 분류로 읽음)",
    expect: "분류 줄이 본문을 삼켰는데 판정했다",
    apply: (s) => s.replace(
      'if (hasBodyMarker(inline)) return { layout: "unparseable", labels: [] };',
      "",
    ),
  },
  {
    id: "B-2",
    name: "unparseable 을 통과로 처리",
    expect: "분류 줄이 본문을 삼켰는데 판정했다",
    apply: (s) => s.replace('if (layout === "unparseable") {', "if (false) {"),
  },

  // ── C. 생년 근거 축 (삼순 NO-GO ①, 2차 ①) ────────────────────────────────
  {
    id: "C-1",
    name: "등록일 명시 요구 제거(무조건 구제)",
    expect: "구제 조건이 사라졌다",
    apply: (s) => s.replace(
      "if (!documentStatesRosterBirthDate(input.text, input.rosterBirthDate)) {",
      "if (false) {",
    ),
  },
  {
    id: "C-2",
    name: "근접일 휴리스틱 회귀(연도차 1이면 구제)",
    expect: "근접일 허용이 되살아났다",
    apply: (s) => s.replace(
      "  if (!rosterBirthDate) return false;\n  const needle = formatRosterBirthDateForDocument(rosterBirthDate);",
      "  if (!rosterBirthDate) return false;\n  const nearby = extractBirthClauseDate(text);\n  if (nearby && Math.abs(nearby.year - Number(rosterBirthDate.slice(0, 4))) === 1) return true;\n  const needle = formatRosterBirthDateForDocument(rosterBirthDate);",
    ),
  },
  {
    // 삼순 2차 NO-GO ① 그 자체: 관계 결속을 걷고 본문 전체 includes 로 되돌린다.
    id: "C-3",
    name: "등록일 관계 결속 제거(본문 전체 includes 회귀)",
    expect: "관계 결속이 사라졌다",
    apply: (s) => s.replace(
      "  const lines = text.split(\"\\n\");\n  for (let index = 0; index < lines.length; index += 1) {",
      "  if (text.includes(needle)) return true;\n  const lines = text.split(\"\\n\");\n  for (let index = 0; index < lines.length; index += 1) {",
    ),
  },
  {
    id: "C-4",
    name: "관계 신호 구간을 문서 전체로 확대(무관 서술도 근거로)",
    expect: "관계 결속이 사라졌다",
    apply: (s) => s.replace(
      "    const segment = lines\n      .slice(Math.max(0, index - BIRTH_RELATION_CONTEXT_LINES), index + BIRTH_RELATION_CONTEXT_LINES + 1)\n      .join(\"\\n\");",
      "    const segment = text;",
    ),
  },
  {
    id: "C-5",
    name: "출생 clause 결속 해제(첫 날짜 아무거나)",
    expect: "출생 clause가 없는데 데뷔일을 생일로 읽었다",
    apply: (s) => s.replace(
      '  const clauseIndex = lines.findIndex((line) => line.trim() === "출생");\n  if (clauseIndex < 0) return undefined;',
      "  const clauseIndex = 0;",
    ),
  },
  {
    // ⚠️ listed 만 죽이는 변이여야 한다. 읽는 줄 수를 줄이면 inline(최형우: `\t` 다음 줄에 날짜)도
    //   함께 죽어 어느 축이 깨졌는지 구분되지 않는다. 병합만 없애면 listed 의 쪼개진 날짜만 못 읽는다.
    id: "C-6",
    name: "clause 줄바꿈 병합 제거(listed 쪼개진 날짜 못 읽음)",
    expect: "listed 출생 clause 를 읽지 못했다",
    apply: (s) => s.replace(
      '    .join("");',
      '    .filter((line) => line.length > 0)[0] ?? "";',
    ),
  },
  {
    id: "C-7",
    name: "clause 부재 fail-close 제거",
    expect: "인포박스 생일이 없는데 구제했다",
    apply: (s) => s.replace("if (!extractBirthClauseDate(input.text)) {", "if (false) {"),
  },
  {
    id: "C-8",
    name: "로스터 날짜 결측 시 통과",
    expect: "로스터 날짜 없이 통과했다",
    apply: (s) => s.replace("  if (!rosterBirthDate) return false;", "  if (!rosterBirthDate) return true;"),
  },

  // ── D. 신원 판정 순서·제목 축 ────────────────────────────────────────────
  {
    id: "D-1",
    name: "동음이의 판정을 야구분류 뒤로(순서 붕괴)",
    expect: "동음이의 문서에 야구선수가 섞여 있는데 통과했다",
    apply: (s) => s.replace(
      '  if (isAmbiguityDocument(categories)) {\n    // 버리는 게 아니라 격리한다 — 나중에 진짜 문서를 찾을 단서가 된다.\n    return { ok: false, status: "ambiguous", reason: "ambiguity_document" };\n  }\n  if (!hasBaseballPlayerCategory(categories)) {\n    return { ok: false, status: "rejected", reason: "not_baseball_player_document" };\n  }',
      '  if (!hasBaseballPlayerCategory(categories)) {\n    return { ok: false, status: "rejected", reason: "not_baseball_player_document" };\n  }\n  if (isAmbiguityDocument(categories)) {\n    return { ok: false, status: "ambiguous", reason: "ambiguity_document" };\n  }',
    ),
  },
  {
    id: "D-2",
    name: "제목 대조 제거(타인 문서 오귀속)",
    expect: "다른 선수 문서에 도착했는데 통과했다",
    apply: (s) => s.replace(
      "  const matchedTitle = titleMatchesSeed(input.seedName, input.documentTitle);",
      "  const matchedTitle = true;",
    ),
  },
  {
    id: "D-3",
    name: "분류 대신 본문 전체로 야구선수 판정(fail-open)",
    expect: "성씨 문서가 본문 야구선수 링크로 통과했다",
    apply: (s) => s.replace(
      "  if (!hasBaseballPlayerCategory(categories)) {",
      "  if (!hasBaseballPlayerCategory(input.text)) {",
    ),
  },

  // ── F. 신원 지문 축 (2026-08-12, #1162 재발 방지 — 삼순 수용조건) ──────────────
  //   과소(신원 필드 누락·dedupe·상수화)는 신원 변경을 놓치고,
  //   과대(신원 무관 필드 포함)는 매일 갱신을 다시 전건 FAIL 로 되돌린다.
  //   양쪽 모두 smoke 의 지문 계약 섹션이 잡아야 한다.
  {
    id: "F-1",
    name: "지문에서 kboId 제외(과소 — kboId 교체를 놓침)",
    expect: "kboId 변경이 지문에 반영되지 않았다",
    target: FINGERPRINT_TARGET,
    apply: (s) => s.replace(
      "return [field(player.name), field(player.kboId), field(player.birthDate)].join(\"\\u0000\");",
      "return [field(player.name), field(player.birthDate)].join(\"\\u0000\");",
    ),
  },
  {
    id: "F-2",
    name: "지문에서 birthDate 제외(과소 — 생년 정정을 놓침)",
    expect: "birthDate 변경이 지문에 반영되지 않았다",
    target: FINGERPRINT_TARGET,
    apply: (s) => s.replace(
      "return [field(player.name), field(player.kboId), field(player.birthDate)].join(\"\\u0000\");",
      "return [field(player.name), field(player.kboId)].join(\"\\u0000\");",
    ),
  },
  {
    id: "F-3",
    name: "지문에서 name 제외(과소 — 개명·오타 교정을 놓침)",
    expect: "name 변경이 지문에 반영되지 않았다",
    target: FINGERPRINT_TARGET,
    apply: (s) => s.replace(
      "return [field(player.name), field(player.kboId), field(player.birthDate)].join(\"\\u0000\");",
      "return [field(player.kboId), field(player.birthDate)].join(\"\\u0000\");",
    ),
  },
  {
    id: "F-4",
    name: "중복 튜플 dedupe(multiset 계약 파괴)",
    expect: "중복이 dedupe 됐다",
    target: FINGERPRINT_TARGET,
    apply: (s) => s.replace(
      "const tuples = roster.map(canonicalIdentityTuple);\n  tuples.sort();",
      "const tuples = [...new Set(roster.map(canonicalIdentityTuple))];\n  tuples.sort();",
    ),
  },
  {
    id: "F-5",
    name: "지문에 신원 무관 필드 포함(과대 — 매일 갱신 전건 FAIL 회귀)",
    expect: "지문이 과대해서 매일 갱신이 다시 전건 FAIL 로 돌아간다",
    target: FINGERPRINT_TARGET,
    apply: (s) => s.replace(
      "return [field(player.name), field(player.kboId), field(player.birthDate)].join(\"\\u0000\");",
      "return [field(player.name), field(player.kboId), field(player.birthDate), field(/** @type {any} */ (player).team)].join(\"\\u0000\");",
    ),
  },
  {
    id: "F-6",
    name: "지문 상수화(모든 변경을 놓침)",
    expect: "선수 추가가 지문에 반영되지 않았다",
    target: FINGERPRINT_TARGET,
    apply: (s) => s.replace(
      "const tuples = roster.map(canonicalIdentityTuple);",
      "const tuples = [];",
    ),
  },
  {
    id: "F-7",
    name: "정렬 제거(순서 의존 회귀 — reorder 가 전건 FAIL)",
    expect: "multiset 이 아니라 순서에 묶였다",
    target: FINGERPRINT_TARGET,
    apply: (s) => s.replace("  tuples.sort();\n", ""),
  },
];

function runGate() {
  const result = spawnSync("npm", ["run", "-s", "qa:baseball-corpus-identity"], {
    encoding: "utf8",
    env: process.env,
  });
  return {
    ok: result.status === 0,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function main() {
  /** 변이 대상별 원본 — 복원·종료검증을 대상 파일 단위로 한다. */
  const originals = new Map([
    [TARGET, readFileSync(TARGET, "utf8")],
    [FINGERPRINT_TARGET, readFileSync(FINGERPRINT_TARGET, "utf8")],
  ]);
  let red = 0;
  let failed = 0;
  try {
    for (const mutation of MUTATIONS) {
      const target = mutation.target ?? TARGET;
      const original = originals.get(target);
      const mutated = mutation.apply(original);
      const label = `${mutation.id} ${mutation.name}`;
      if (mutated === original) {
        console.log(`❌ ${label} → 변이가 소스를 못 바꿨다(패턴 낡음)`);
        failed += 1;
        continue;
      }
      writeFileSync(target, mutated);
      let verdict;
      try {
        verdict = runGate();
      } finally {
        writeFileSync(target, original);
      }
      if (verdict.ok) {
        console.log(`❌ ${label} → GREEN (게이트가 못 잡는다)`);
        failed += 1;
        continue;
      }
      if (!verdict.output.includes(mutation.expect)) {
        const actual = verdict.output
          .split("\n")
          .find((line) => /AssertionError|Error:|error TS/.test(line)) ?? "(진단 없음)";
        console.log(`❌ ${label} → non-zero 지만 기대 assertion 이 아니다`);
        console.log(`     기대: ${mutation.expect}`);
        console.log(`     실제: ${actual.slice(0, 220)}`);
        failed += 1;
        continue;
      }
      console.log(`✅ ${label} → RED (${mutation.expect})`);
      red += 1;
    }
  } finally {
    for (const [file, source] of originals) writeFileSync(file, source);
  }

  console.log("----------------------------------------");
  console.log(`RED ${red} · 검출실패 ${failed}`);
  for (const [file, source] of originals) {
    if (readFileSync(file, "utf8") !== source) {
      console.log(`❌ 원본 복원 실패: ${file}`);
      process.exit(1);
    }
  }
  if (failed !== 0) {
    console.log(`❌ mutation: 검출 실패 ${failed}건`);
    process.exit(1);
  }
  console.log("✅ mutation: 전 축 RED (게이트 검출력 확인)");
}

main();
