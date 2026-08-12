#!/usr/bin/env node
/**
 * `baseball-qa-career-metrics` 게이트의 **검출력 증명**.
 *
 * 각 축을 실제로 망가뜨렸을 때 게이트가 RED 가 되는지 확인한다. RED 가 안 나오면 그 축은
 * 게이트가 아니라 장식이다. 오늘(2026-08-12) 만 false RED·MISS 를 여러 번 실측했으므로
 * 규칙을 명시한다:
 *   - 컴파일 오류는 "검출 성공"으로 세지 않는다(게이트가 FAIL 을 보고할 때만 RED).
 *   - 앵커가 소스에 없으면 MISS 로 **실패 처리**한다(조용히 통과시키면 러너가 고장난 것이다).
 *   - 파일 복원은 `git checkout` 이 아니라 백업 복사다(P0 — 다른 세션 변경 보호).
 */
import { readFileSync, writeFileSync, copyFileSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const CATALOG = "src/lib/baseball-qa/stats/career-metric-catalog.ts";
const LEADERBOARD = "src/lib/baseball-qa/stats/career-metric-leaderboard.ts";
const PIPELINE = "src/lib/baseball-qa/pipeline.ts";
const SERVED = "src/lib/baseball-qa/stats/served-record.ts";
const SMOKE = "scripts/qa/baseball-qa-career-metrics-smoke.ts";

const MUTATIONS = [
  // ── 값 정확성 ──
  {
    name: "m1 증분을 더하지 않는다 — 2025년 말 값을 현재 통산이라고 답한다",
    file: LEADERBOARD,
    from: "    const delta = current == null ? 0 : (current[spec.currentField] as number);",
    to: "    const delta = 0;",
  },
  {
    name: "m2 기준선을 빼고 당해 시즌만 답한다",
    file: LEADERBOARD,
    from: "      total: baseline + delta,",
    to: "      total: delta,",
  },
  {
    name: "m3 정렬을 오름차순으로 뒤집는다 — 꼴찌가 1위가 된다",
    file: LEADERBOARD,
    from: "  merged.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, \"ko\"));",
    to: "  merged.sort((a, b) => a.total - b.total || a.name.localeCompare(b.name, \"ko\"));",
  },
  {
    name: "m4 서빙 행의 지표 필드를 다른 지표로 바꿔 읽는다 (currentField 오결속)",
    file: LEADERBOARD,
    from: "    const raw = row[spec.currentField];",
    to: "    const raw = row[\"games\"];",
  },
  // ── fail-close ──
  {
    name: "m5 stale 가드 제거 — 낡은 스냅샷으로도 답한다",
    file: LEADERBOARD,
    from: "  if (now.getTime() - updatedMs > STATS_STALE_MS || updatedMs > now.getTime() + 5 * 60_000) return null;",
    to: "  void STATS_STALE_MS;",
  },
  {
    name: "m6 identity 대조 제거 — 다른 선수의 시즌 기록을 통산에 더한다",
    file: LEADERBOARD,
    from: "    if (current && current.name !== base.name) return null;",
    to: "",
  },
  {
    name: "m7 서빙 행 원타입 검증 제거 — 문자열 값도 통과시킨다",
    file: LEADERBOARD,
    from: "    if (raw === undefined || raw === null || typeof raw !== \"number\" || !Number.isInteger(raw) || raw < 0) {\n      return null;\n    }",
    to: "    if (raw === undefined || raw === null) return null;",
  },
  {
    name: "m8 중복 kboId 가드 제거 — 같은 선수를 두 번 세도 통과한다",
    file: LEADERBOARD,
    from: "    if (!id || currentById.has(id)) return null;",
    to: "    if (!id) continue;",
  },
  {
    name: "m10 순위 구간 상한 제거 — 임의 구간 요청이 통과한다",
    file: LEADERBOARD,
    from: "  if (query.from < 1 || query.to < query.from || query.to > CAREER_RANK_MAX) return null;",
    to: "",
  },
  {
    name: "m11b immutable rowCount manifest 훼손 — 절단본 완전성 계약 소실",
    file: LEADERBOARD,
    from: "  rowCount: { batter: 2659, pitcher: 1764 },",
    to: "  rowCount: { batter: 100, pitcher: 100 },",
  },
  {
    name: "m11c 스냅샷 sha256 검증 제거 — payload 절단·변조 통과",
    file: LEADERBOARD,
    from: "  if (createHash(\"sha256\").update(JSON.stringify(unsigned)).digest(\"hex\") !== sha256) return false;",
    to: "  void unsigned;",
  },
  {
    name: "m11d 투수 current exact 우주를 옛 행수 하한으로 후퇴 — 리더 누락 통과",
    file: SERVED,
    from: "  const expectedIds = new Set(FULL_ENTRY_PITCHER_IDS);\n  if (rows.length !== expectedIds.size) return null;\n  const seen = new Set<string>();\n  for (const row of rows) {\n    const id = canonicalKboId(row.kboId as string | number | null);\n    if (!id || !expectedIds.has(id) || seen.has(id)) return null;\n    seen.add(id);\n  }\n  if (FULL_ENTRY_PITCHER_IDS.some((id) => !seen.has(id))) return null;",
    to: "  if (rows.length < 200) return null;\n  const seen = new Set<string>();\n  for (const row of rows) {\n    const id = canonicalKboId(row.kboId as string | number | null);\n    if (!id || seen.has(id)) return null;\n    seen.add(id);\n  }",
  },
  // ── 질문 해석(룰 누적 방지 축) ──
  {
    name: "m12 지표 alias 모호성 fail-close 제거 — `통산 삼진 1위` 를 임의로 한쪽으로 단정한다",
    file: LEADERBOARD,
    from: "  if (ids.size !== 1) return null;",
    to: "",
  },
  {
    name: "m13 전체 문자열 앵커 제거 — 복수절 질문의 앞 절만 먹는다(#1159 4차 회귀)",
    file: LEADERBOARD,
    from: "    const explicitFirst = new RegExp(`^${temporal}${alias}(?:기록)?1위(?:는|가|를)?${who}$`);",
    to: "    const explicitFirst = new RegExp(`${temporal}${alias}(?:기록)?1위`);",
  },
  {
    name: "m15 카탈로그에서 지표 1개 삭제 — 스냅샷과 어긋난다",
    file: CATALOG,
    from: "  { key: \"rbi\", column: \"RBI\", currentField: \"rbi\", label: \"타점\", unit: \"타점\", aliases: [\"타점\", \"rbi\"] },\n",
    to: "",
  },
  {
    name: "m16 카탈로그의 currentField 오타 — 증분을 못 찾아 기준선만 답한다",
    file: CATALOG,
    from: "  { key: \"hr\", column: \"HR\", currentField: \"hr\", label: \"홈런\", unit: \"개\", aliases: [\"홈런\", \"홈런수\", \"hr\"] },",
    to: "  { key: \"hr\", column: \"HR\", currentField: \"homeruns\", label: \"홈런\", unit: \"개\", aliases: [\"홈런\", \"홈런수\", \"hr\"] },",
  },
  {
    name: "m16b 충돌 지표의 명시 alias 제거 — 카탈로그 행이 영구 미도달",
    file: CATALOG,
    from: "aliases: [\"볼넷\", \"타자볼넷\"]",
    to: "aliases: [\"볼넷\"]",
  },
  // ── 파이프라인 배선 ──
  {
    name: "m17 라우팅 선결속 제거 — 지원 지표가 hold 로 삼켜진다(#1159/#1164 회귀)",
    file: PIPELINE,
    from: "    if (resolveCareerMetricIntent(question)) return \"career_leaderboard\";",
    to: "",
  },
  {
    name: "m18 종단에서 fetcher 결과 null 검사 제거 — 조회 실패가 예외로 샌다",
    file: PIPELINE,
    from: "      if (!result) return settleCareerLeaderboard(resolveHoldAnswer(question), \"history_hold\");",
    to: "",
  },
  {
    name: "m19 hold 가드의 지원 intent 예외 제거 — 확장 지표가 다시 hold 로 죽는다",
    file: PIPELINE,
    from: "    && resolveCareerMetricIntent(question) === null",
    to: "",
  },
];

function run() {
  let red = 0;
  const bad = [];
  for (const mutation of MUTATIONS) {
    const abs = path.join(REPO_ROOT, mutation.file);
    const backup = `${abs}.mutation-backup`;
    const before = readFileSync(abs, "utf-8");
    if (!before.includes(mutation.from)) {
      bad.push(`MISS ${mutation.name} — 앵커 부재 (러너 고장)`);
      console.log(`MISS ${mutation.name} — 앵커 부재 (러너 고장)`);
      continue;
    }
    copyFileSync(abs, backup);
    try {
      writeFileSync(abs, before.replace(mutation.from, mutation.to));
      let detected = false;
      let compileError = false;
      try {
        execFileSync("npx", ["tsx", SMOKE], { cwd: REPO_ROOT, stdio: "pipe", encoding: "utf-8" });
      } catch (error) {
        const out = `${error.stdout ?? ""}${error.stderr ?? ""}`;
        // 컴파일/로드 실패는 "게이트가 잡았다"가 아니다 — 그렇게 세면 오탐이 RED 로 둔갑한다.
        compileError = /error TS|SyntaxError|Cannot find|is not defined|Unexpected/.test(out)
          && !/FAIL /.test(out);
        detected = /FAIL /.test(out);
      }
      if (detected) { red += 1; console.log(`RED  ${mutation.name}`); }
      else if (compileError) { bad.push(`COMPILE ${mutation.name}`); console.log(`COMPILE ${mutation.name} — 검출로 세지 않음`); }
      else { bad.push(`GREEN ${mutation.name}`); console.log(`GREEN ${mutation.name} — 게이트가 못 잡는다`); }
    } finally {
      copyFileSync(backup, abs);
      unlinkSync(backup);
    }
  }
  console.log(`\nmutations: ${red}/${MUTATIONS.length} RED`);
  if (bad.length > 0) { bad.forEach((b) => console.log(`  ${b}`)); process.exit(1); }
}

run();
