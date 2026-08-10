#!/usr/bin/env node
/**
 * 리더보드 fail-close·denylist·길이 계약 + 한국시리즈 MVP 정본 축 mutation 러너.
 *
 * 계약: 원본을 in-memory 백업 후 결함 주입 → smoke 재실행 → FAIL 마커가 나와야 RED.
 * 앵커 부재 = 러너 고장으로 FAIL (조용한 skip 금지). 종료 시 무조건 원복.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const PIPELINE = "src/lib/baseball-qa/pipeline.ts";
const RETRIEVE = "src/lib/baseball-qa/rag/retrieve.ts";
const CONSTANTS = "src/lib/constants/baseball-genius.ts";
const PRIZE = "src/lib/baseball-qa/awards/series-prize.ts";

const MUTATIONS = [
  {
    name: "m1 리더보드 fail-close 제거 — generic LLM 위임 부활 (stale 이름 오답 통로)",
    file: PIPELINE,
    from: `if (hasStat && !hasTeam && !hasPlayerReference(tokens, players) && isCareerLeaderboardAsk(question)) {
    return "history_hold";
  }`,
    to: `if (hasStat && !hasTeam && !hasPlayerReference(tokens, players) && isCareerLeaderboardAsk(question)) {
    return "llm_scope_gate";
  }`,
    smoke: "scripts/qa/baseball-qa-leaderboard-smoke.ts",
  },
  {
    name: "m2 인물 축 denylist 복원 — 우승 기여자 질문이 다시 차단",
    file: PIPELINE,
    from: "const OUT_OF_SCOPE_INTENT =\n  /추천|",
    to: "const OUT_OF_SCOPE_INTENT =\n  /누구|추천|",
    smoke: "scripts/qa/baseball-qa-leaderboard-smoke.ts",
  },
  {
    name: "m3 구단 RAG 성의 지시 제거 — 한두 문장 강제 회귀",
    file: RETRIEVE,
    from: "단순 사실 확인은 한두 문장으로 짧게, 이유·배경·사연을 묻는 질문은 자료 안의 맥락을 두세 문장으로 충분히 설명한다. 자료에 없는 내용으로 길이를 채우지 않는다.",
    to: "답변은 한두 문장으로 짧게 서술한다.",
    smoke: "scripts/qa/baseball-qa-leaderboard-smoke.ts",
  },
  {
    name: "m4 tier2 상한 160 회귀",
    file: RETRIEVE,
    from: "export const RAG_ANSWER_MAX_CHARS = 320;",
    to: "export const RAG_ANSWER_MAX_CHARS = 160;",
    smoke: "scripts/qa/baseball-qa-leaderboard-smoke.ts",
  },
  {
    name: "m5 generic 상한 200 회귀",
    file: CONSTANTS,
    from: "export const BASEBALL_GENIUS_MAX_ANSWER_LENGTH = 320;",
    to: "export const BASEBALL_GENIUS_MAX_ANSWER_LENGTH = 200;",
    smoke: "scripts/qa/baseball-qa-leaderboard-smoke.ts",
  },
  {
    name: "s1 수상 페이지 신원 마커 검증 제거 — 에러 페이지로도 답한다",
    file: PRIZE,
    from: 'if (!html.includes(PAGE_MARKER) || !html.includes(HEADER_MARKER_ALLSTAR)) return null;',
    to: "",
    smoke: "scripts/qa/baseball-qa-series-prize-smoke.ts",
  },
  {
    name: "s2 연도 범위 검증 제거 — 오염 연도 통과",
    file: PRIZE,
    from: "if (year < KBO_FIRST_YEAR || year > now.getUTCFullYear() + 1) return null;",
    to: "",
    smoke: "scripts/qa/baseball-qa-series-prize-smoke.ts",
  },
  {
    name: "s3 미확정(`-`) 처리 제거 — 올해 질문에 과거 수상자 혼입",
    file: PRIZE,
    from: `if (ks.length === 3 && ks.every((v) => v === "-")) {
      rows.push({ year, koreanSeries: null });
      continue;
    }`,
    to: `if (ks.length === 3 && ks.every((v) => v === "-")) {
      continue;
    }`,
    smoke: "scripts/qa/baseball-qa-series-prize-smoke.ts",
  },
  {
    name: "s4 전제 정정 제거 — 틀린 우승팀 전제를 침묵 승인",
    file: PRIZE,
    from: `const premiseFix = mentionedTeam && mentionedTeam !== w.team
    ? \`\${year}년 한국시리즈 우승은 \${mentionedTeam}이(가) 아니라 \${w.team}이었어요. \`
    : "";`,
    to: 'const premiseFix = "";',
    smoke: "scripts/qa/baseball-qa-series-prize-smoke.ts",
  },
  {
    name: "s5 미배선 hold 제거 — generic LLM 폴백 부활 (원래 사고 재현)",
    file: PIPELINE,
    from: `if (!deps.fetchSeriesPrizeHtml) {
        return settlePrize(resolveHoldAnswer(question), "history_hold");
      }`,
    to: `if (!deps.fetchSeriesPrizeHtml) {
        // mutated: fall through to generic LLM
      } else if (false) {
        return settlePrize(resolveHoldAnswer(question), "history_hold");
      }
      if (deps.fetchSeriesPrizeHtml) {`,
    extraClose: true,
    smoke: "scripts/qa/baseball-qa-series-prize-smoke.ts",
  },
  {
    name: "s6 의도 판정 제거 — 캡처 질문이 정본을 우회해 LLM 으로",
    file: PRIZE,
    from: 'if (KS_MVP_DIRECT.test(normalized)) return "ks_mvp";',
    to: "",
    smoke: "scripts/qa/baseball-qa-series-prize-smoke.ts",
  },
];

let red = 0;
const misses = [];
for (const m of MUTATIONS) {
  const original = readFileSync(m.file, "utf8");
  if (!original.includes(m.from)) {
    console.log(`MISS ${m.name} — 앵커 부재 (러너 고장)`);
    misses.push(m.name);
    continue;
  }
  let mutated = original.replace(m.from, m.to);
  if (m.extraClose) {
    // s5: 조건 블록을 닫기 위해 settlePrize 마지막 return 뒤에 닫는 중괄호 추가
    mutated = mutated.replace(
      'return settlePrize(rendered.answer, rendered.grounded ? "kbo_structured" : "history_hold");',
      'return settlePrize(rendered.answer, rendered.grounded ? "kbo_structured" : "history_hold");\n      }',
    );
  }
  writeFileSync(m.file, mutated);
  let failed = false;
  try {
    execSync(`npx tsx ${m.smoke}`, { stdio: "pipe", timeout: 300000 });
  } catch {
    failed = true;
  }
  writeFileSync(m.file, original);
  if (failed) {
    console.log(`RED  ${m.name}`);
    red++;
  } else {
    console.log(`MISS ${m.name} — 결함이 통과했다 (검출력 0)`);
    misses.push(m.name);
  }
}

console.log(misses.length === 0 ? `\n✅ mutations: ${red}/${MUTATIONS.length} RED` : `\n❌ ${misses.length} 축 미검출`);
if (misses.length > 0) process.exitCode = 1;
