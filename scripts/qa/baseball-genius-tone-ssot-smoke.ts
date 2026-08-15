import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

import {
  BASEBALL_GENIUS_FALLBACK_ANSWER,
  BASEBALL_GENIUS_NAME_SUGGEST_ANSWER,
  BASEBALL_GENIUS_NAME_UNKNOWN_ANSWER,
  BASEBALL_GENIUS_SYSTEM_ERROR_ANSWER,
  BASEBALL_GENIUS_UNCLEAR_ANSWER,
} from "../../src/lib/constants/baseball-genius";
import {
  ACK_ANSWER,
  CONTEXT_MISSING_ANSWER,
  GREETING_ANSWER,
  HISTORY_HOLD_ANSWER,
  LIMITED_ANSWER,
  LLM_AMBIGUOUS_ANSWER,
  NEWS_UNAVAILABLE_ANSWER,
  PLAYER_PICKER_ANSWER,
  QUESTION_CORRECTION_ANSWER,
  SCOPE_GUIDE_ANSWER,
  SERVICE_REDIRECT_ANSWER,
  SYSTEM_ERROR_ANSWER,
  TEAM_ENTRY_UNAVAILABLE_ANSWER,
  TEAM_STAT_HOLD_ANSWER,
  TODAY_NO_GAMES_ANSWER,
  UNSURE_ANSWER,
  renderTeamEntryAnswer,
  renderTodayStartersAnswer,
  validateLlmResponse,
} from "../../src/lib/baseball-qa/pipeline";
import { BASEBALL_QA_SYSTEM_PROMPT } from "../../src/lib/baseball-qa/gemini-request";
import { buildQuestionLogRow } from "../../src/lib/baseball-qa/log-row";
import {
  RAG_NEWS_SYSTEM_PROMPT,
  RAG_OFFICIAL_SYSTEM_PROMPT,
  RAG_SYSTEM_PROMPT,
  RAG_TEAM_SYSTEM_PROMPT,
  validateRagResponse,
} from "../../src/lib/baseball-qa/rag/retrieve";
import { renderDraftAnswer, renderDraftUnavailable } from "../../src/lib/baseball-qa/roster/draft";
import {
  RECORD_MISSING_ANSWER,
  UNSUPPORTED_SEASON_ANSWER,
  UNTRUSTED_METRIC_ANSWER,
} from "../../src/lib/baseball-qa/stats/season-record";
import { composeTeamRecordAnswer } from "../../src/lib/baseball-qa/stats/team-record";
import {
  appendSparsePositiveSignature,
  BASEBALL_GENIUS_SIGNATURE,
  BASEBALL_GENIUS_TONE_PROMPT,
  BASEBALL_GENIUS_TONE_SSOT,
  isBaseballGeniusToneCompliant,
} from "../../src/lib/baseball-qa/tone";

assert.equal(BASEBALL_GENIUS_TONE_SSOT.pageId, "3b4c901b-b372-81b2-af52-e4ab2d89f492");
assert.equal(BASEBALL_GENIUS_TONE_SSOT.revision, "rev1");
assert.match(BASEBALL_GENIUS_TONE_PROMPT, /정중하지만 야구에 미쳐 있는 해설위원/);
assert.match(BASEBALL_GENIUS_TONE_PROMPT, /모든 답변은 합니다체/);
assert.match(BASEBALL_GENIUS_TONE_PROMPT, /정중함, 야구 과몰입, 팀 중립, 사람에 대한 선의/);
assert.match(BASEBALL_GENIUS_TONE_PROMPT, /지적 감사합니다\. 제가 실책했습니다\. 정확히 다시 확인하겠습니다\./);
assert.match(BASEBALL_GENIUS_TONE_PROMPT, /승인된 언어 시그니처 '승리를 위하여!'는 smalltalk 종료에만/);
assert.match(BASEBALL_GENIUS_TONE_PROMPT, /최근 positive ending 5회/);

for (const prompt of [
  BASEBALL_QA_SYSTEM_PROMPT,
  RAG_SYSTEM_PROMPT,
  RAG_OFFICIAL_SYSTEM_PROMPT,
  RAG_TEAM_SYSTEM_PROMPT,
  RAG_NEWS_SYSTEM_PROMPT,
]) {
  assert.ok(prompt.startsWith(BASEBALL_GENIUS_TONE_PROMPT), "every deployed LLM prompt must start with the tone SSOT");
}

