#!/usr/bin/env node
/**
 * tier L(현재 시즌 정본) 주입 게이트의 **검증력 증명**.
 *
 * 계약: 원본을 in-memory 백업 → 결함 주입 → smoke 재실행 → 의도한 FAIL 마커가 나와야 RED.
 * 앵커 부재 = 러너 고장으로 MISS(조용한 skip 금지). 종료 시 무조건 원복.
 *
 * ⚠️ 왜 이게 필요한가 (2026-08-28 삼순 NO-GO): 1차 게이트의 L8 은 "호출 결속"이라고
 *   써놓고 실제로는 정규식 4개였다. `answerQuestion` 을 한 번도 안 태웠으므로 seam 이
 *   불리는지 증명한 적이 없다. selftest 통과는 아무것도 증명하지 않는다 —
 *   실제 결함을 주입해 RED 가 나야 그 축이 살아 있는 것이다(M90).
 *
 * 🔴 mutant 설계 원칙: **주입한 것이 실제 결함이어야 한다.**
 *   - 문자열이 아니라 구조로 잡고, 패치 미적용은 FAIL 로 올린다.
 *   - mutant 가 다른 mutant 의 복제가 아닌지 확인한다.
 *   - 픽스처가 경계를 실제로 걸치는지(무대가 없으면 mutation 은 무증상이다).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const TEAM_RECORD = "src/lib/baseball-qa/stats/team-record.ts";
const PIPELINE = "src/lib/baseball-qa/pipeline.ts";
const RETRIEVE = "src/lib/baseball-qa/rag/retrieve.ts";
const SMOKE = "scripts/qa/genius-live-team-block-smoke.ts";

const MUTATIONS = [
  // ── 원값 계약 ───────────────────────────────────────────────────────────
  {
    name: "m1 블록 값을 재포맷 — 앱 순위표와 갈라진다(L1b/L3)",
    file: TEAM_RECORD,
    from: "    lines.push(`${outcome.label}: ${outcome.value}`);",
    to: "    lines.push(`${outcome.label}: ${String(outcome.value).replace(/위$/, \"등\")}`);",
  },
  {
    name: "m2 구단명 누락 — 어느 팀 상황인지 사라진다(L1b)",
    file: TEAM_RECORD,
    from: "      `${canonicalTeam} — ${provenance.expectedSeason} 시즌 기준 (관측 ${observedKst}, 출처 KBO 순위표·팀기록)`,",
    to: "      `${provenance.expectedSeason} 시즌 기준 (관측 ${observedKst})`,",
  },

  // ── fail-close 축 ──────────────────────────────────────────────────────
  {
    name: "m3 순위 부재에도 블록 생성 — 반쪽 블록으로 현재를 주장한다(L2)",
    file: TEAM_RECORD,
    from: "  if (rankOutcome.kind !== \"ok\") return { kind: \"skip\", reason: \"no_ranking\" };",
    to: "  if (rankOutcome.kind !== \"ok\" && false) return { kind: \"skip\", reason: \"no_ranking\" };",
  },
  {
    name: "m4 TTL 무력화 — 만료 캐시를 '오늘'로 말한다(L9 freshness)",
    file: TEAM_RECORD,
    from: "  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > provenance.maxAgeMs) {\n    return { kind: \"skip\", reason: \"stale\" };\n  }",
    to: "  if (!Number.isFinite(ageMs)) {\n    return { kind: \"skip\", reason: \"stale\" };\n  }",
  },
  {
    name: "m5 시즌 결속 해제 — 작년 팀기록을 올해로 말한다(L9 season)",
    file: TEAM_RECORD,
    from: "  if (usesRecords && records.season !== provenance.expectedSeason) {\n    return { kind: \"skip\", reason: \"season_mismatch\" };\n  }",
    to: "  if (false) {\n    return { kind: \"skip\", reason: \"season_mismatch\" };\n  }",
  },
  {
    name: "m6 TTL 상한을 env 로 열어둠 — 계약을 런타임이 무를 수 있다(L9 상수 고정)",
    file: TEAM_RECORD,
    from: "export const LIVE_TEAM_BLOCK_MAX_AGE_MS = 45 * 60 * 1000;",
    to: "export const LIVE_TEAM_BLOCK_MAX_AGE_MS = Number(process.env.LIVE_TEAM_MAX_AGE_MS ?? 45 * 60 * 1000);",
  },

  // ── 선택 주입 축 (삼순 착수 조건 ③) ────────────────────────────────────
  {
    name: "m7 scope 무시하고 전량 주입 — 응원가 질문에 순위표가 붙는다(L10)",
    file: PIPELINE,
    from: "  const scope = resolveLiveTeamScope(question);\n  if (scope === \"none\") return null;",
    to: "  const scope = resolveLiveTeamScope(question) === \"none\" ? \"standing\" : resolveLiveTeamScope(question);",
  },
  {
    name: "m8 잔여 경기 산출 제거 — 가을야구 질문이 근거를 잃는다(L11)",
    file: TEAM_RECORD,
    from: "      lines.push(`잔여 경기: ${KBO_REGULAR_SEASON_GAMES - played}`);",
    to: "      void played;",
  },

  // ── 배선 종단 축 (삼순 P0: L8 이 정규식이었다) ─────────────────────────
  {
    name: "m9 seam 호출 제거 — 블록이 절대 주입되지 않는다(L8 종단)",
    file: PIPELINE,
    from: "    const liveTeamBlock = await buildLiveTeamBlockForCandidate(teamRagCandidate.name, question, deps);",
    to: "    const liveTeamBlock: string | null = null;\n    void buildLiveTeamBlockForCandidate;",
  },
  {
    name: "m10 extras 전달 누락 — seam 은 돌지만 LLM 은 못 본다(L8 종단)",
    file: PIPELINE,
    from: "        liveTeamBlock: liveTeamBlock ?? undefined,\n",
    to: "",
  },
  {
    name: "m11 조회 실패가 경로를 막음 — 순위 API 장애로 구단 질문이 통째로 죽는다(L12)",
    file: PIPELINE,
    from: "  } catch {\n    // 조회 실패는 블록 미설정이지 경로 차단이 아니다(위 주석).\n    return null;\n  }",
    to: "  } catch (error) {\n    throw error;\n  }",
  },

  // ── 요청 조립 / 인젝션 경계 ────────────────────────────────────────────
  {
    name: "m12 블록을 systemInstruction 으로 승격 — 데이터가 지시가 된다(L5c)",
    file: RETRIEVE,
    from: "  return {\n    systemInstruction: { parts: [{ text: extras.definition ? `${systemPrompt}\\n${STAT_DEFINITION_PROMPT}` : systemPrompt }] },",
    to: "  return {\n    systemInstruction: { parts: [{ text: `${extras.definition ? `${systemPrompt}\\n${STAT_DEFINITION_PROMPT}` : systemPrompt}\\n${extras.liveTeamBlock ?? \"\"}` }] },",
  },
  {
    name: "m13 extras 소비 제거 — 블록이 요청에 실리지 않는다(L5/L6b)",
    file: RETRIEVE,
    from: "  if (extras.liveTeamBlock) {\n    sections.push(",
    to: "  if (false && extras.liveTeamBlock) {\n    sections.push(",
  },

  // ── 프롬프트 계약 ──────────────────────────────────────────────────────
  {
    name: "m14 시점 계약 문장 제거 — 과거를 현재로 단정하는 원래 결함으로 회귀(L4)",
    file: RETRIEVE,
    from: "  \"자료로는 현재 상태를 단정하지 않는다. 순위·감독·코치진·선발로테이션·포스트시즌 진출 여부처럼 시간에 따라 변하는 것은 자료에 적혀 있어도 과거로 서술한다(‘…했습니다’·‘과거에는 …’).\",",
    to: "",
  },
  {
    name: "m15 '현재 확인 불가' 계약 제거 — 정본 없는 현재 질문에 과거 답을 내놓는다(L4)",
    file: RETRIEVE,
    from: "  \"유저가 현재를 물었는데 <현재 시즌 상황> 블록에도 그 항목이 없고 ‘현재성: 최신’ 자료도 없으면, 자료의 과거 내용을 답으로 내놓지 않는다. 현재는 확인해 드리기 어렵다고 먼저 밝힌 뒤, 자료로 아는 범위를 과거 맥락임을 명시해 덧붙인다.\",",
    to: "",
  },
  {
    name: "m16 블록 숫자 전재 허용 — tier2 숫자 HOLD 와 프롬프트가 어긋난다(L4/L7)",
    file: RETRIEVE,
    from: "  \"단 블록의 숫자를 답변에 옮기지는 않는다. 숫자 없이 서술하거나(예: 상위권에 있습니다) 순위표를 보라고 안내한다.\",",
    to: "  \"블록의 숫자를 그대로 답변에 옮겨 쓴다.\",",
  },
];

const files = [...new Set(MUTATIONS.map((m) => m.file))];
const originals = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));
const restore = () => { for (const [f, s] of originals) writeFileSync(f, s); };
process.on("exit", restore);
process.on("SIGINT", () => { restore(); process.exit(130); });

/** smoke 를 돌려 RED 인지 본다. 실행 자체가 실패해도 RED(비정상 종료 = 계약 위반 검출). */
function smokeIsRed() {
  try {
    const out = execSync(`npx tsx ${SMOKE}`, { encoding: "utf8", stdio: "pipe" });
    return { red: /^RED/m.test(out) || /FAIL /.test(out), out };
  } catch (error) {
    const out = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    return { red: true, out };
  }
}

let detected = 0;
let missed = 0;

// ── baseline: 변조 전에는 반드시 GREEN 이어야 한다 ───────────────────────
//    baseline RED 면 이후 모든 mutant 가 "검출된 것처럼" 보인다(가짜 100%).
const base = smokeIsRed();
if (base.red) {
  console.error("BASELINE RED — 변조 전 게이트가 이미 실패한다. mutation 결과는 무의미하다.");
  console.error(base.out.split("\n").filter((l) => /FAIL|Error/.test(l)).slice(0, 10).join("\n"));
  process.exit(1);
}
console.log("BASELINE GREEN\n");

for (const mutation of MUTATIONS) {
  const original = originals.get(mutation.file);
  if (!original.includes(mutation.from)) {
    // 🔴 앵커 부재는 skip 이 아니라 실패다 — 러너가 조용히 아무것도 안 하는 상태.
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
