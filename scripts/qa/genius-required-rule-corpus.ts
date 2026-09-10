/** Reviewer-owned execution. Source/loader/runtime contracts; not a substitute
 * for source-PDF comparison or post-application End-User QA. No network/DB. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { answerQuestion, routeQuestion, type QaDeps } from "../../src/lib/baseball-qa/pipeline";
import { requiredRuleEvidence, selectRequiredRuleEvidence, requiredRuleFact } from "../../src/lib/baseball-qa/rag/required-rule-evidence";
import { buildRagLlmRequest, RAG_OFFICIAL_SYSTEM_PROMPT, type RagEvidence } from "../../src/lib/baseball-qa/rag/retrieve";

const corpus = path.resolve("data/baseball-qa/kbo-required-rules-2026.jsonl");
const manifest = path.resolve("data/baseball-qa/kbo-required-rules-2026.manifest.json");
const loader = path.resolve("scripts/baseball-qa/rag/load-official-corpus.mjs");
const raw = fs.readFileSync(corpus, "utf8");
type Row = { file: string; title: string; entity: string; text: string; page: number; page_end: number; article_number: number; section: string; fetchedAt: string; sourcePdfSha256: string; documentChunkCount: number; documentOrdinal: number; atomic: boolean; extractorRevision: string };
const rows: Row[] = raw.trim().split("\n").map((s) => JSON.parse(s));
const urls = JSON.parse(fs.readFileSync(manifest, "utf8")) as Record<string, string>;
const audit = JSON.parse(fs.readFileSync("data/baseball-qa/kbo-required-rules-2026.audit.json", "utf8"));
const evidence = (data: Row[]): RagEvidence[] => data.map((r) => ({
  content: r.text, pageTitle: r.title, sectionPath: r.title + "#" + r.section,
  canonicalUrl: urls[r.file], revision: "fixture", asOf: r.fetchedAt.slice(0, 10), sourceGrade: "tier1", sourceKind: "kbo_ebook",
}));
const NOW = Date.parse("2026-09-09T06:00:00Z");
const normalized = (s: string) => s.replace(/\s/g, "");

function verifyArtifact() {
  assert.equal(crypto.createHash("sha256").update(raw).digest("hex"), audit.outputSha256);
  assert.equal(rows.length, 18);
  assert.ok(rows.every((r) => r.atomic && r.text.length <= 780 && r.page <= r.page_end));
  const league = rows.filter((r) => r.file === "2026_리그규정.pdf");
  const fa = rows.filter((r) => r.file === "2026_야구규약.pdf");
  assert.deepEqual([...new Set(league.map((r) => r.article_number))], [1, 30, 34, 38, 42, 46]);
  assert.deepEqual([...new Set(fa.map((r) => r.article_number))], [161, 162, 163, 164]);
  const innings = normalized(league.find((r) => r.article_number === 1)!.text);
  assert.match(innings, /연장전은11회\(KBO포스트시즌15회\)까지/);
  assert.doesNotMatch(innings, /연장전은12회/);
  const eligibility = normalized(fa.filter((r) => r.article_number === 162).map((r) => r.text).join("\n"));
  for (const fact of ["2022년시즌종료후부터는8정규시즌", "2006년정규시즌이후최초로현역선수로등록한선수", "145일이상", "2022년시즌종료후부터7정규시즌으로단축", "계약기간이종료되는해까지유보"]) {
    assert.ok(eligibility.includes(fact), "Missing operative condition: " + fact);
  }
}

function verifyLoader() {
  const good = execFileSync(process.execPath, [loader, "--corpus=" + corpus, "--manifest=" + manifest], { encoding: "utf8" });
  assert.match(good, /총 chunk\s+: 18/);
  assert.match(good, /DRY-RUN 종료/);
  assert.match(good, /리그-규정-필수-조항/);
  assert.match(good, /야구규약-필수-조항/);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "required-rules-gate-"));
  try {
    const mutations: [string, (r: Row[]) => void][] = [
      ["partial", (r) => { r.pop(); }],
      ["duplicate", (r) => { r[1] = structuredClone(r[0]); }],
      ["reorder", (r) => { const i = r.findIndex((x) => x.article_number === 162); [r[i], r[i + 1]] = [r[i + 1], r[i]]; }],
      ["original-source-overwrite", (r) => { for (const x of r) x.entity = x.title; }],
      ["wrong-pdf", (r) => { r[0].sourcePdfSha256 = "0".repeat(64); }],
      ["non-atomic", (r) => { r[0].atomic = false; }],
      ["wrong-document-profile", (r) => { for (const x of r) x.extractorRevision = "kbo-rulebook-boundaries-v3.1"; }],
    ];
    for (const [name, mutate] of mutations) {
      const changed = structuredClone(rows); mutate(changed);
      const file = path.join(temp, name + ".jsonl");
      fs.writeFileSync(file, changed.map((r) => JSON.stringify(r)).join("\n") + "\n");
      const run = spawnSync(process.execPath, [loader, "--corpus=" + file, "--manifest=" + manifest], { encoding: "utf8" });
      assert.notEqual(run.status, 0, name + " malformed input was accepted");
    }
    // --apply without a protected gateway must fail before credentials/DB calls.
    const unsafe = spawnSync(process.execPath, [loader, "--corpus=" + corpus, "--manifest=" + manifest, "--apply"], { encoding: "utf8" });
    assert.notEqual(unsafe.status, 0);
    assert.match(unsafe.stdout + unsafe.stderr, /protected_egress/);
    const limited = spawnSync(process.execPath, [loader, "--corpus=" + corpus, "--manifest=" + manifest, "--limit-chunks=1"], { encoding: "utf8" });
    assert.notEqual(limited.status, 0);
    assert.match(limited.stdout + limited.stderr, /must_load_whole_document/);
    const unverified = spawnSync(process.execPath, [loader, "--corpus=" + corpus, "--manifest=" + path.join(temp, "missing.json")], { encoding: "utf8" });
    assert.notEqual(unverified.status, 0, "Supplement accepted without official PDF provenance manifest");
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

async function verifyRuntime() {
  const ev = evidence(rows);
  const regular = requiredRuleEvidence("연장 최대 몇 회야?", NOW)!;
  const selected = selectRequiredRuleEvidence(ev, regular);
  assert.equal(selected.length, 1, "Primary regular-season clause with PS comparison was discarded");
  assert.match(selected[0].content, /11회/); assert.match(selected[0].content, /15회/);
  assert.deepEqual(selectRequiredRuleEvidence([{ ...selected[0], sourceGrade: "tier2" }], regular), []);
  assert.deepEqual(selectRequiredRuleEvidence([{ ...selected[0], pageTitle: "2025 KBO 리그 규정" }], regular), []);
  assert.deepEqual(selectRequiredRuleEvidence([{ ...selected[0], sectionPath: "2026 KBO 리그 규정#제5장 KBO 한국시리즈 > 제46조 경기규칙" }], regular), []);
  assert.deepEqual(selectRequiredRuleEvidence([{ ...selected[0], content: "KBO 정규시즌을 포함한 과거 경기표: 포스트시즌 연장 15회" }], regular), []);
  const fa = selectRequiredRuleEvidence(ev, requiredRuleEvidence("FA 자격 조건은?", NOW)!);
  assert.ok(fa.some((r) => r.sectionPath.includes("제163조")));
  assert.ok(fa.some((r) => r.content.includes("외국에 진출")), "General eligibility historical proviso was discarded as overseas-return scope");
  assert.ok(fa.every((r) => !r.sectionPath.includes("제164조")), "Overseas requalification replaced general eligibility");
  const scope = new Set<string>();
  for (const [question, answer, expected] of [
    ["연장 최대 몇 회야?", "KBO 정규시즌 연장전은 11회까지입니다.", "정규시즌"],
    ["포스트시즌 연장 최대 몇 회야?", "KBO 포스트시즌 연장전은 15회까지입니다.", "포스트시즌"],
    ["FA 자격 조건은?", "2022년 시즌 종료 후부터 일반 FA 자격은 8정규시즌 활동이 필요합니다.", "일반 FA"],
    ["준플레이오프는 몇 위 팀이 나가?", "정규시즌 승률 3위 구단과 와일드카드 결정전 승리구단이 준플레이오프에 참가합니다.", "준플레이오프"],
    ["준PO 몇 위가 나가?", "정규시즌 승률 3위 구단과 와일드카드 결정전 승리구단이 참가합니다.", "준플레이오프"],
    ["PO 몇 위 팀이 진출해?", "정규시즌 승률 2위 구단과 준플레이오프 승리구단이 참가합니다.", "플레이오프"],
    ["한국시리즈 몇 위가 나가?", "정규시즌 우승구단과 플레이오프 승리구단이 한국시리즈에 참가합니다.", "한국시리즈"],
    ["KS 진출 기준은?", "정규시즌 우승구단과 플레이오프 승리구단이 한국시리즈에 참가합니다.", "한국시리즈"],
    ["가을야구 진출 기준", "정규시즌 승률 5위까지 포스트시즌에 참가합니다.", "진출 순위"],
    ["4년제 대학 졸업하고 프로 오면 FA 몇 시즌 뛰어야 해?", "2022년 시즌 종료 후부터 대학선수로 등록한 4년제 대학 졸업 선수는 7정규시즌 활동으로 FA 자격을 취득합니다.", "일반 FA"],
    ["FA 한 시즌으로 인정받는 현역 등록일수가 며칠이야?", "2006년 정규시즌부터 현역 등록일수 145일 이상입니다. 이후 최초 등록한 선수는 제3호만 적용합니다.", "일반 FA"],
    ["포스트시즌은 정규시즌 몇 위까지 올라가?", "정규시즌 5위까지 진출하며 4위와 5위가 와일드카드 결정전을 치릅니다.", "진출 순위"],
  ]) {
    let calls = 0;
    const deps: QaDeps = {
      loadGlossary: async () => [], loadPlayers: async () => [],
      reserveDaily: async () => ({ allowed: true, remaining: 9 }), getCache: async () => null, setCache: async () => { throw new Error("policy answer cache write"); }, log: async () => {}, now: () => NOW,
      searchOfficialRag: async () => ev,
      callLlm: async () => { throw new Error("unexpected generic fallback"); },
      callOfficialRagLlm: async (q, e, extras) => {
        calls++;
        const request = buildRagLlmRequest(q, e, RAG_OFFICIAL_SYSTEM_PROMPT, extras);
        const data = request.contents[0].parts[0].text;
        if (extras?.ruleRequest?.kind === "fa_general") {
          assert.ok(extras.ruleRequest.fact, "operative source value omitted from scoped request");
          assert.ok(data.includes(extras.ruleRequest.fact.quote));
        } else {
          assert.equal(request.systemInstruction.parts[0].text, RAG_OFFICIAL_SYSTEM_PROMPT,
            "FA-only instruction changed an unrelated rule prompt");
        }
        if (expected) {
          assert.match(data, /<요청 범위/); assert.ok(data.includes(expected));
          scope.add(extras?.ruleRequest?.kind + ":" + extras?.ruleRequest?.competition);
        } else assert.doesNotMatch(data, /<요청 범위/);
        return { text: JSON.stringify({ status: "GROUNDED", answer }), inputTokens: 1, outputTokens: 1 };
      },
    };
    const result = await answerQuestion("qa-required-rules-memory", question, deps);
    assert.equal(result.source, "rag", question + " was not served from the approved evidence");
    assert.ok(result.answer.startsWith(answer)); assert.equal(calls, 1);
  }
  assert.equal(scope.size, 4);
  assert.equal(requiredRuleEvidence("아웃 원인이 뭐야?", NOW), null);
  assert.doesNotMatch(JSON.stringify(buildRagLlmRequest("아웃 원인이 뭐야?", [], RAG_OFFICIAL_SYSTEM_PROMPT)), /<요청 범위/);

  assert.notEqual(routeQuestion("4년제 대학 졸업하고 프로 오면 FA 몇 시즌 뛰어야 해?"), "blocked");
  assert.equal(routeQuestion("FA 기자회견 몇 시야?"), "blocked", "clock request remains outside scope");
  assert.equal(routeQuestion("FA 몇 시즌이야? 날씨도 알려줘"), "blocked", "mixed non-baseball request bypassed scope gate");
  for (const question of ["MLB FA 자격 조건", "해외 복귀 FA 자격", "FA 자격 재취득", "포스트시즌 진출할 확률은?"]) {
    assert.equal(requiredRuleEvidence(question, NOW), null, question + " overmatched current KBO policy");
  }
  // Standalone round names must choose that round's primary article rather
  // than accepting a wildcard cutoff from a neighbouring round.
  for (const [question, article] of [["준플레이오프는 몇 위 팀이 나가?", 34], ["준PO 몇 위야?", 34], ["플레이오프 몇 위야?", 38], ["po 몇 위야?", 38], ["한국시리즈 몇 위야?", 42], ["ks 몇 위야?", 42], ["와일드카드 몇 위야?", 30]] as const) {
    const request = requiredRuleEvidence(question, NOW)!;
    assert.equal(request.kind, "postseason_entry");
    assert.ok(request.query.includes(`제${article}조`));
    const scoped = selectRequiredRuleEvidence(ev, request);
    assert.ok(scoped.length > 0);
    assert.ok(scoped.every((row) => row.sectionPath.includes(`제${article}조`)));
    assert.deepEqual(selectRequiredRuleEvidence(ev.filter((row) => !row.sectionPath.includes(`제${article}조`)), request), []);
    assert.deepEqual(selectRequiredRuleEvidence(scoped.map((row) => ({ ...row, sourceGrade: "tier2" })), request), []);
  }
  for (const question of ["OPS 몇 위야?", "스포츠 몇 위야?", "MLB 플레이오프 몇 위까지?", "대학 플레이오프 몇 위?", "LG 준PO 진출할 확률은?", "한국시리즈 오늘 몇 위 팀이 이길까?"]) {
    assert.equal(requiredRuleEvidence(question, NOW), null, question);
  }
  assert.equal(requiredRuleEvidence("준PO 연장 몇 회야?", NOW)?.competition, "postseason");
  assert.equal(requiredRuleEvidence("KS 연장 몇 회야?", NOW)?.competition, "postseason");
  const sourceFa = requiredRuleEvidence("FA 자격은 어떻게 얻어?", NOW)!;
  const sourceDays = requiredRuleEvidence("FA 현역 등록일수가 며칠이야?", NOW)!;
  const sourceCollege = requiredRuleEvidence("대졸 FA 몇 시즌이야?", NOW)!;
  for (const [request, value] of [[sourceFa, "8"], [sourceDays, "145"], [sourceCollege, "7"]] as const) {
    const primary = selectRequiredRuleEvidence(ev, request);
    assert.equal(requiredRuleFact(primary, request)?.value, value);
    assert.equal(requiredRuleFact(primary.filter((r) => !r.content.includes("제162조")), request), null);
  }
  // Values follow the retrieved operative clause, not an app hard-code. Wrong
  // year/grade sources remain excluded by the selector before extraction.
  const changedDays = ev.map((r) => ({ ...r, content: r.content.replace("145일", "146일") }));
  assert.equal(requiredRuleFact(selectRequiredRuleEvidence(changedDays, sourceDays), sourceDays)?.value, "146");
  assert.equal(requiredRuleFact(selectRequiredRuleEvidence([...ev, ...changedDays], sourceDays), sourceDays), null,
    "conflicting operative values accepted by vector rank");
  const badAnswers = [
    ["준플레이오프는 몇 위 팀이 나가?", "와일드카드 결정전 승리구단이 참가합니다."],
    ["FA 자격은 어떻게 얻어?", "현역 등록일수와 출전 기준에 따라 정규시즌 활동을 인정합니다."],
    ["FA 현역 등록일수가 며칠이야?", "현역 등록일수가 150일 이상입니다. 연도별로 달리 적용합니다."],
    ["FA 현역 등록일수가 며칠이야?", "150일 이상입니다. 다만 2006년부터 145일입니다."],
    ["대졸 FA 몇 시즌이야?", "2022년부터 일반 선수와 같이 8정규시즌입니다."],
  ];
  for (const [question, answer] of badAnswers) {
    let stored: unknown;
    const deps: QaDeps = {
      loadGlossary: async () => [], loadPlayers: async () => [], reserveDaily: async () => ({ allowed: true, remaining: 9 }),
      getCache: async () => null, setCache: async () => {}, log: async () => {}, now: () => NOW,
      searchOfficialRag: async () => ev, storeLlm: async (result) => { stored = result; },
      callLlm: async () => { throw new Error("generic fallback must not repair policy"); },
      callOfficialRagLlm: async () => ({ text: JSON.stringify({ status: "GROUNDED", answer }), inputTokens: 1, outputTokens: 1 }),
    };
    const result = await answerQuestion("qa-current-criteria", question, deps);
    assert.equal(result.source, "scope_guide", "obsolete or incomplete policy was served: " + answer);
    assert.ok(JSON.stringify(stored).includes(result.answer), "durable final differs from served decline");
  }
  // Missing primary clause: a bounded second search must fetch it from serving,
  // never manufacture it from bundled JSONL or the model's own knowledge.
  for (const recovery of [true, false]) {
    let searches = 0, calls = 0;
    const deps: QaDeps = {
      loadGlossary: async () => [], loadPlayers: async () => [], reserveDaily: async () => ({ allowed: true, remaining: 9 }),
      getCache: async () => null, setCache: async () => {}, log: async () => {}, now: () => NOW,
      searchOfficialRag: async () => ++searches === 2 && recovery ? ev : ev.filter((r) => !r.content.includes("① 제25조")),
      callLlm: async () => { throw new Error("generic fallback"); },
      callOfficialRagLlm: async () => { calls++; return { text: JSON.stringify({ status: "GROUNDED", answer: "2022년 시즌 종료 후부터 8정규시즌을 활동하면 일반 FA 자격을 취득합니다." }), inputTokens: 1, outputTokens: 1 }; },
    };
    const result = await answerQuestion("qa-current-recovery", "FA 자격은 어떻게 얻어?", deps);
    assert.equal(searches, 2); assert.equal(calls, recovery ? 1 : 0);
    assert.equal(result.source, recovery ? "rag" : "scope_guide");
  }

  const legacy = { ...ev[0], content: "제46조 경기. 연장전 15회를 마친 경우 성립된다.", sectionPath: "2026 KBO 리그 규정#p48" };
  assert.deepEqual(selectRequiredRuleEvidence([legacy], regular), []);
}

async function main() { verifyArtifact(); verifyLoader(); await verifyRuntime(); console.log("Required-rule corpus artifact/loader/runtime contracts PASS; live semantic/UI QA remains reviewer-owned."); }
main().catch((error) => { console.error(error); process.exitCode = 1; });
