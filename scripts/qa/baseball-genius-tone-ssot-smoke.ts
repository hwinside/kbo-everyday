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
  BASEBALL_GENIUS_FALLBACK_ANSWER,
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
  UNTRUSTED_METRIC_ANSWER,
  UNSUPPORTED_SEASON_ANSWER,
  RECORD_MISSING_ANSWER,
  renderTeamEntryAnswer("LG", { snapshotDate: "2026-08-14", players: ["홍길동"] }),
  renderTodayStartersAnswer([], "LG"),
  renderDraftAnswer("홍길동", { year: 2020, team: "LG", detail: "1차 지명" }),
  renderDraftUnavailable("홍길동", "not_registered"),
  composeTeamRecordAnswer({ kind: "ok", team: "LG", label: "순위", value: "1위" }),
];
for (const answer of staticAnswers) {
  assert.ok(isBaseballGeniusToneCompliant(answer), `static answer violates 합니다체: ${answer}`);
}

const termFixture = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "scripts/qa/fixtures/baseball-terms-formal-tone.json"), "utf8"),
) as Array<{ term: string; answer: string }>;
assert.equal(termFixture.length, 136, "production 검수 사전 136항목이 모두 있어야 한다");
assert.equal(new Set(termFixture.map(({ term }) => term)).size, 136, "검수 사전 term 중복 금지");
for (const { term, answer } of termFixture) {
  assert.ok(isBaseballGeniusToneCompliant(answer), `dictionary answer violates 합니다체: ${term}`);
}
const migration = fs.readFileSync(
  path.join(process.cwd(), "supabase/migrations/20260814121000_baseball_terms_formal_tone.sql"),
  "utf8",
);
const sqlQuote = (value: string) => `'${value.replaceAll("'", "''")}'`;
for (const { term, answer } of termFixture) {
  assert.ok(
    migration.includes(`(${sqlQuote(term)}, ${sqlQuote(answer)})`),
    `migration fixture mismatch: ${term}`,
  );
}
assert.match(migration, /matched_count <> 136/);

assert.equal(isBaseballGeniusToneCompliant("야구에서 보크는 반칙 동작입니다."), true);
assert.equal(isBaseballGeniusToneCompliant("추가 확인이 필요."), true, "명사 끝 `요`를 해요체로 오판하면 안 된다");
for (const nonFormal of [
  "야구에서 보크는 반칙 동작이에요.",
  "주자가 진루할 수 없어요(2사 제외).",
  "보크는 반칙이야.",
  "알겠어.",
  "그렇다.",
]) {
  assert.equal(isBaseballGeniusToneCompliant(nonFormal), false, `비합니다체를 통과시키면 안 된다: ${nonFormal}`);
}
assert.deepEqual(
  validateLlmResponse(JSON.stringify({ status: "BASEBALL_RULE_TERM", answer: "야구에서 보크는 반칙 동작이에요." }), "보크가 뭐야?"),
  { kind: "unsure" },
);
assert.deepEqual(
  validateRagResponse(JSON.stringify({ status: "GROUNDED", answer: "야구에서 보크는 반칙 동작이에요." }), { numericEvidence: true, evidence: [] }),
  { kind: "insufficient", reason: "tone_violation" },
);
for (const nonFormal of ["보크는 반칙이야.", "알겠어.", "그렇다."]) {
  assert.deepEqual(
    validateLlmResponse(JSON.stringify({ status: "BASEBALL_RULE_TERM", answer: nonFormal }), "보크가 뭐야?"),
    { kind: "unsure" },
    `generic LLM 비합니다체 fail-close: ${nonFormal}`,
  );
  assert.deepEqual(
    validateRagResponse(JSON.stringify({ status: "GROUNDED", answer: nonFormal }), { numericEvidence: true, evidence: [] }),
    { kind: "insufficient", reason: "tone_violation" },
    `RAG 비합니다체 fail-close: ${nonFormal}`,
  );
}

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
        if (!isBaseballGeniusToneCompliant(output) || imperativeOrMechanicalCopy.test(output)) {
          const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          violations.push(`${relative}:${pos.line + 1}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}
assert.deepEqual(violations, [], `해요체 output literals: ${violations.join(", ")}`);

console.log(`PASS baseball genius tone SSOT: ${staticAnswers.length} static outputs, 5 prompts, 136 dictionary answers, generated-output fail-close`);
