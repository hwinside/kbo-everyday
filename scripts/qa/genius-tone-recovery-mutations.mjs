#!/usr/bin/env node
/**
 * A′ 톤 회수 검출력 — 실제 production seam을 훼손하고 `qa:genius-tone-recovery` RED 확인.
 * 패치 MISS/게이트 비실행/실패 ID 부재는 PASS가 아니다. 매 mutant 후 원본을 즉시 복원한다.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const TONE = "src/lib/baseball-qa/tone.ts";
const PIPELINE = "src/lib/baseball-qa/pipeline.ts";
const REQUEST = "src/lib/baseball-qa/gemini-request.ts";
const TARGETS = [TONE, PIPELINE, REQUEST];
const originals = new Map(TARGETS.map((file) => [file, fs.readFileSync(file, "utf8")]));
const restore = () => { for (const [file, source] of originals) fs.writeFileSync(file, source); };
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { restore(); process.exit(130); });

const mutations = [
  {
    name: "M1 아니에요 mapping 삭제",
    file: TONE,
    re: /  \["아니에요", "아닙니다"\],\n/,
    to: "",
  },
  {
    name: "M2 아니에요 비문으로 오염",
    file: TONE,
    re: /\["아니에요", "아닙니다"\]/,
    to: '["아니에요", "아니입니다"]',
  },
  {
    name: "M3 미등록 거예요 과변환 주입",
    file: TONE,
    re: /const FORMAL_TONE_WORD_MAP = new Map<string, string>\(\[\n/,
    to: 'const FORMAL_TONE_WORD_MAP = new Map<string, string>([\n  ["거예요", "거입니다"],\n',
  },
  {
    name: "M4 provider request에서 폐기 원문 제거",
    file: REQUEST,
    re: /parts: \[\{ text: `<원문>\\n\$\{originalAnswer\}\\n<\/원문>` \}\]/,
    to: 'parts: [{ text: "<원문>삭제됨</원문>" }]',
  },
  {
    name: "M5 rewrite 내용보존 게이트 우회",
    file: PIPELINE,
    re: /&& isToneRewriteContentPreserving\(first\.rejectedAnswer, retriedValidation\.answer\);/,
    to: "&& true;",
  },
  {
    // 🔴 M7 은 이제 **로드 시점 assertion 이 먼저 터진다** — 그게 계약이다.
    //    모호쌍을 재주입하면 게이트가 판정하기 전에 모듈이 죽어야 한다.
    name: "M7 모호쌍 보여요 rewrite allowlist 재주입(로드 시점 fail-close)",
    file: TONE,
    re: /const FORMAL_TONE_REWRITE_WORD_MAP = new Map<string, string>\(\[\n/,
    to: 'const FORMAL_TONE_REWRITE_WORD_MAP = new Map<string, string>([\n  ["\ubcf4\uc5ec\uc694", "\ubcf4\uc5ec\uc90d\ub2c8\ub2e4"],\n',
    expectLoadError: true,
  },
  {
    // 🔴 2026-08-25 삼순 P0 — 의지동사 부류가 다시 열리면 요청문이 서술문으로 둔갑한다.
    name: "M12 의지동사 해요 를 ① 매핑에 재주입(요청→서술 둔갑)",
    file: TONE,
    re: /const FORMAL_TONE_WORD_MAP = new Map<string, string>\(\[\n/,
    to: 'const FORMAL_TONE_WORD_MAP = new Map<string, string>([\n  ["\ud574\uc694", "\ud569\ub2c8\ub2e4"],\n',
    expectLoadError: true,
  },
  {
    // 집합만 비우면 assertion 이 통과하므로, 그때는 **게이트 본체가 잡아야** 한다.
    name: "M13 의지동사 집합에서 해요 제거 후 ① 매핑 재주입",
    file: TONE,
    re: /  "\ud574\uc694", "\ub9d0\ud574\uc694", "\uc788\uc5b4\uc694", /,
    to: '  "\ub9d0\ud574\uc694", "\uc788\uc5b4\uc694", ',
    extra: {
      re: /const FORMAL_TONE_WORD_MAP = new Map<string, string>\(\[\n/,
      to: 'const FORMAL_TONE_WORD_MAP = new Map<string, string>([\n  ["\ud574\uc694", "\ud569\ub2c8\ub2e4"],\n',
    },
  },
  {
    name: "M8 scope 판정을 tone 뒤로 되돌림(이중결함 rewrite 소비)",
    file: PIPELINE,
    re: /  if \(!answerInQuestionScope\(question, toned\)\) \{\n    return \{ kind: "unsure", reason: "out_of_question_scope" \};\n  \}\n  if \(toneFailed\) \{\n    return \{ kind: "unsure", reason: "tone_noncompliant", rejectedAnswer: toned \};\n  \}\n/,
    to: '  if (toneFailed) {\n    return { kind: "unsure", reason: "tone_noncompliant", rejectedAnswer: toned };\n  }\n  if (!answerInQuestionScope(question, toned)) {\n    return { kind: "unsure", reason: "out_of_question_scope" };\n  }\n',
  },
  {
    name: "M9 의문문 mood 가드 제거(서술형 매핑 과적용)",
    file: TONE,
    re: /          if \(isInterrogativeSentence\(rawSentence\)\) return rawSentence;\n/,
    to: "",
  },
  {
    name: "M10 의문 validator 를 평서문 규칙으로 완화(`니다?` 통과)",
    file: TONE,
    re: /const FORMAL_INTERROGATIVE_ENDING_RE = \/니까\$\/u;/,
    to: "const FORMAL_INTERROGATIVE_ENDING_RE = /(?:\\ub2c8\\ub2e4|\\ub2c8\\uae4c)$/u;",
  },
  {
    name: "M11 앞단 normalizer 토큰 합산 제거(full seam 축소 측정)",
    file: PIPELINE,
    re: /          inputTokens: \(entry\.inputTokens \?\? 0\) \+ \(normIn \?\? 0\),\n/,
    to: "          inputTokens: entry.inputTokens ?? 0,\n",
  },
  {
    name: "M6 rewrite 토큰 합산 제거",
    file: PIPELINE,
    re: /inputTokens: sumTokens\(llm\.inputTokens, retry\.inputTokens\),/,
    to: "inputTokens: retry.inputTokens,",
  },
];

let detected = 0;
try {
  for (const mutation of mutations) {
    restore();
    const source = fs.readFileSync(mutation.file, "utf8");
    const matches = source.match(mutation.re)?.length ?? 0;
    if (matches !== 1) {
      console.error(`[GTR-MUT-ANCHOR-MISS] ${mutation.name}: matches=${matches}`);
      process.exitCode = 1;
      break;
    }
    let mutant = source.replace(mutation.re, mutation.to);
    if (mutant === source) {
      console.error(`[GTR-MUT-NOOP] ${mutation.name}`);
      process.exitCode = 1;
      break;
    }
    // 일부 mutant 는 두 곳을 동시에 훼손해야 무대가 성립한다(집합 해제 + 매핑 재주입).
    if (mutation.extra) {
      const extraMatches = mutant.match(mutation.extra.re)?.length ?? 0;
      if (extraMatches !== 1) {
        console.error(`[GTR-MUT-ANCHOR-MISS] ${mutation.name} extra: matches=${extraMatches}`);
        process.exitCode = 1;
        break;
      }
      const withExtra = mutant.replace(mutation.extra.re, mutation.extra.to);
      if (withExtra === mutant) {
        console.error(`[GTR-MUT-NOOP] ${mutation.name} extra`);
        process.exitCode = 1;
        break;
      }
      mutant = withExtra;
    }
    fs.writeFileSync(mutation.file, mutant);
    const run = spawnSync("npm", ["run", "qa:genius-tone-recovery"], { encoding: "utf8", timeout: 120_000 });
    const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
    // 🔴 판정 키를 mutant 별로 구분한다. 모호쌍/의지동사 재주입은 게이트가 assert 하기 전에
    //    **모듈 로드 시점 throw** 로 죽어야 하며, 그 경우 `[GTR-FAIL]` 이 아니라 tone.ts 의
    //    fail-close 메시지가 나오는 것이 정상이다. 둘을 뭉뚱그리면 검출력이 아니라
    //    "아무 실패나 RED" 가 된다.
    const loadFailed = /의지동사 어절 ".+" 는 요청문을 서술문으로 둔갑시키므로 매핑할 수 없다/u.test(output);
    const gateFailed = output.includes("[GTR-FAIL]");
    const expected = mutation.expectLoadError ? loadFailed : gateFailed;
    const red = run.status !== 0 && expected;
    if (!red) {
      const why = mutation.expectLoadError
        ? "로드 시점 fail-close 미발생"
        : "게이트 [GTR-FAIL] 미발생";
      console.error(`[GTR-MUT-UNDETECTED] ${mutation.name}: exit=${run.status} (${why})`);
      console.error(output.slice(-1500));
      process.exitCode = 1;
      break;
    }
    detected += 1;
    console.log(`RED ${mutation.name}`);
  }
} finally {
  restore();
}
if (!process.exitCode) console.log(`ALL RED (${detected}/${mutations.length})`);
