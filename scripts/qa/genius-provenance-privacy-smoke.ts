/**
 * 야잘알봇 출처 표시 — **내부 메타 노출 금지** 회귀 게이트 (하린아빠 2026-08-05 P0).
 *
 * 사고: 유저 화면에 `rev crawled:2026-08-02T02:59:26.899Z · 2026-08-02 기준` + 전체 URL 이
 * 그대로 나갔다. `crawled` 는 외부 문서를 수집한다는 사실을 화면에 적는 것이라 위험하다.
 *
 * 이 게이트가 브라우저 게이트와 별도로 존재하는 이유(삼순 P0-3):
 *   실브라우저 스모크는 Chromium 이 필요해 Vercel prebuild 에서 graceful skip 된다.
 *   그러면 required 경로에서 검증력이 0이 된다(#1085 에서 실제로 겪은 false-green).
 *   그래서 **Chromium 없이 결정론적으로** 도는 이 게이트를 prebuild 에 결속한다.
 *
 * 소스 문자열 매칭이 아니라 **배포되는 함수를 실제로 실행**하고, 화면 컴포넌트가 그 함수에
 * 실제로 바인딩돼 있는지는 TypeScript 심볼 해석으로 확인한다(문자열 검사는 alias·shadow 로
 * 뚫린다 — #1093 에서 겪음).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import {
  PROVENANCE_LABELS,
  displayProvenanceOf,
  findLeakedInternalMeta,
  resolveAllowedSource,
  splitProvenanceForDisplay,
  stripProvenanceForPreview,
} from "../../src/lib/baseball-qa/genius-reply-provenance";
import { composeRagAnswer } from "../../src/lib/baseball-qa/rag/retrieve";
import { isGeniusReplyPayload } from "../../src/lib/constants/baseball-genius";

let pass = 0;
const failures: string[] = [];
function check(name: string, fn: () => void): void {
  try {
    fn();
    pass += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`FAIL ${name} :: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const NAMU_URL = "https://namu.wiki/w/%EB%AC%B8%EB%B3%B4%EA%B2%BD";
const WIKI_URL = "https://ko.wikipedia.org/wiki/문보경";
const KBO_URL = "https://www.koreabaseball.com/kbo/board/ebook/ebookpublication.aspx";

/** 하린아빠 스크린샷에 실제로 찍힌 그 본문. 이게 회귀 기준점이다. */
const LEGACY_BODY =
  "문보경 선수는 중요한 순간마다 제 역할을 해줄 때 문보물이라는 별명으로 불립니다.\n\n" +
  `📄 출처: 문보경 (${NAMU_URL}) · rev crawled:2026-08-02T02:59:26.899Z · 2026-08-02 기준`;

const CURRENT_BODY = "문보경 선수의 별명은 문보물이에요.\n\n📄 출처: 나무위키";

// ── 1. 서빙 문자열 자체에 내부 메타가 없어야 한다 ──────────────────────────────
check("composeRagAnswer 결과에 내부 메타 0건", () => {
  for (const [url, grade, expected] of [
    [NAMU_URL, "tier2", PROVENANCE_LABELS.namu],
    [WIKI_URL, "tier2", PROVENANCE_LABELS.wikipedia],
    [KBO_URL, "tier1", PROVENANCE_LABELS.official],
  ] as const) {
    const answer = composeRagAnswer("답변입니다.", {
      content: "근거",
      pageTitle: "문보경",
      canonicalUrl: url,
      revision: "crawled:2026-08-02T02:59:26.899Z",
      sectionPath: "문보경/선수 경력/2024년",
      asOf: "2026-08-02",
      sourceGrade: grade,
    });
    assert.equal(answer.endsWith(`📄 출처: ${expected}`), true, `표시명 불일치: ${answer}`);
    assert.deepEqual(findLeakedInternalMeta(answer), [], `내부 메타 노출: ${answer}`);
    assert.equal(answer.includes("선수 경력/2024년"), false, "sectionPath 가 노출되면 안 된다");
  }
});