const staticAnswers = [
  BASEBALL_GENIUS_UNCLEAR_ANSWER,
  BASEBALL_GENIUS_SYSTEM_ERROR_ANSWER,
  BASEBALL_GENIUS_NAME_SUGGEST_ANSWER("임찬규"),
  BASEBALL_GENIUS_NAME_UNKNOWN_ANSWER,
  ACK_ANSWER,
  CONTEXT_MISSING_ANSWER,
  GREETING_ANSWER,
  HISTORY_HOLD_ANSWER,
  LIMITED_ANSWER,
  LLM_AMBIGUOUS_ANSWER,
  PLAYER_PICKER_ANSWER,
  QUESTION_CORRECTION_ANSWER,
  SERVICE_REDIRECT_ANSWER,
  SYSTEM_ERROR_ANSWER,
  TEAM_ENTRY_UNAVAILABLE_ANSWER,
  TEAM_STAT_HOLD_ANSWER,
  TODAY_NO_GAMES_ANSWER,
  UNTRUSTED_METRIC_ANSWER,
  UNSUPPORTED_SEASON_ANSWER,
  RECORD_MISSING_ANSWER,
  renderTodayStartersAnswer([], "LG"),
  renderDraftAnswer("홍길동", { year: 2020, team: "LG", detail: "1차 지명" }),
  renderDraftUnavailable("홍길동", "not_registered"),
  composeTeamRecordAnswer({ kind: "ok", team: "LG", label: "순위", value: "1위" }),
];
for (const answer of staticAnswers) {
  assert.ok(isBaseballGeniusToneCompliant(answer), `static answer violates 합니다체: ${answer}`);
}
const structuredAnswers = [
  BASEBALL_GENIUS_FALLBACK_ANSWER,
  UNSURE_ANSWER,
  NEWS_UNAVAILABLE_ANSWER,
  SCOPE_GUIDE_ANSWER,
  renderTeamEntryAnswer("LG", { snapshotDate: "2026-08-14", players: ["홍길동"] }),
];
for (const answer of structuredAnswers) {
  assert.ok(isBaseballGeniusToneCompliant(answer, { mode: "structured" }), `structured answer violates 합니다체: ${answer}`);
}

const beforeTermFixture = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "scripts/qa/fixtures/baseball-terms-before-tone.json"), "utf8"),
) as Array<{ term: string; answer: string }>;
const termFixture = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "scripts/qa/fixtures/baseball-terms-formal-tone.json"), "utf8"),
) as Array<{ term: string; answer: string }>;
assert.equal(beforeTermFixture.length, 136, "production before fixture 136항목이 모두 있어야 한다");
assert.equal(termFixture.length, 136, "production after fixture 136항목이 모두 있어야 한다");
assert.equal(new Set(termFixture.map(({ term }) => term)).size, 136, "검수 사전 term 중복 금지");
assert.deepEqual(beforeTermFixture.map(({ term }) => term), termFixture.map(({ term }) => term), "before/after term·순서 exact");
for (const { term, answer } of termFixture) {
  assert.ok(isBaseballGeniusToneCompliant(answer), `dictionary answer violates 합니다체: ${term}`);
}
const migration = fs.readFileSync(
  path.join(process.cwd(), "supabase/migrations/20260814121000_baseball_terms_formal_tone.sql"),
  "utf8",
);
const sqlQuote = (value: string) => `'${value.replaceAll("'", "''")}'`;
for (let index = 0; index < termFixture.length; index += 1) {
  const before = beforeTermFixture[index];
  const after = termFixture[index];
  assert.ok(
    migration.includes(`(${sqlQuote(after.term)}, ${sqlQuote(before.answer)}, ${sqlQuote(after.answer)})`),
    `migration before/after fixture mismatch: ${after.term}`,
  );
}
assert.match(migration, /before_answer = bt\.answer/);
assert.match(migration, /GET DIAGNOSTICS updated_count = ROW_COUNT/);
assert.match(migration, /updated_count <> 136/);
assert.match(migration, /after_answer = bt\.answer/);
assert.match(migration, /after_count <> 136/);

