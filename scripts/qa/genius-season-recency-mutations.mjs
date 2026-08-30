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
    from: "  const section = yearsIn(row.sectionPath ?? \"\");",
    to: "  const section = yearsIn(`${row.sectionPath ?? \"\"} ${(row as { content?: string }).content ?? \"\"}`);",
  },
  {
    name: "m2 경로 연도 중 최소값 채택 — `2023 시즌/…/2024년` 이 옛 시점으로 잡힌다(S1)",
    file: RETRIEVE,
    from: "  if (identity.length > 0) return Math.max(...identity);",
    to: "  if (identity.length > 0) return Math.min(...identity);",
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
    name: "m8 currentSeason 미주입에도 시점 다양성 적용 — 기본 거동이 바뀐다(S6)",
    file: RETRIEVE,
    from: "  return currentSeason === undefined\n    ? survivors.slice(0, RAG_EVIDENCE_LIMIT)\n    : pickWithSeasonDiversity(survivors, RAG_EVIDENCE_LIMIT, currentSeason, target);",
    to: "  return pickWithSeasonDiversity(survivors, RAG_EVIDENCE_LIMIT, currentSeason ?? 2026, target);",
  },
  {
    name: "m9 하류 전달 누락 — 랭커가 시즌을 영영 못 받는다(S7c)",
    file: RETRIEVE,
    from: "  return rankEvidenceByQuery(\n    deduped, queryVector, weightFor, project, currentSeason, target,\n  );",
    to: "  return rankEvidenceByQuery(deduped, queryVector, weightFor, project);",
  },
  {
    name: "m10 searchRag 배선 제거 — 프로덕션 경로만 조용히 종전으로 회귀(S7)",
    file: SERVER,
    from: "    seasonAware ? currentSeason : undefined,\n    seasonTarget,",
    to: "    undefined,\n    { kind: \"none\" },",
  },
  {
    name: "m11 now seam 을 고정 — 게이트가 경계 시각을 주입할 수 없다(S7b)",
    file: SERVER,
    from: "  now: () => number = Date.now,",
    to: "  _now?: undefined,",
  },

  // ── 삼순 2026-08-28 P0-① lane / P0-② target ──────────────────────────────
  {
    name: "m12 lane 계획 제거 — DB 절단 전 목표 시즌 확보가 사라진다(L-lane)",
    file: RETRIEVE,
    from: '  const lanes: Array<{ mode: SeasonLaneMode; year?: number }> = [\n'
      + '    { mode: "year", year: currentSeason },\n'
      + '    { mode: "yearless" },\n'
      + '    { mode: "any" },\n'
      + '  ];',
    to: '  const lanes: Array<{ mode: SeasonLaneMode; year?: number }> = [{ mode: "any" }];',
  },
  {
    name: "m13 general lane 제거 — 목표 연도에 답이 없으면 아무 답도 못 한다(L-lane)",
    file: RETRIEVE,
    from: '    { mode: "yearless" },\n    { mode: "any" },\n  ];',
    to: '    { mode: "yearless" },\n  ];',
  },
  {
    // 🔴 삼순 2026-08-29 6차 P0-1: 명시 연도를 **교체**로 되돌리는 변조.
    //   lane 개수는 그대로 3 개라 5차 게이트는 이걸 GREEN 으로 봤다 — 그래서 부분집합으로 바꿔 잡는다.
    name: "m12b 명시 연도가 올해 lane 을 교체 — `1999년 … 현재 감독` 에서 올해 근거가 사라진다(L1c/L2d)",
    file: RETRIEVE,
    from: '  const lanes: Array<{ mode: SeasonLaneMode; year?: number }> = [\n'
      + '    { mode: "year", year: currentSeason },',
    to: '  const lanes: Array<{ mode: SeasonLaneMode; year?: number }> = [\n'
      + '    { mode: "year", year: target.kind === "year" ? target.year : currentSeason },',
  },
  {
    // 🔴 삼순 6차 P0-3: lane 이 늘어도 호출은 소스당 1회여야 한다.
    name: "m12c lane 마다 따로 호출 — RPC 가 lane 수만큼 증폭된다(L2b2)",
    file: RETRIEVE,
    from: '      lanes === undefined\n'
      + '        ? fetchBySourceKind(sourceKind, RAG_CANDIDATE_LIMIT, queryVector)\n'
      + '        : fetchBySourceKind(sourceKind, RAG_CANDIDATE_LIMIT, queryVector, lanes)));',
    to: '      lanes === undefined\n'
      + '        ? fetchBySourceKind(sourceKind, RAG_CANDIDATE_LIMIT, queryVector)\n'
      + '        : Promise.all(lanes.map((lane) =>\n'
      + '            fetchBySourceKind(sourceKind, RAG_CANDIDATE_LIMIT, queryVector, [lane])))\n'
      + '            .then((chunks) => chunks.flat())));',
  },
  {
    name: "m14 lane 중복 제거 해제 — 같은 chunk 가 여러 근거로 중복된다(L-lane)",
    file: RETRIEVE,
    from: "    if (seen.has(key)) continue;",
    to: "    if (false) continue;",
  },
  {
    // 🔴 삼순 2026-08-29 5차 핵심: lane 비대칭이 곧 recall 소실이다.
    //   시점 판정이 lane 개수를 좌우하면, 오분류의 대가가 "가중이 흔들린다"가 아니라
    //   "목표 시즌 근거가 DB 절단 전에 통째로 사라진다"가 된다.
    name: "m15 lane 비대칭 부활 — 시점 오분류가 다시 recall 을 죽인다(L1c/L2d)",
    file: RETRIEVE,
    from: '  // 기본 lane — target 과 무관하게 항상 이 셋을 확보한다.',
    to: '  if (target.kind === "none") return [{ mode: "any" }];\n'
      + '  // 기본 lane — target 과 무관하게 항상 이 셋을 확보한다.',
  },
  {
    name: "m16 명시 연도를 무시 — `2018년 한화`가 목표 lane 을 잃는다(T-target)",
    file: RETRIEVE,
    from: '  return uniqueYears.length === 1 ? { kind: "year", year: uniqueYears[0] } : { kind: "none" };',
    to: '  return { kind: "none" };',
  },
  {
    // 🔴 어휘 목록으로 시점을 맞히려는 시도 자체를 금지한다(룰 핑퐁 재시작 방지).
    //   `현재` 를 current 로 보는 순간 `현재 한화 감독 경질 가능성?` 이 다시 흔들리고,
    //   막으려 과거 어휘를 넣으면 `김성근 감독이 맡았던 한화` 가 반대로 샌다.
    name: "m17 시점 어휘 판정 부활 — 룰 핑퐁이 재시작된다(T1z/T1y)",
    file: RETRIEVE,
    from: '  const uniqueYears = [...new Set(years)];\n  void nowSeason;',
    to: '  const uniqueYears = [...new Set(years)];\n'
      + '  const CURRENT_SCOPE_WORDS = ["현재", "지금", "감독"];\n'
      + '  if (CURRENT_SCOPE_WORDS.some((w) => normalized.includes(w))) return { kind: "year", year: nowSeason };\n'
      + '  void nowSeason;',
  },
  {
    // 🔴 시점 다양성 예약이 없으면, 과거 시즌 문서가 유사도 상위를 독점할 때
    //   올해 문서가 근거에 **아예 도달하지 못한다**(실측에서 관찰된 그 상황).
    name: "m19 시점 다양성 예약 제거 — 올해 문서가 절단으로 사라진다(S5c2)",
    file: RETRIEVE,
    from: '  wanted.push(currentSeason, null);',
    to: '  wanted.push(null);',
  },
  {
    name: "m20 무연도 예약 제거 — 역대표·등번호 문서가 근거에서 밀린다(S5c3)",
    file: RETRIEVE,
    from: '  wanted.push(currentSeason, null);',
    to: '  wanted.push(currentSeason);',
  },
  {
    // 🔴 삼순 2026-08-29 6차 P0-2: 명시 연도 예약을 빼면 질문이 콕 집은 해가
    //   최종 근거에서 사라진다(sanitize 뒤 보충 경로가 없다).
    name: "m19b 명시 연도 예약 제거 — 유저가 콕 집은 해가 근거에서 빠진다(D-target)",
    file: RETRIEVE,
    from: '  if (target.kind === "year" && target.year !== currentSeason) wanted.push(target.year);',
    to: '  void target;',
  },
  {
    // 예약이 순위를 조작하면 그건 다시 hard sort 다 — 포함만 보장해야 한다.
    name: "m21 예약을 맨 앞으로 당김 — 포함 보장이 순위 조작이 된다(S5c5)",
    file: RETRIEVE,
    from: '  return [...chosen].sort((a, b) => a - b).slice(0, limit).map((i) => ranked[i]);',
    to: '  const reservedFirst = [...chosen];\n'
      + '  const rest = [...chosen].sort((a, b) => a - b).filter((i) => !reservedFirst.includes(i));\n'
      + '  return [...reservedFirst, ...rest].slice(0, limit).map((i) => ranked[i]);',
  },
  {
    // 🔴 삼순 7차 P0-2: sanitize 를 cap **뒤**로 되돌리는 회귀.
    //   예약행이 selectEvidence 에서 탈락해도 rank7+ 를 보충할 경로가 없어진다.
    //   D2b/P1 이 잡아야 한다 — 안 잡히면 다음 사람이 조용히 되돌릴 수 있다.
    name: "m22 sanitize 를 cap 뒤로 되돌림 — 예약행이 하류에서 탈락하면 보충이 없다(D2b/P1)",
    file: RETRIEVE,
    from: "  const projector: EvidenceProjector = project\n"
      + "    ?? ((row) => sanitizeEvidenceContent(row.content, row));",
    to: "  const projector: EvidenceProjector = project ?? ((row) => row.content);",
  },
  {
    // 🔴 삼순 7차 P0-3: lane 마다 따로 fallback → 오버로드 부재 시 호출 2배.
    name: "m23 PGRST202 fallback 을 lane 마다 재시도 — 호출이 lane 수만큼 튄다(P3c)",
    file: SERVER,
    from: "        const failed = results.find((result) => result.error);",
    to: "        let failed = results.find((result) => result.error);\n"
      + "        for (const lane of planned) {\n"
      + "          if (!failed) break;\n"
      + "          void lane;\n"
      + "          const retry = await client.rpc(RAG_PLAYER_CHUNK_SEARCH_RPC, baseArgs);\n"
      + "          if (!retry.error) failed = undefined;\n"
      + "        }\n"
      + "        failed = results.find((result) => result.error);",
  },
  {
    // 🔴 삼순 7차 P0-3: lane 조회를 직렬화 → 지연이 lane 수에 비례한다.
    name: "m24 lane 조회를 직렬화 — 지연이 lane 수에 비례한다(P3f)",
    file: SERVER,
    from: "        const results = await Promise.all(planned.map((lane) =>",
    to: "        const results = await planned.reduce(async (acc, lane) => {\n"
      + "          const prev = await acc;\n"
      + "          return [...prev, await ((l) =>",
  },
  {
    // 🔴 삼순 7차 P0-3: 예산 clamp 제거 → lane 이 늘면 호출이 그대로 늘어난다.
    name: "m25 호출 예산 clamp 제거 — lane 수만큼 RPC 가 무제한 증가(P3/P3b)",
    file: SERVER,
    from: "      const planned = (lanes ?? []).slice(0, RAG_MAX_RPC_PER_SOURCE - 1);",
    to: "      const planned = [...(lanes ?? []), ...(lanes ?? [])];",
  },
  {
    name: "m18 선수 경로에도 시즌 축 적용 — 전제(연도 분할 문서)가 없는 곳에 개입(T-target)",
    file: SERVER,
    from: '  const seasonAware = candidate.entityType === "team";',
    to: "  const seasonAware = true;",
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