// ── 2. 구 표기(이미 발송된 과거 답변)를 표시 시점에 잘라낸다 ────────────────────
check("구 표기 상세 — 본문 분리 + 링크 복원", () => {
  const { body, provenance } = splitProvenanceForDisplay(LEGACY_BODY);
  assert.deepEqual(findLeakedInternalMeta(body), [], `본문에 내부 메타 잔존: ${body}`);
  assert.equal(body.endsWith("불립니다."), true, body);
  assert.equal(provenance?.label, PROVENANCE_LABELS.namu);
  assert.equal(provenance?.url, NAMU_URL);
});

check("구 표기 목록 미리보기 — 출처 줄 통째로 제거 (삼순 P0-1)", () => {
  const preview = stripProvenanceForPreview(LEGACY_BODY);
  assert.deepEqual(findLeakedInternalMeta(preview), [], `미리보기에 내부 메타 잔존: ${preview}`);
  assert.equal(preview.includes("📄 출처"), false, "미리보기엔 출처 줄 자체가 없어야 한다");
  assert.equal(stripProvenanceForPreview(CURRENT_BODY).includes("출처"), false);
  // null/undefined 도 안전해야 한다 — 목록은 last_message 가 null 일 수 있다.
  assert.equal(stripProvenanceForPreview(null), "");
  assert.equal(stripProvenanceForPreview(undefined), "");
});

check("신규 표기 — 표시명 분리 + payload 링크 결합", () => {
  const { body, provenance } = splitProvenanceForDisplay(CURRENT_BODY, NAMU_URL);
  assert.equal(body, "문보경 선수의 별명은 문보물이에요.");
  assert.equal(provenance?.label, PROVENANCE_LABELS.namu);
  assert.equal(provenance?.url, NAMU_URL);
});

check("정상 본문은 잘라내지 않는다", () => {
  for (const body of [
    "보크는 투수의 반칙 동작이에요.",
    "이 기사 📄 출처: 어딘가 라고 적힌 유저 문장",
    "",
  ]) {
    const result = splitProvenanceForDisplay(body);
    assert.equal(result.body, body, `정상 본문이 잘렸다: ${body}`);
    assert.equal(result.provenance, null);
  }
});

// ── 3. URL allowlist — 임의 외부 주소가 링크·라벨이 되면 안 된다 (삼순 P0-2) ──
check("허용 도메인만 링크가 된다", () => {
  assert.equal(resolveAllowedSource(NAMU_URL)?.label, PROVENANCE_LABELS.namu);
  assert.equal(resolveAllowedSource(WIKI_URL)?.label, PROVENANCE_LABELS.wikipedia);
  assert.equal(resolveAllowedSource(KBO_URL)?.label, PROVENANCE_LABELS.official);
});

check("allowlist 밖·위장·비 https 는 전부 거절", () => {
  const rejected = [
    "https://evil.example/w/x",
    // 서브도메인 위장 — 문자열 startsWith 로는 뚫린다.
    "https://namu.wiki.evil.com/w/x",
    // userinfo 위장 — hostname 은 evil.com 이다.
    "https://namu.wiki@evil.com/w/x",
    // 평문 http (구 본문에 섞일 수 있다)
    "http://namu.wiki/w/x",
    "javascript:alert(1)",
    "data:text/html,<script>",
    "not a url",
    "",
    null,
    undefined,
  ];
  for (const url of rejected) {
    assert.equal(resolveAllowedSource(url), null, `거절돼야 한다: ${String(url)}`);
  }
});

check("payload 검증이 allowlist 를 실제로 태운다", () => {
  const base = { type: "baseball_genius_reply", reply_kind: "answer", match_path: "rag" };
  assert.equal(isGeniusReplyPayload({ ...base, source_url: NAMU_URL }), true);
  for (const bad of [
    "https://evil.example/x",
    "https://namu.wiki.evil.com/x",
    "https://namu.wiki@evil.com/x",
    "javascript:alert(1)",
    "http://namu.wiki/w/x",
  ]) {
    assert.equal(isGeniusReplyPayload({ ...base, source_url: bad }), false, `payload 거절 실패: ${bad}`);
  }
});

