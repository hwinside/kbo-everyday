#!/usr/bin/env node
/**
 * `qa:genius-untrusted-metric` **검출력 증명** — 실제 배포 소스를 한 축씩 훼손하고
 * 게이트가 RED 인지 확인한 뒤 반드시 원복한다 (2026-09-04).
 *
 * ⚠️ 계약 4가지 (M90 `게이트를 쓴 직후 4개를 스스로 묻는다`):
 *   ① 각 mutation 은 **실제 RED 를 낼 수 있는 경로**를 훼손한다.
 *   ② 판정 키는 실패 줄에만 나오는 안정 ID `[UMV-FAIL]` 이다 — 통과 출력(✅)과 안 겹친다.
 *   ③ **패치 미적용은 PASS 가 아니라 FAIL** 이다(anchor MISS = 검증력 0).
 *   ④ 태우는 경로는 게이트가 실제로 import 하는 production seam 이다(사본 없음).
 *
 * ⚠️ mutant 동치 확인: M1(값요구 술어 무력화)과 M2(bare query 축 제거)는 **다른 축**이다 —
 *   M1 은 `몇 개야?` 를, M2 는 `김도영 희생번트` 를 각각 놓친다. M3(양보 제거)는
 *   반대 방향(종전 회귀)이고, M4(정의 술어 무시)는 삼순이 지적한 **합집합 오류**를
 *   그대로 재현한다 — 넷 다 다른 실패 줄을 낸다.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const SEASON = "src/lib/baseball-qa/stats/season-record.ts";
const PIPELINE = "src/lib/baseball-qa/pipeline.ts";
const TARGETS = [SEASON, PIPELINE];

const originals = new Map(TARGETS.map((f) => [f, fs.readFileSync(f, "utf8")]));
const restore = () => {
  for (const [f, src] of originals) fs.writeFileSync(f, src);
};
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { restore(); process.exit(130); });
}

/**
 * mutation 은 **구조/정규식**으로 재타깃한다 — 문자열 정확일치는 주석 한 글자만 바뀌어도
 * 조용히 no-op 이 되고 mutant==원본 이라 false-GREEN 이 난다.
 */
const MUTATIONS = [
  {
    name: "M1 명시적 값 요구 술어 무력화",
    why: "`몇 개야?` 를 못 잡으면 값 요구가 사전으로 새어 위키 숫자가 정본인 척 나간다",
    file: SEASON,
    re: /  if \(UNTRUSTED_EXPLICIT_QUANTITY\.test\(spaced\)\) return true;/,
    to: "  if (false) return true; // [mutant M1]",
  },
  {
    name: "M2 선수+지표 bare query 축 제거",
    why: "`김도영 희생번트`(의문사 없음)를 놓치면 값 요구가 차단을 빠져나간다",
    file: SEASON,
    re: /  return playerBound;\n\}/,
    to: "  return false; // [mutant M2] bare query 축 제거\n}",
  },
  {
    name: "M11 카운트 명사 문법 → 명사 단독 판정 (1차 결함 복원)",
    why: "`수는`·`기록` 이 글자만으로 값 요구가 되면 정의 질문이 다시 막힌다",
    file: SEASON,
    re: /  if \(UNTRUSTED_COUNT_NOUN\.test\(spaced\) && UNTRUSTED_COUNT_VALUE_PREDICATE\.test\(spaced\)\) \{/,
    to: "  if (UNTRUSTED_COUNT_NOUN.test(spaced)) { // [mutant M11]",
  },
  {
    name: "M12 카운트 명사 값 술어 제거",
    why: "`기록이 뭐야?` 가 값 요구로 안 잡혀 사전으로 샌다(삼순 2차 NO-GO 반대 방향)",
    file: SEASON,
    re: /  if \(UNTRUSTED_COUNT_NOUN\.test\(spaced\) && UNTRUSTED_COUNT_VALUE_PREDICATE\.test\(spaced\)\) \{\n    return true;\n  \}/,
    to: "  // [mutant M12] 카운트 명사+술어 축 제거",
  },
  {
    name: "M3 양보 제거 (종전 결함 복원)",
    why: "지표어만 있으면 차단하던 원래 결함 — 정의 질문 8/8 이 다시 죽는다",
    re: /    if \(untrustedValueAsk\(question, options\?\.playerBound === true\)\) \{\n      return \{ kind: "untrusted_metric" \};\n    \}\n(\s*)\/\/[^\n]*\n\s*return \{ kind: "none" \};/,
    file: SEASON,
    to: '    return { kind: "untrusted_metric" }; // [mutant M3]',
  },
  {
    name: "M4 정의 술어 무시 (삼순이 지적한 합집합 오류)",
    why: "선수명만으로 값 요구로 보면 `김도영 희생번트가 뭐야?` 가 다시 차단된다",
    file: SEASON,
    re: /  if \(UNTRUSTED_DEFINITION_ASK\.test\(spaced\)\) return false;/,
    to: "  // [mutant M4] 정의 술어 무시 — 선수 결속만으로 값 요구로 읽는 합집합 오류",
  },
  {
    name: "M5 단일 진입점의 결속 계산 무력화",
    why: "공용 술어가 멀쩡해도 진입점이 결속 사실을 안 넘기면 bare query 축이 죽는다(wiring 도 계약이다)",
    file: PIPELINE,
    re: /  const playerBound = forcePlayerBound === true \|\| mentionsAnyRosterName\(question, players\);/,
    to: "  const playerBound = false; // [mutant M5]",
  },
  {
    name: "M6 확정 경로의 forcePlayerBound 누락",
    why: "선수가 확정된 경로에서 결속을 안 넘기면 `김도영 희생번트` 가 이름 재매칭에만 기대게 된다",
    file: PIPELINE,
    re: /  const playerBound = forcePlayerBound === true \|\| mentionsAnyRosterName\(question, players\);/,
    to: "  const playerBound = mentionsAnyRosterName(question, players); // [mutant M6]",
  },

  // ── 삼순 2026-09-04 2차 NO-GO: **호출부 bypass** ────────────────────────────
  //
  // 🔴 M5/M6 는 공용 wrapper **내부**만 훼손한다. 그래서 호출부가 wrapper 를 통째로
  //   우회해도 GREEN 이었다 — 실제로 `answerSeasonRecordQuestion` 의 fallback 이
  //   결속 없이 `resolveSeasonRecordIntent(question)` 를 부르고 있었고, 이 mutation 을
  //   설계하다가 그 우회를 발견했다(코드도 같이 고침). 배선은 계약의 일부다.
  {
    name: "M7 호출부 ①(선수 확정 전)이 wrapper 우회",
    why: "wrapper 가 멀쩡해도 호출부가 결속 없는 원함수를 부르면 bare query 축이 죽는다",
    file: PIPELINE,
    re: /    \? resolveSeasonRecordIntentFor\(question, players\)/,
    to: "    ? resolveSeasonRecordIntent(question) // [mutant M7]",
  },
  {
    name: "M8 호출부 ②(선수 확정 후)가 wrapper 우회",
    why: "확정 경로가 원함수를 직접 부르면 forcePlayerBound 가 통째로 사라진다",
    file: PIPELINE,
    re: /      const boundIntent = resolveSeasonRecordIntentFor\(question, players, preferredTable, true\);/,
    to: "      const boundIntent = resolveSeasonRecordIntent(question, preferredTable); // [mutant M8]",
  },
  {
    name: "M9 answerSeasonRecordQuestion fallback 결속 누락",
    why: "override 없이 들어오는 경로가 결속을 빠뜨리면 종단에서 다른 판정이 난다(실제로 그러했다)",
    file: PIPELINE,
    re: /  const intent = intentOverride\n    \?\? resolveSeasonRecordIntent\(question, undefined, \{ playerBound: true \}\);/,
    to: "  const intent = intentOverride ?? resolveSeasonRecordIntent(question); // [mutant M9]",
  },
];

