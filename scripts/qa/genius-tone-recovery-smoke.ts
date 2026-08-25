/**
 * 야잘알봇 A′ 톤 회수 종단 게이트 (2026-08-24).
 *
 * ① A0 actual 373문장에서 검토된 완전 어절 106쌍만 정규화한다.
 * ② 잔존분은 폐기 원문의 마지막 어절만 provider rewrite 1회.
 * ③ rewrite는 prefix/문장부호/수치/식별자 보존 + 기존 validator를 모두 통과해야 서빙.
 * ④ 실패·비톤 결함은 재호출/3차 호출 없이 기존 unsure를 유지한다.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  answerQuestion,
  UNCLEAR_ANSWER,
  type QaDeps,
} from "../../src/lib/baseball-qa/pipeline";
import {
  isBaseballGeniusToneCompliant,
  isToneRewriteContentPreserving,
  normalizeToFormalTone,
} from "../../src/lib/baseball-qa/tone";
import {
  buildBaseballQaGeminiRequest,
  buildBaseballQaToneRewriteRequest,
  TONE_REWRITE_PROMPT,
} from "../../src/lib/baseball-qa/gemini-request";

interface ActualLedger {
  kind: string;
  sourceSha256: string;
  counts: { sentences: number; mapped: number; unchanged: number };
  rows: Array<{
    runId: string;
    rep: number;
    sentenceIndex: number;
    input: string;
    expected: string;
    action: "mapped" | "unchanged";
  }>;
}

async function main(): Promise<void> {
  let passed = 0;
  const ok = (label: string): void => { passed += 1; console.log(`PASS ${label}`); };

  // ── ① A0 actual 373문장 전수 원장 ────────────────────────────────────
  const ledger = JSON.parse(readFileSync(
    "scripts/qa/fixtures/genius-tone-a0-373.json", "utf8",
  )) as ActualLedger;
  assert.equal(ledger.kind, "genius-tone-a0-actual-v1");
  assert.match(ledger.sourceSha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(ledger.counts, { sentences: 373, mapped: 323, unchanged: 50 });
  assert.equal(ledger.rows.length, 373);
  const ids = new Set<string>();
  let mapped = 0;
  let unchanged = 0;
  for (const row of ledger.rows) {
    const id = `${row.runId}:${row.rep}:${row.sentenceIndex}`;
    assert.ok(!ids.has(id), `actual ledger duplicate: ${id}`);
    ids.add(id);
    const out = normalizeToFormalTone(row.input);
    assert.equal(out.answer, row.expected, `actual mismatch: ${id}`);
    if (row.action === "mapped") {
      mapped += 1;
      assert.notEqual(out.answer, row.input, `mapped row no-op: ${id}`);
    } else {
      unchanged += 1;
      assert.equal(out.answer, row.input, `unchanged row modified: ${id}`);
    }
  }
  assert.equal(mapped, 323);
  assert.equal(unchanged, 50);
  ok("① A0 actual 373 — mapped 323 / unchanged 50 exact");

  // 일반 suffix가 아니라 완전 어절 allowlist다. 지정 반례는 byte-identical + RED여야 한다.
  for (const answer of [
    "야구에서 이건 거예요.",
    "야구에서 그건 뭐예요?",
    "야구에서 왜예요?",
    "야구 마스코트는 아이에요.",
    "야구 규칙은 상황에 따라 나뉘어요.",
  ]) {
    const out = normalizeToFormalTone(answer);
    assert.equal(out.answer, answer, `미등록형을 바꾸면 안 됨: ${answer}`);
    assert.equal(out.compliant, false, `미등록형은 기존 validator가 RED여야 함: ${answer}`);
  }
  ok("① 미등록형 fail-close — 거/뭐/왜예요·일반활용 byte-identical");

  // 🔴 2026-08-25 삼순 P0 — **의문문은 서술형 매핑을 적용하지 않는다.**
  //    `가능해요?` → `가능합니다?` 는 비문이고, validator 가 장식(`?`)을 떼고 `니다`만
  //    보므로 **그대로 통과해 서빙될 수 있었다**. A0 373·shadow 45 에 `?` 가 각 0건이라
  //    원장이 증명해주지 않는 무대 — mood 별 exact 쌍 등록 전까지 fail-close 한다.
  for (const answer of [
    "야구에서 그게 가능해요?",
    "야구에서 이건 규칙이에요?",
    "야구 기록표를 보여줘요?",
    "야구에서 그게 가능해요? 이건 규칙이에요?",
  ]) {
    const out = normalizeToFormalTone(answer);
    assert.equal(out.answer, answer, `의문문을 서술형으로 바꿀: ${answer}`);
    assert.equal(out.converted, 0, `의문문 변환 발생: ${answer}`);
    assert.equal(out.compliant, false, `의문문은 폐기되어야 함: ${answer}`);
    assert.doesNotMatch(out.answer, /니다\s*[?]/u, `합니다체 의문 비문 생성: ${answer}`);
  }
  // 같은 문단에서 **서술문은 정상 변환**된다 — 의문문 가드가 문단 전체를 죽이지 않음을 고정.
  {
    const out = normalizeToFormalTone("야구에서 보크는 규칙이에요. 그게 가능해요?");
    assert.equal(out.answer, "야구에서 보크는 규칙입니다. 그게 가능해요?");
    assert.equal(out.converted, 1);
    assert.equal(out.compliant, false, "잔존 의문문 때문에 전체는 여전히 폐기");
  }
  // ② rewrite 게이트도 의문문 쌍을 보존으로 인정하지 않는다.
  for (const [before, after] of [
    ["야구에서 그게 가능해요?", "야구에서 그게 가능합니다?"],
    ["야구 기록표를 보여줘요?", "야구 기록표를 보여줍니다?"],
    ["야구에서 그런 사례를 많아요?", "야구에서 그런 사례를 많습니다?"],
  ]) {
    assert.equal(
      isToneRewriteContentPreserving(before, after), false,
      `의문문 rewrite 통과: ${before} -> ${after}`,
    );
  }
  // 요청·명령 mood 모호쌍 `보여줘요` 도 제거됐다 — 서술/요청이 같은 key 라 갈리지 않는다.
  for (const [before, after] of [
    ["야구 기록표를 보여줘요.", "야구 기록표를 보여줍니다."],   // 요청 → 서술 둘갑
    ["그래프가 야구 차이를 보여줘요.", "그래프가 야구 차이를 보여줍니다."], // 같은 key — 함께 폐기
  ]) {
    assert.equal(
      isToneRewriteContentPreserving(before, after), false,
      `mood 모호쌍 보여줘요 통과: ${before} -> ${after}`,
    );
  }
  ok("①② mood fail-close — 의문문 4축·혼합문단·rewrite 3축 + 보여줘요 모호쌍 제거");

  // 대표 유한 매핑과 원 사고를 명시적으로 고정한다.
  const finite: Array<[string, string]> = [
    ["야구에서 보크는 규칙이에요.", "야구에서 보크는 규칙입니다."],
    ["야구 규칙이 아니에요.", "야구 규칙이 아닙니다."],
    ["야구에서 득점이 가능해요.", "야구에서 득점이 가능합니다."],
    ["야구에 기록이 있어요. 중요한 기록이에요.", "야구에 기록이 있습니다. 중요한 기록입니다."],
  ];
  for (const [before, expected] of finite) {
    const out = normalizeToFormalTone(before);
    assert.equal(out.answer, expected);
    assert.equal(out.compliant, true);
    assert.doesNotMatch(out.answer, /아니입니다/u);
  }
  ok("① 유한 매핑 — 대표 4축 + 아니입니다 음성");

  // 이미 정상인 답은 byte-identical/no-op.
  const formal = "야구에서 보크는 투수의 반칙입니다. 주자는 진루합니다.";
  assert.deepEqual(normalizeToFormalTone(formal), { answer: formal, compliant: true, converted: 0 });
  ok("① 정상 합니다체 byte-identical no-op");

  // ── ② rewrite 보존 계약 ─────────────────────────────────────────────
  assert.equal(
    isToneRewriteContentPreserving(
      "야구에서 이 플레이를 반칙으로 여겨요.",
      "야구에서 이 플레이를 반칙으로 여깁니다.",
    ),
    true,
  );
  assert.equal(
    isToneRewriteContentPreserving(
      "첫 문장은 이미 정상입니다. 다음 장면을 반칙으로 여겨요.",
      "첫 문장은 이미 정상입니다. 다음 장면을 반칙으로 여깁니다.",
    ),
    true,
    "이미 formal인 문장은 byte-identical로 보존하며 열린 문장만 rewrite",
  );
  for (const [before, after] of [
    // prefix 재서술/내용 변경
    ["야구에서 이 플레이를 반칙으로 여겨요.", "야구에서 저 플레이를 반칙으로 여깁니다."],
    // 숫자 변경
    ["야구에서 3점을 주면 어려워요.", "야구에서 4점을 주면 어렵습니다."],
    // 구단명 변경
    ["LG가 이기면 좋아요.", "두산이 이기면 좋습니다."],
    // 문장부호/문장 개수 변경
    ["야구에서 이건 어려워요.", "야구에서 이건 어렵습니다!"],
    ["야구에서 이건 어려워요.", "야구에서 이건 어렵습니다. 추가합니다."],
    // 마지막 어절만 바뀌어도 의미가 뒤집히는 반례 — 유사도 규칙이면 통과한다.
    ["야구에서 좋아요.", "야구에서 싫습니다."],
    ["야구에서는 그러지 않아요.", "야구에서는 그렇게 합니다."],
    ["야구에서 맞아요.", "야구에서 틀립니다."],
    // copula는 ① 미등록형이며 ②로 우회하지 않는다.
    ["야구에서 이건 거예요.", "야구에서 이건 겁니다."],
    // 🔴 2026-08-24 삼순 NO-GO 반례. `보여요`는 자동사/타동사가 같은 어절로 개이므로
    // 어절 exact key 로는 의미를 닫을 수 없다 — 쌍을 통째 fail-close 했다.
    ["선수의 긴장감이 얼굴에 보여요.", "선수의 긴장감이 얼굴에 보여줍니다."],
    ["투수의 표정이 보여요.", "투수의 표정이 보여줍니다."],
    // 자동사를 올바르게 옮긴 문장도 등록된 쌍이 아니므로 폐기한다(과소가 아니라 fail-close).
    ["투수의 표정이 보여요.", "투수의 표정이 보입니다."],
  ]) {
    assert.equal(isToneRewriteContentPreserving(before, after), false, `보존 위반 통과: ${before} -> ${after}`);
  }
  ok("② 보존 게이트 — prefix/수치/구단/문장부호/문장수/copula/모호어절 음성");

  // 과잎 fail-close 가 아님을 고정 — 등록된 비모호 쌍은 여전히 양성이다.
  for (const [before, after] of [
    ["야구에서 그런 사례는 많아요.", "야구에서 그런 사례는 많습니다."],
    ["야구에서 투수는 공을 받아요.", "야구에서 투수는 공을 받습니다."],
  ]) {
    assert.equal(isToneRewriteContentPreserving(before, after), true, `과잎 fail-close: ${before}`);
  }
  ok("② 보존 게이트 — 등록 비모호 쌍 양성 유지");

  // provider request는 실제 폐기 원문을 데이터로 포함해야 한다. 상수만 존재하면 false-GREEN.
  const originalDraft = "야구에서 이 플레이를 반칙으로 여겨요.";
  const rewriteRequest = buildBaseballQaToneRewriteRequest(originalDraft);
  assert.equal(rewriteRequest.systemInstruction.parts[0].text, TONE_REWRITE_PROMPT);
  assert.match(rewriteRequest.contents[0].parts[0].text, /<원문>/u);
  assert.ok(rewriteRequest.contents[0].parts[0].text.includes(originalDraft));
  assert.equal(rewriteRequest.generationConfig.temperature, 0);
  const normalRequest = buildBaseballQaGeminiRequest("보크가 뭐야?", "BASE");
  assert.equal(normalRequest.systemInstruction.parts[0].text, "BASE");
  assert.ok(!normalRequest.contents[0].parts[0].text.includes(originalDraft));
  ok("② provider seam — 폐기 원문 rewrite request 결속");

  // ── ② 실 provider shadow 원장 ───────────────────────────────────────
  const rewriteFixtureBytes = readFileSync("scripts/qa/fixtures/genius-tone-a0-rewrite45.json");
  const rewriteFixture = JSON.parse(rewriteFixtureBytes.toString("utf8")) as {
    kind: string;
    sourceSha256: string;
    rows: Array<{ runId: string; rep: number; afterFiniteMap: string }>;
  };
  const shadow = JSON.parse(readFileSync(
    "scripts/qa/fixtures/genius-tone-a0-rewrite45-shadow.json", "utf8",
  )) as {
    kind: string;
    fixtureSha256: string;
    sourceSha256: string;
    summary: {
      total: number; tonePass: number; preservationPass: number; accepted: number;
      latencyMs: { min: number; median: number; p95: number; max: number };
      tokens: { inputTotal: number; outputTotal: number; inputMean: number; outputMean: number };
    };
    results: Array<{
      index: number; runId: string; rep: number; inputSha256: string;
      rewritten: string | null; tonePass: boolean; preservationPass: boolean; accepted: boolean;
    }>;
  };
  assert.equal(rewriteFixture.kind, "genius-tone-a0-rewrite45-v1");
  assert.equal(rewriteFixture.rows.length, 45);
  assert.equal(shadow.kind, "genius-tone-a0-rewrite45-shadow-v1");
  assert.equal(shadow.sourceSha256, rewriteFixture.sourceSha256);
  assert.equal(
    shadow.fixtureSha256,
    createHash("sha256").update(rewriteFixtureBytes).digest("hex"),
    "shadow가 현재 45 fixture와 결속돼야 함",
  );
  assert.deepEqual(
    { total: shadow.summary.total, tonePass: shadow.summary.tonePass,
      preservationPass: shadow.summary.preservationPass, accepted: shadow.summary.accepted },
    { total: 45, tonePass: 33, preservationPass: 21, accepted: 21 },
  );
  assert.deepEqual(shadow.summary.latencyMs, { min: 932, median: 1208, p95: 1741, max: 1991 });
  assert.deepEqual(
    { inputTotal: shadow.summary.tokens.inputTotal, outputTotal: shadow.summary.tokens.outputTotal },
    { inputTotal: 13931, outputTotal: 7144 },
  );
  assert.equal(shadow.results.length, 45);
  for (const result of shadow.results) {
    const fixtureRow = rewriteFixture.rows[result.index];
    assert.equal(result.runId, fixtureRow.runId);
    assert.equal(result.rep, fixtureRow.rep);
    assert.equal(
      result.inputSha256,
      createHash("sha256").update(fixtureRow.afterFiniteMap).digest("hex"),
    );
    const rewritten = result.rewritten ?? "";
    const tonePass = rewritten.length > 0 && isBaseballGeniusToneCompliant(rewritten);
    const preservationPass = tonePass
      && isToneRewriteContentPreserving(fixtureRow.afterFiniteMap, rewritten);
    assert.equal(result.tonePass, tonePass, `shadow tone 판정 drift: ${result.index}`);
    assert.equal(result.preservationPass, preservationPass, `shadow 보존 판정 drift: ${result.index}`);
    assert.equal(result.accepted, tonePass && preservationPass, `shadow accepted drift: ${result.index}`);
  }
  // 원장은 mood 무대를 담지 못한다 — 그 사실 자체를 고정해 "shadow 가 증명했다"는 과장 방지.
  assert.equal(
    shadow.results.filter((r) => (r.rewritten ?? "").includes("?")).length, 0,
    "shadow 응답에 의문문 0건 — mood 계약은 반례로만 검증된다",
  );
  assert.equal(
    rewriteFixture.rows.filter((r) => r.afterFiniteMap.includes("?")).length, 0,
    "shadow 입력에도 의문문 0건",
  );
  ok("② 실 provider shadow 45 — accepted 21(46.7%) · ?무대 0 · p95 1741ms · tokens 13931/7144");

  interface RunResult {
    source: string;
    answer: string;
    primaryCalls: number;
    rewriteCalls: string[];
    logs: Array<Record<string, unknown>>;
    stores: string[];
  }

  async function runWith(primary: string, rewrites: string[] = [], injectRewrite = true): Promise<RunResult> {
    let primaryCalls = 0;
    let rewriteIndex = 0;
    const rewriteCalls: string[] = [];
    const logs: Array<Record<string, unknown>> = [];
    const stores: string[] = [];
    const deps: QaDeps = {
      loadGlossary: async () => [],
      loadPlayers: async () => [],
      getCache: async () => null,
      setCache: async () => {},
      reserveDaily: async () => ({ allowed: true, remaining: 19 }),
      callLlm: async () => {
        primaryCalls += 1;
        if (primaryCalls > 1) throw new Error("generic LLM duplicate call");
        return { text: primary, inputTokens: 10, outputTokens: 3 };
      },
      ...(injectRewrite ? {
        rewriteLlmTone: async (draft: string) => {
          rewriteCalls.push(draft);
          const text = rewrites[rewriteIndex++];
          if (text === undefined) throw new Error("unexpected rewrite call");
          return { text, inputTokens: 20, outputTokens: 6 };
        },
      } : {}),
      storeLlm: async (text) => { stores.push(text); },
      log: async (row) => { logs.push(row as unknown as Record<string, unknown>); },
    };
    const result = await answerQuestion("tone-user", "보크가 뭐야?", deps);
    return { source: result.source, answer: result.answer, primaryCalls, rewriteCalls, logs, stores };
  }

  const json = (answer: string): string => JSON.stringify({ status: "BASEBALL_RULE_TERM", answer });

  // ①만으로 닫히면 provider rewrite 0.
  {
    const draft = "야구에서 보크는 규칙이에요.";
    const r = await runWith(json(draft));
    assert.equal(r.source, "llm");
    assert.equal(r.answer, "야구에서 보크는 규칙입니다.");
    assert.equal(r.primaryCalls, 1);
    assert.deepEqual(r.rewriteCalls, []);
    assert.equal(r.logs.at(-1)?.inputTokens, 10);
    ok("종단 ① — 유한 매핑 회수, rewrite 0");
  }

  // 열린 활용이면 폐기 원문으로 ② 딱 1회. 보존+전수검증 결과만 서빙, 토큰 합산.
  {
    const draft = "야구에서 보크를 반칙으로 여겨요.";
    const r = await runWith(json(draft), [json("야구에서 보크를 반칙으로 여깁니다.")]);
    assert.equal(r.source, "llm");
    assert.equal(r.answer, "야구에서 보크를 반칙으로 여깁니다.");
    assert.equal(r.primaryCalls, 1);
    assert.deepEqual(r.rewriteCalls, [draft]);
    assert.equal(r.logs.at(-1)?.inputTokens, 30);
    assert.equal(r.logs.at(-1)?.outputTokens, 9);
    assert.equal(r.stores.length, 1, "최종 envelope store-before-log 1회");
    ok("종단 ② — 원문 rewrite 1회 + 보존/전수검증 + 토큰 합산");
  }

  // 내용이 바뀌거나 tone 실패면 3차 호출 없이 최초 unsure.
  for (const rewritten of [
    "야구에서 보크를 정당한 플레이로 여깁니다.",
    "야구에서 보크를 반칙으로 보여요.",
  ]) {
    const draft = "야구에서 보크를 반칙으로 여겨요.";
    const r = await runWith(json(draft), [json(rewritten)]);
    assert.equal(r.source, "unsure");
    assert.equal(r.answer, UNCLEAR_ANSWER);
    assert.equal(r.primaryCalls, 1);
    assert.equal(r.rewriteCalls.length, 1);
  }
  ok("종단 fail-close — 내용변경/tone 실패, 3차 호출 0");

  // 🔴 scope-before-rewrite (2026-08-25 삼순 P0). 범위밖 + 톤 **이중결함**은 톤을
  //    고쳐도 어차피 폐기되므로 rewrite 호출을 소비하면 안 된다.
  for (const draft of [
    "오늘 날씨는 맑아요.",              // 열린 활용(① 미등록) + 범위밖
    "박태환은 수영 선수예요.",          // 한정 앵커 단독 + 범위밖
    "오늘 주식 시장은 좀 어려워요.",      // 범위밖 denylist
  ]) {
    const r = await runWith(json(draft));
    assert.equal(r.source, "unsure", `이중결함이 서빙됨: ${draft}`);
    assert.equal(r.answer, UNCLEAR_ANSWER);
    assert.equal(r.primaryCalls, 1);
    assert.deepEqual(r.rewriteCalls, [], `범위밖+톤 이중결함이 rewrite 소비: ${draft}`);
  }
  // ① 유한 매핑으로 **톤은 닫히지만 범위밖**인 경우도 rewrite 0 · unsure 로 끝난다.
  {
    const r = await runWith(json("오늘 날씨는 맑은 하루예요. 산책하기 좋은 날이에요."));
    assert.equal(r.source, "unsure");
    assert.deepEqual(r.rewriteCalls, []);
  }
  ok("종단 scope-before-rewrite — 범위밖+톤 이중결함 rewriteCalls=0 (4축)");

  // 반면 **톤 하나만** 남은 범위안 답은 여전히 rewrite 1회를 써야 한다 — scope 선검증이
  // 과잎 fail-close 로 변질되지 않았음을 고정한다(위 ②축과 독립한 대조군).
  {
    const draft = "야구에서 보크를 반칙으로 여겨요.";
    const r = await runWith(json(draft), [json("야구에서 보크를 반칙으로 여깁니다.")]);
    assert.equal(r.source, "llm");
    assert.deepEqual(r.rewriteCalls, [draft]);
    ok("종단 scope-before-rewrite — 범위안 톤 단일결함은 rewrite 1회 유지");
  }

  // ── P1 stat `RULE_TERM` 분기 호출 상한 (production full seam) ───────────────
  // 🔴 2026-08-25 삼순 P1. 가드 소유 질문이 `RULE_TERM` 으로 오면 **의도 1회 → 일반답 1회**
  //    이 이미 소비되고, 그 답이 톤 단일결함이면 rewrite 가 1회 더 붙는다.
  //
  // 🔴 그리고 **그것도 부분 집합이었다** — Production 은 `server.ts` 에서 `normalizeQuestionLlm`
  //    을 주입하고 그게 stat guard 보다 **앞서** 호출된다. 그 seam 을 뺄 채 측정하면
  //    호출수도 토큰도 **축소 측정**이 된다. 이 게이트는 그 seam 까지 주입해
  //    참 상한을 **normalizer + 의도 + 일반답 + rewrite = 총 4회** 로 고정한다.
  //    호출수는 산물이 아니라 **카운터**로 재고, 토큰은 네 호출 전부 합산됨을 고정한다.
  {
    const STAT_QUESTION = "이대호 홈런 몇개";
    // ⚠️ ① 유한 매핑으로 닫히는 어미(`있어요`)를 쓰면 rewrite 무대가 사라진다 —
    //    열린 활용(`여겨요`)이어야 ② 가 실제로 태워진다.
    const draft = "이대호 선수의 홈런은 야구 팬들에게 명장면으로 여겨요.";
    let normalizerCalls = 0;
    let statCalls = 0;
    let genericCalls = 0;
    const rewriteCalls: string[] = [];
    const logs: Array<Record<string, unknown>> = [];
    const deps: QaDeps = {
      loadGlossary: async () => [],
      loadPlayers: async () => [],
      getCache: async () => null,
      setCache: async () => {},
      reserveDaily: async () => ({ allowed: true, remaining: 19 }),
      // 🔴 Production seam — `server.ts` 가 실제로 주입하는 앞단 LLM 호출.
      //    교정 없음(no_change)으로 돌려줘 질문은 원문으로 진행하되, 호출은 실제로 일어난다.
      normalizeQuestionLlm: async () => {
        normalizerCalls += 1;
        return { text: null, inputTokens: 7, outputTokens: 2 };
      },
      callLlm: async (
        _q: string,
        _ctx: unknown,
        _roster: unknown,
        statNumericGuard?: boolean,
      ) => {
        if (statNumericGuard) {
          statCalls += 1;
          return {
            text: JSON.stringify({ status: "BASEBALL_RULE_TERM", answer: "RULE_TERM" }),
            inputTokens: 11, outputTokens: 1,
          };
        }
        genericCalls += 1;
        return { text: json(draft), inputTokens: 100, outputTokens: 30 };
      },
      rewriteLlmTone: async (d: string) => {
        rewriteCalls.push(d);
        return {
          text: json("이대호 선수의 홈런은 야구 팬들에게 명장면으로 여깁니다."),
          inputTokens: 1000, outputTokens: 300,
        };
      },
      storeLlm: async () => {},
      log: async (row) => { logs.push(row as unknown as Record<string, unknown>); },
    } as unknown as QaDeps;
    const result = await answerQuestion("tone-stat-user", STAT_QUESTION, deps);
    assert.equal(result.source, "llm");
    assert.equal(result.answer, "이대호 선수의 홈런은 야구 팬들에게 명장면으로 여깁니다.");
    // 호출수 상한 — normalizer 1 + 의도 1 + 일반답 1 + rewrite 1 = 총 4, rewrite 는 1회만.
    assert.equal(normalizerCalls, 1, "앞단 normalizer 는 1회 — seam 이 빠지면 축소 측정이다");
    assert.equal(statCalls, 1, "의도 호출은 1회");
    assert.equal(genericCalls, 1, "일반 재질의는 1회");
    assert.deepEqual(rewriteCalls, [draft], "rewrite 는 폐기 원문으로 정확히 1회");
    assert.equal(
      normalizerCalls + statCalls + genericCalls + rewriteCalls.length, 4,
      "production full seam 총 호출 상한 4",
    );
    // 토큰은 네 호출 전부 합산 — 과금 관측 누락 방지.
    assert.equal(logs.at(-1)?.inputTokens, 7 + 11 + 100 + 1000);
    assert.equal(logs.at(-1)?.outputTokens, 2 + 1 + 30 + 300);
    ok("P1 stat RULE_TERM — full seam 총 최대 4회(rewrite 1) · 4호출 토큰 합산");
  }

  // 같은 분기에서 답이 **범위밖+톤** 이중결함이면 rewrite 는 0 — 총 2회에서 멈춰야 한다.
  {
    let statCalls = 0;
    let genericCalls = 0;
    const rewriteCalls: string[] = [];
    const deps: QaDeps = {
      loadGlossary: async () => [],
      loadPlayers: async () => [],
      getCache: async () => null,
      setCache: async () => {},
      reserveDaily: async () => ({ allowed: true, remaining: 19 }),
      callLlm: async (
        _q: string, _ctx: unknown, _roster: unknown, statNumericGuard?: boolean,
      ) => {
        if (statNumericGuard) {
          statCalls += 1;
          return {
            text: JSON.stringify({ status: "BASEBALL_RULE_TERM", answer: "RULE_TERM" }),
            inputTokens: 11, outputTokens: 1,
          };
        }
        genericCalls += 1;
        return { text: json("오늘 날씨는 맑아요."), inputTokens: 100, outputTokens: 30 };
      },
      rewriteLlmTone: async (d: string) => {
        rewriteCalls.push(d);
        return { text: json("오늘 날씨는 맑습니다."), inputTokens: 1000, outputTokens: 300 };
      },
      storeLlm: async () => {},
      log: async () => {},
    } as unknown as QaDeps;
    const result = await answerQuestion("tone-stat-user", "이대호 홈런 몇개", deps);
    assert.notEqual(result.source, "llm");
    assert.deepEqual(rewriteCalls, [], "가드 분기에서도 이중결함은 rewrite 0");
    assert.equal(statCalls + genericCalls + rewriteCalls.length, 2);
    ok("P1 stat RULE_TERM — 이중결함은 rewrite 0 · 총 2회");
  }

  // seam 미주입·비톤 결함은 rewrite 0.
  {
    const draft = "야구에서 보크를 반칙으로 여겨요.";
    const noSeam = await runWith(json(draft), [], false);
    assert.equal(noSeam.source, "unsure");
    assert.equal(noSeam.rewriteCalls.length, 0);
    const unsafe = await runWith(json("야구 답변은 https://example.com 입니다."));
    assert.equal(unsafe.source, "unsure");
    assert.equal(unsafe.rewriteCalls.length, 0);
    ok("종단 비활성/비톤 결함 — rewrite 0");
  }

  console.log(`ALL PASS (${passed})`);
}

main().catch((error) => {
  console.error("[GTR-FAIL]", error);
  process.exitCode = 1;
});
