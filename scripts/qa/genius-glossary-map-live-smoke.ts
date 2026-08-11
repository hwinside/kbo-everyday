/**
 * 사전 정의 질문 LLM 매핑 — 실 provider 게이트 (삼순 2026-08-11 NO-GO ①축).
 *
 * mock 주입 smoke(qa:genius-glossary-map)와 분리해, **배포되는 그 함수**
 * (`server.ts mapGlossaryDefinition` — 그 프롬프트·그 요청 빌더·그 파서)로 실제 Gemini를
 * 호출해 판정을 실측한다. 후보 추출도 배포 함수(`glossaryCandidatesIn`)를 production
 * 사전(`baseball_terms` 실조회)에 태워 파이프라인과 같은 입력을 만든다.
 *
 * 계약:
 *  · 양성 반복: `유격수 포지션이 뭐야?`·`도루뜻` 이 3회 연속 해당 term 으로 매핑된다.
 *  · 반대편(삼순 열거 5건): 선수 기록·응용·비교·라인업 질문은 후보가 있어도 null —
 *    dictionary 로 서빙될 수 없다. (선수 결속 케이스는 파이프라인 가드가 이중 방어하지만
 *    provider 단독으로도 null 이어야 한다.)
 *  · 키가 없으면 조용한 SKIP 이 아니라 명시적 실패(exit 1).
 *
 * 실행: npm run qa:genius-glossary-map-live (네트워크·GEMINI_API_KEY·SUPABASE 필요, prebuild 밖)
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** 배포 env가 없을 때 로컬 .env.local에서만 주입한다(시크릿은 출력하지 않는다). */
function loadDotEnv(file: string) {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadDotEnv(resolve(process.cwd(), ".env.local"));

async function main() {
  assert.ok(process.env.GEMINI_API_KEY, "GEMINI_API_KEY 필요 — 이 게이트는 SKIP 하지 않는다");
  // env 주입 후에 로드해야 server.ts 모듈 초기화(supabase·GEMINI_URL)가 산다.
  const { mapGlossaryDefinition } = await import("../../src/lib/baseball-qa/server");
  const { glossaryCandidatesIn } = await import("../../src/lib/baseball-qa/pipeline");
  const { createClient } = await import("@supabase/supabase-js");

  // production 사전 실조회 — 후보는 파이프라인과 동일한 배포 추출 함수로 만든다.
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  // query-guard: bounded -- 검수 사전은 ~140행, 상한 500
  const { data: rows, error } = await supabase
    .from("baseball_terms")
    .select("term, aliases, answer")
    .limit(500);
  assert.ok(!error && rows && rows.length >= 100, `사전 로드 실패: ${error?.message ?? rows?.length}`);
  const glossary = rows!.map((r) => ({
    term: r.term as string,
    aliases: (r.aliases ?? []) as string[],
    answer: r.answer as string,
  }));

  const run = async (question: string) => {
    const candidates = glossaryCandidatesIn(glossary, question).map((c) => c.term);
    // 후보 0 = 파이프라인이 매퍼를 아예 호출하지 않는다 — dictionary 서빙이 구조적으로 불가.
    if (candidates.length === 0) return { candidates, mapped: null, structurallyBlocked: true };
    // 일시적 오류만 bounded 재시도(3회) — 판정 결과는 재시도하지 않는다.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return {
          candidates,
          mapped: (await mapGlossaryDefinition(question, candidates)).term,
          structurallyBlocked: false,
        };
      } catch (e) {
        if (attempt === 2) throw e;
        await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
      }
    }
    throw new Error("unreachable");
  };

  let pass = 0;
  let fail = 0;
  const report = (ok: boolean, label: string) => {
    if (ok) { pass += 1; console.log(`PASS ${label}`); }
    else { fail += 1; console.log(`FAIL ${label}`); }
  };

  // ── 양성 반복 (3회 연속 같은 term) ──────────────────────────────────
  for (const [question, expected] of [
    ["유격수 포지션이 뭐야?", "유격수"],
    ["도루뜻", "도루"],
  ] as const) {
    for (let i = 1; i <= 3; i += 1) {
      const { mapped, structurallyBlocked } = await run(question);
      assert.ok(!structurallyBlocked, `양성 케이스인데 후보 0: ${question}`);
      report(mapped === expected, `[양성 ${i}/3] ${question} → ${mapped ?? "null"} (기대 ${expected})`);
    }
  }

  // ── 반대편 (삼순 열거): 후보가 있어도 정의 질문이 아니면 null ────────
  for (const question of [
    "김도영 포지션이 뭐야?",      // 선수 응용 — 사전 정의 아님
    "김도영 도루 몇 개야?",       // 선수 기록 수치
    "오늘 유격수 누구야?",         // 라인업 조회
    "보크하면 주자 몇 루 가?",     // 룰 응용 (정의 아님)
    "유격수와 2루수 차이가 뭐야?", // 비교 — 단일 정의 아님
  ]) {
    const { candidates, mapped, structurallyBlocked } = await run(question);
    const detail = structurallyBlocked
      ? "후보 0 → 매퍼 미호출(구조적 차단)"
      : `후보 ${candidates.join(",")} → ${mapped ?? "null"}`;
    report(mapped === null, `[반대] ${question} — ${detail}`);
  }

  console.log(`\n${pass} PASS / ${fail} FAIL`);
  if (fail > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