/** 게이트를 돌려 통과 여부를 본다. 통과=true. */
function gatePasses() {
  const r = spawnSync("npx", ["tsx", "scripts/qa/genius-untrusted-metric-value-ask.ts"], {
    encoding: "utf8",
  });
  return r.status === 0;
}

/** 실패 출력에 안정 ID 가 실제로 들어있는지 — 판정 키가 살아있는지 확인한다. */
function gateFailureMentionsId() {
  const r = spawnSync("npx", ["tsx", "scripts/qa/genius-untrusted-metric-value-ask.ts"], {
    encoding: "utf8",
  });
  return `${r.stdout ?? ""}${r.stderr ?? ""}`.includes("[UMV-FAIL]");
}

function main() {
  // 🔴 기준선부터. baseline 이 RED 면 mutant 결과는 아무 뜻이 없다.
  process.stdout.write("[baseline] 게이트 확인 중...\n");
  if (!gatePasses()) {
    console.error("❌ baseline 이 이미 FAIL — mutant 판정 불가(fail-close)");
    process.exit(1);
  }
  console.log("✅ baseline GREEN\n");

  let survived = 0;
  let unapplied = 0;

  for (const m of MUTATIONS) {
    const original = originals.get(m.file);
    if (!m.re.test(original)) {
      // 🔴 패턴 불일치는 skip 이 아니라 FAIL — 검사기가 낡았다는 신호다.
      console.error(`❌ ${m.name}: 앵커를 소스에서 찾지 못했다 (${m.file}) — mutant 미적용`);
      unapplied += 1;
      continue;
    }
    try {
      fs.writeFileSync(m.file, original.replace(m.re, m.to));
      const passed = gatePasses();
      if (passed) {
        console.error(`❌ ${m.name}: mutant 가 살아남았다 — 이 축은 검사되지 않는다`);
        console.error(`   ${m.why}`);
        survived += 1;
      } else if (!gateFailureMentionsId()) {
        // 죽긴 죽었는데 판정 키가 안 보이면, 계약 위반이 아니라 크래시일 수 있다.
        console.error(`❌ ${m.name}: RED 이지만 [UMV-FAIL] 이 없다 — 계약 위반이 아니라 크래시 의심`);
        survived += 1;
      } else {
        console.log(`✅ ${m.name}: RED`);
      }
    } finally {
      fs.writeFileSync(m.file, original);
    }
  }

  // 복원 확인 — 게이트가 워크트리를 더럽힌 채 끝나면 다음 런이 오염된다.
  if (!gatePasses()) {
    console.error("\n❌ 복원 후 baseline 이 RED — 원본 복원 실패(워크트리 오염)");
    process.exit(1);
  }

  const total = MUTATIONS.length;
  if (survived > 0 || unapplied > 0) {
    console.error(`\n❌ untrusted-metric mutations FAIL — 생존 ${survived} · 미적용 ${unapplied} / ${total}`);
    process.exit(1);
  }
  console.log(`\n✅ untrusted-metric mutations: ${total}/${total} 검출 (복원 후 baseline GREEN 재확인)`);
}

main();