check("구 본문의 허용 밖 URL 은 링크 없이 fail-close", () => {
  const body =
    "답변입니다.\n\n📄 출처: 어떤문서 (https://evil.example/x) · rev crawled:2026-08-02T00:00:00.000Z · 2026-08-02 기준";
  const { body: stripped, provenance } = splitProvenanceForDisplay(body);
  assert.deepEqual(findLeakedInternalMeta(stripped), [], stripped);
  assert.equal(provenance, null, "허용 밖 URL 이 링크가 되면 안 된다");
});

check("displayProvenanceOf 는 허용 밖이면 링크를 비운다", () => {
  const result = displayProvenanceOf({ canonicalUrl: "https://evil.example/x", sourceGrade: "tier2" });
  assert.equal(result.url, "", "허용 밖 URL 을 링크로 내보내면 안 된다");
});

// ── 4. actual wiring — 화면 컴포넌트가 그 함수를 실제로 쓰는가 ──────────────────
//
// 문자열 `includes` 는 alias·local shadow 로 뚫린다. TS 심볼 해석으로 **import 여부와
// 원본 모듈**까지 확인한다.
const PROVENANCE_MODULE = "genius-reply-provenance";

function assertImportsFrom(filePath: string, expectedNames: string[]): void {
  const abs = path.join(process.cwd(), filePath);
  const source = ts.createSourceFile(abs, readFileSync(abs, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const imported = new Set<string>();
  source.forEachChild((node) => {
    if (!ts.isImportDeclaration(node)) return;
    const spec = node.moduleSpecifier;
    if (!ts.isStringLiteral(spec) || !spec.text.includes(PROVENANCE_MODULE)) return;
    const bindings = node.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) imported.add((element.propertyName ?? element.name).text);
    }
  });
  for (const name of expectedNames) {
    assert.equal(imported.has(name), true, `${filePath} 가 ${PROVENANCE_MODULE} 의 ${name} 을 import 해야 한다`);
  }
}

/** 식별자가 그 파일에서 **실제로 호출**되는지. import 만 해두고 안 쓰면 의미가 없다. */
function assertCalled(filePath: string, name: string): void {
  const abs = path.join(process.cwd(), filePath);
  const source = ts.createSourceFile(abs, readFileSync(abs, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let called = false;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) {
      called = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.equal(called, true, `${filePath} 에서 ${name}() 이 실제로 호출돼야 한다`);
}

const DETAIL_PAGE = "src/app/(main)/messages/[conversationId]/page.tsx";
const LIST_PAGE = "src/app/(main)/messages/page.tsx";

check("쪽지 상세가 splitProvenanceForDisplay 를 실제로 호출", () => {
  assertImportsFrom(DETAIL_PAGE, ["splitProvenanceForDisplay"]);
  assertCalled(DETAIL_PAGE, "splitProvenanceForDisplay");
});

check("쪽지 목록이 stripProvenanceForPreview 를 실제로 호출 (삼순 P0-1)", () => {
  assertImportsFrom(LIST_PAGE, ["stripProvenanceForPreview"]);
  assertCalled(LIST_PAGE, "stripProvenanceForPreview");
});

check("목록이 last_message 를 정규화 없이 그대로 렌더하지 않는다", () => {
  const raw = readFileSync(path.join(process.cwd(), LIST_PAGE), "utf8");
  // `{conv.last_message ...}` 형태의 직접 렌더가 남아 있으면 회귀다.
  assert.equal(
    /\{\s*conv\.last_message\s*(\|\||\})/.test(raw),
    false,
    "목록이 last_message 를 정규화 없이 렌더하고 있다",
  );
});

check("금칙 판정기가 실제로 검출력을 갖는다", () => {
  assert.deepEqual(findLeakedInternalMeta("깨끗한 답변이에요."), []);
  assert.ok(findLeakedInternalMeta("rev crawled:2026-08-02T02:59:26.899Z").length >= 2);
  assert.ok(findLeakedInternalMeta("2026-08-02 기준").includes("기준일"));
  assert.ok(findLeakedInternalMeta(`(${NAMU_URL})`).includes("평문 URL"));
});

if (failures.length > 0) {
  console.error(`\n❌ genius provenance privacy FAIL=${failures.length} :: ${failures.join(", ")}`);
  process.exit(1);
}
console.log(`\n✅ genius provenance privacy PASS=${pass} FAIL=0`);
