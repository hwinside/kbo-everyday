/** Reviewer-owned execution. Source/loader/runtime contracts; not a substitute
 * for source-PDF comparison or post-application End-User QA. No network/DB. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { answerQuestion, type QaDeps } from "../../src/lib/baseball-qa/pipeline";
import { requiredRuleEvidence, selectRequiredRuleEvidence } from "../../src/lib/baseball-qa/rag/required-rule-evidence";
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
    ["FA 자격 조건은?", "일반 FA 자격은 8정규시즌 활동이 필요하며, 현역 등록일수 145일을 기준으로 합니다.", "일반 FA"],
    ["가을야구 진출 기준", "정규시즌 승률 5위까지 포스트시즌에 참가합니다.", ""],
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
  assert.equal(scope.size, 3);
  assert.equal(requiredRuleEvidence("아웃 원인이 뭐야?", NOW), null);
  assert.doesNotMatch(JSON.stringify(buildRagLlmRequest("아웃 원인이 뭐야?", [], RAG_OFFICIAL_SYSTEM_PROMPT)), /<요청 범위/);
  const legacy = { ...ev[0], content: "제46조 경기. 연장전 15회를 마친 경우 성립된다.", sectionPath: "2026 KBO 리그 규정#p48" };
  assert.deepEqual(selectRequiredRuleEvidence([legacy], regular), []);
}

async function main() { verifyArtifact(); verifyLoader(); await verifyRuntime(); console.log("Required-rule corpus artifact/loader/runtime contracts PASS; live semantic/UI QA remains reviewer-owned."); }
main().catch((error) => { console.error(error); process.exitCode = 1; });