assert.equal(isBaseballGeniusToneCompliant("야구에서 보크는 반칙 동작입니다."), true);
assert.equal(isBaseballGeniusToneCompliant("추가 확인이 필요합니다."), true, "합니다체 문장은 통과해야 한다");
for (const nonFormal of [
  "야구에서 보크는 반칙 동작이에요.",
  "주자가 진루할 수 없어요(2사 제외).",
  "보크는 반칙이야.",
  "알겠어.",
  "그렇다.",
  "맞아.",
  "좋아.",
  "몰라.",
  "“보크는 반칙이야.”",
  "정식 답변입니다.\n보크는 반칙이야",
  "반칙이야.다음은 정식 답변입니다.",
  "정식 답변입니다.\n출처: 나무위키",
]) {
  assert.equal(isBaseballGeniusToneCompliant(nonFormal), false, `비합니다체를 통과시키면 안 된다: ${nonFormal}`);
}
assert.deepEqual(
  validateLlmResponse(JSON.stringify({ status: "BASEBALL_RULE_TERM", answer: "야구에서 보크는 반칙 동작이에요." }), "보크가 뭐야?"),
  { kind: "unsure" },
);
assert.deepEqual(
  validateRagResponse(JSON.stringify({ status: "GROUNDED", answer: "야구에서 보크는 반칙 동작이에요." }), { numericEvidence: true, evidence: [] }),
  { kind: "grounded", answer: "야구에서 보크는 반칙 동작이에요.", toneCompliant: false },
  "RAG 생성답의 해요체는 서빙하되 toneCompliant=false 로 관측한다",
);
for (const nonFormal of [
  "보크는 반칙이야.", "알겠어.", "그렇다.", "맞아.", "좋아.", "몰라.", "“보크는 반칙이야.”",
  "정식 답변입니다.\n보크는 반칙이야", "반칙이야.다음은 정식 답변입니다.", "정식 답변입니다.\n출처: 나무위키",
]) {
  assert.deepEqual(
    validateLlmResponse(JSON.stringify({ status: "BASEBALL_RULE_TERM", answer: nonFormal }), "보크가 뭐야?"),
    { kind: "unsure" },
    `generic LLM 비합니다체 fail-close: ${nonFormal}`,
  );
  assert.deepEqual(
    validateRagResponse(JSON.stringify({ status: "GROUNDED", answer: nonFormal }), { numericEvidence: true, evidence: [] }),
    { kind: "grounded", answer: nonFormal, toneCompliant: false },
    `RAG 비합니다체는 서빙+관측: ${nonFormal}`,
  );
}

// 톤 외 안전 계약은 전부 종전대로 fail-close — A안은 **tone_violation만** 강등한다.
assert.equal(validateRagResponse("not-json").kind, "insufficient", "malformed JSON은 거절");
assert.equal(
  validateRagResponse(JSON.stringify({ status: "UNKNOWN", answer: "정답이에요." })).kind,
  "insufficient",
  "미지 status는 거절",
);
assert.equal(
  validateRagResponse(JSON.stringify({ status: "GROUNDED", answer: "https://evil.example 답이에요." })).kind,
  "insufficient",
  "URL 포함은 거절",
);
assert.equal(
  validateRagResponse(JSON.stringify({ status: "GROUNDED", answer: "홈런 99개예요." })).kind,
  "insufficient",
  "tier2 질문 밖 숫자는 거절",
);
assert.equal(
  validateRagResponse(JSON.stringify({ status: "GROUNDED", answer: "가".repeat(500) })).kind,
  "insufficient",
  "길이 상한 초과는 거절",
);

// Production INSERT 행에 관측값이 결속되고, 정적 경로는 null로 남아 분모가 섞이지 않는다.
const toneObservedRow = buildQuestionLogRow({
  userId: "00000000-0000-0000-0000-000000000001",
  question: "구자욱이 누구야?",
  questionNorm: "구자욱이누구야",
  matchPath: "rag",
  answer: "구자욱 선수는 외야수예요.",
  inputTokens: 100,
  outputTokens: 10,
  toneCompliant: false,
}, 1);
assert.equal(toneObservedRow.tone_compliant, false, "서버 로그 행에 tone_compliant=false 결속");
assert.equal(buildQuestionLogRow({
  userId: "00000000-0000-0000-0000-000000000001",
  question: "보크가 뭐야?", questionNorm: "보크",
  matchPath: "dictionary", answer: "보크는 반칙 동작입니다.",
  inputTokens: null, outputTokens: null,
}, 2).tone_compliant, null, "정적 경로는 tone_compliant=null");

