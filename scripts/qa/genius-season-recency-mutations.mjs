#!/usr/bin/env node
/**
 * 시즌 인식 랭킹 게이트의 **검증력 증명**.
 *
 * 계약: 원본 in-memory 백업 → 결함 주입 → smoke 재실행 → RED 여야 검출.
 * 앵커 부재 = 러너 고장으로 MISS(조용한 skip 금지). 종료 시 무조건 원복.
 *
 * 🔴 이 축이 왜 필요한가: 초안의 가중 폭(boost 1.35 / 하한 0.6)은 이름만 재점수화지
 *   사실상 hard sort 였고, 게이트 S4 가 그걸 실제로 잡았다. 상한을 assertion 으로
 *   박아두지 않으면 다음 사람이 "조금만 더 세게"로 되돌린다 — 그 회귀를 m5 가 지킨다.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const RETRIEVE = "src/lib/baseball-qa/rag/retrieve.ts";
const SERVER = "src/lib/baseball-qa/server.ts";
const SMOKE = "scripts/qa/genius-season-recency-smoke.ts";

const MUTATIONS = [
  {
    name: "m1 시즌 추출을 본문 기준으로 — `1999년 우승` 서술이 문서 시점이 된다(S2)",
    file: RETRIEVE,
    from: '  const hay = `${row.sectionPath ?? ""} ${row.pageTitle ?? ""}`;',
    to: '  const hay = `${row.sectionPath ?? ""} ${row.pageTitle ?? ""} ${(row as { content?: string }).content ?? ""}`;',
  },
  {
    name: "m2 경로 연도 중 최소값 채택 — `2023 시즌/…/2024년` 이 옛 시점으로 잡힌다(S1)",
    file: RETRIEVE,
    from: "  return Math.max(...years);",
    to: "  return Math.min(...years);",
  },
  {
    name: "m3 시즌 가중 자체를 제거 — 과거 문서가 다시 top1(S5b)",
    file: RETRIEVE,
    from: "      return { row, score: base * weight * seasonWeight };",
    to: "      return { row, score: base * weight };",
  },
  {
    name: "m4 연도 없는 문서를 감점 — 역대 감독표·등번호 문서가 밀린다(S3/S4c)",
    file: RETRIEVE,
    from: "  if (season === null) return 1;",
    to: "  if (season === null) return SEASON_RECENCY_MIN_WEIGHT;",
  },
  {
    name: "m5 가중 폭을 초안으로 되돌림 — 재점수화가 hard sort 로 퇴행(S4/S4d)",
    file: RETRIEVE,
    from: "export const SEASON_RECENCY_CURRENT_BOOST = 1.2;",
    to: "export const SEASON_RECENCY_CURRENT_BOOST = 1.35;",
  },
  {
    name: "m6 하한 제거 — 오래된 문서가 0 으로 죽어 과거 질문에 답할 근거가 사라진다(S3f)",
    file: RETRIEVE,
    from: "  return Math.max(SEASON_RECENCY_MIN_WEIGHT, 1 - age * SEASON_RECENCY_DECAY_PER_YEAR);",
    to: "  return Math.max(0, 1 - age * SEASON_RECENCY_DECAY_PER_YEAR);",
  },
  {
    name: "m7 미래 연도에도 boost — 다음 시즌 전망 문서가 현재를 이긴다(S3c)",
    file: RETRIEVE,
    from: "  if (season > currentSeason) return 1;",
    to: "  if (season > currentSeason) return SEASON_RECENCY_CURRENT_BOOST;",
  },
  {
    name: "m8 currentSeason 미주입에도 가중 적용 — 기본 거동이 바뀐다(S6)",
    file: RETRIEVE,
    from: "      const seasonWeight = currentSeason === undefined\n        ? 1\n        : seasonRecencyWeight(parseEvidenceSeason(row), currentSeason);",
    to: "      const seasonWeight = seasonRecencyWeight(parseEvidenceSeason(row), currentSeason ?? 2026);",
  },
  {
    name: "m9 하류 전달 누락 — 랭커가 시즌을 영영 못 받는다(S7c)",
    file: RETRIEVE,
    from: "  return rankEvidenceByQuery(\n    [...wikipediaRows, ...namuRows], queryVector, weightFor, project, currentSeason,\n  );",
    to: "  return rankEvidenceByQuery([...wikipediaRows, ...namuRows], queryVector, weightFor, project);",
  },
  {
    name: "m10 searchRag 배선 제거 — 프로덕션 경로만 조용히 종전으로 회귀(S7)",
    file: SERVER,
    from: "    kstSeasonOf(now()),",
    to: "",
  },
  {
    name: "m11 now seam 을 고정 — 게이트가 경계 시각을 주입할 수 없다(S7b)",
    file: SERVER,
    from: "  now: () => number = Date.now,",
    to: "  _now?: undefined,",
  },
];

const files = [...new Set(MUTATIONS.map((m) => m.file))];
const originals = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));
const restore = () => { for (const [f, s] of originals) writeFileSync(f, s); };
process.on("exit", restore);
process.on("SIGINT", () => { restore(); process.exit(130); });

function smokeIsRed() {
  try {
    const out = execSync(`npx tsx ${SMOKE}`, { encoding: "utf8", stdio: "pipe" });
    return { red: /^RED/m.test(out) || /FAIL /.test(out), out };
  } catch (error) {
    return { red: true, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

const base = smokeIsRed();
if (base.red) {
  console.error("BASELINE RED — 변조 전 게이트가 이미 실패한다. mutation 결과는 무의미하다.");
  console.error(base.out.split("\n").filter((l) => /FAIL|Error/.test(l)).slice(0, 10).join("\n"));
  process.exit(1);
}
console.log("BASELINE GREEN\n");

let detected = 0;
let missed = 0;
for (const mutation of MUTATIONS) {
  const original = originals.get(mutation.file);
  if (!original.includes(mutation.from)) {
    console.error(`MISS ${mutation.name}\n     앵커 부재: ${mutation.file}`);
    missed += 1;
    continue;
  }
  writeFileSync(mutation.file, original.replace(mutation.from, mutation.to));
  const { red } = smokeIsRed();
  writeFileSync(mutation.file, original);
  if (red) { detected += 1; console.log(`RED  ${mutation.name}`); }
  else { missed += 1; console.error(`GREEN(누락) ${mutation.name}`); }
}

restore();
console.log(`\n검출 ${detected}/${MUTATIONS.length} · 누락·앵커부재 ${missed}`);
if (missed > 0) process.exit(1);