const toneObservationMigration = fs.readFileSync(
  path.join(process.cwd(), "supabase/migrations/20260814235500_genius_question_logs_tone_observation.sql"),
  "utf8",
);
assert.match(toneObservationMigration, /ADD COLUMN IF NOT EXISTS tone_compliant boolean/);

// 새 정적 출력이 추가되면서 해요체가 섞이면, 위 수동 목록에 없더라도 실행 코드 AST에서 잡는다.
const outputFiles = [
  "src/lib/constants/baseball-genius.ts",
  "src/lib/baseball-qa/pipeline.ts",
  "src/lib/baseball-qa/server.ts",
  "src/lib/baseball-qa/roster/draft.ts",
  "src/lib/baseball-qa/awards/series-prize.ts",
  "src/lib/baseball-qa/stats/season-record.ts",
  "src/lib/baseball-qa/stats/team-record.ts",
  "src/lib/baseball-qa/stats/career-series.ts",
  "src/lib/baseball-qa/stats/career-metric-leaderboard.ts",
];
const literalForbiddenEnding = /(?:이에요|예요|해요|했어요|돼요|되요|아요|어요|여요|죠|네요|군요|나요|가요|세요|게요|래요|대요|데요|지요|고요|이야|알겠어|맞아|좋아|몰라|(?<!니)다)(?=(?:[.!?…)\]}]|⚾|$))/u;
const imperativeOrMechanicalCopy = /주십시오|(?:관해|기록을|이야기에) 답변합니다/u;
const violations: string[] = [];
for (const relative of outputFiles) {
  const absolute = path.join(process.cwd(), relative);
  const source = fs.readFileSync(absolute, "utf8");
  const sf = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) {
      let owner: ts.Node | undefined = node;
      let isOutput = false;
      for (let i = 0; owner && i < 6; i += 1, owner = owner.parent) {
        if (ts.isReturnStatement(owner)) isOutput = true;
        if (ts.isPropertyAssignment(owner) && owner.name.getText(sf) === "answer") isOutput = true;
        if (ts.isVariableDeclaration(owner) && /_ANSWER$/.test(owner.name.getText(sf))) isOutput = true;
      }
      if (isOutput) {
        const output = ts.isStringLiteralLike(node) ? node.text : node.getText(sf);
        // AST의 template 조각은 완성 문장이 아니므로 positive 종결 검사는 런타임 렌더 표본에서 한다.
        // 여기서는 새 리터럴에 명백한 비격식/명령형이 들어오는지만 전수 감시한다.
        const botLiteral = output.replace(/예:\s*(?:(?:["“][^"”]*["”])\s*)+/gu, "");
        if (literalForbiddenEnding.test(botLiteral) || imperativeOrMechanicalCopy.test(botLiteral)) {
          const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          violations.push(`${relative}:${pos.line + 1}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}
assert.deepEqual(violations, [], `비합니다체/명령형 output literals: ${violations.join(", ")}`);

assert.equal(BASEBALL_GENIUS_SIGNATURE, "승리를 위하여!");
assert.equal(
  appendSparsePositiveSignature(ACK_ANSWER, ["좋은 하루입니다.", "감사합니다.", "반갑습니다.", "확인했습니다.", "기쁩니다."]),
  `${ACK_ANSWER}\n승리를 위하여!`,
  "최근 positive ending 5회에 시그니처가 없을 때만 부착한다",
);
assert.equal(
  appendSparsePositiveSignature(ACK_ANSWER, ["좋은 하루입니다.", "승리를 위하여!", "감사합니다.", "반갑습니다.", "기쁩니다."]),
  ACK_ANSWER,
  "최근 positive ending 5회 안의 시그니처는 반복하지 않는다",
);
assert.equal(
  appendSparsePositiveSignature(ACK_ANSWER, ["1", "2", "3", "4", "5", "승리를 위하여!"]),
  `${ACK_ANSWER}\n승리를 위하여!`,
  "6번째 이전 사용은 cooldown 범위 밖이다",
);
assert.equal(staticAnswers.some((answer) => answer.includes("⚾")), false, "⚾를 승인 언어 시그니처로 오인하지 않는다");

console.log(`PASS baseball genius tone SSOT: ${staticAnswers.length} static outputs, 5 prompts, 136 dictionary answers, generated-output fail-close`);
