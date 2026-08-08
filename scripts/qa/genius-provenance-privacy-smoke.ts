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
  const preview = stripProvenanceForPreview(LEGACY_BODY, true);
  assert.deepEqual(findLeakedInternalMeta(preview), [], `미리보기에 내부 메타 잔존: ${preview}`);
  assert.equal(preview.includes("📄 출처"), false, "미리보기엔 출처 줄 자체가 없어야 한다");
  assert.equal(stripProvenanceForPreview(CURRENT_BODY, true).includes("출처"), false);
  // null/undefined 도 안전해야 한다 — 목록은 last_message 가 null 일 수 있다.
  assert.equal(stripProvenanceForPreview(null, true), "");
  assert.equal(stripProvenanceForPreview(undefined, true), "");
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

check("허용 밖 canonical 은 출처 자체가 null — 라벨을 지어내지 않는다 (삼순 P0-1)", () => {
  // 종전 구현은 tier2 면 `나무위키`, tier1 이면 `KBO 공식 자료` 로 폴백했다.
  // 그건 어디서 왔는지 모르는 근거에 유명 출처 이름을 붙이는 것이라 링크 노출보다 나쁘다.
  for (const grade of ["tier1", "tier2", undefined] as const) {
    const result = displayProvenanceOf({ canonicalUrl: "https://evil.example/x", sourceGrade: grade });
    assert.equal(result, null, `허용 밖인데 출처가 생성됐다(grade=${String(grade)}): ${JSON.stringify(result)}`);
  }
  // 서빙 문자열에도 출처 줄 자체가 안 붙어야 한다.
  const answer = composeRagAnswer("답변입니다.", {
    content: "근거", pageTitle: "x", canonicalUrl: "https://evil.example/x",
    revision: "r", sectionPath: "본문", asOf: "2026-08-02", sourceGrade: "tier1",
  });
  assert.equal(answer.includes("출처"), false, `허용 밖 근거에 출처 표기가 붙었다: ${answer}`);
  assert.equal(answer.includes(PROVENANCE_LABELS.official), false, "거짓 라벨이 붙으면 안 된다");
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

/**
 * 식별자가 **JSX 렌더 트리 안에서** 그 인자로 실제로 호출되는지 (삼순 P0-2).
 *
 * 종전 구현은 "파일 어딘가에서 1회 호출"만 봤다. 그러면 decoy 로
 * `stripProvenanceForPreview("")` 를 한 줄 남겨두고 실제 렌더는 raw 값을 alias 로
 * 그려도 GREEN 이다. 그래서 **JsxExpression 안에서** 호출되고 **기대 인자 식별자**를
 * 받는지까지 고정한다.
 */
function assertCalledInJsxWithArg(filePath: string, fn: string, argMatcher: RegExp): void {
  const abs = path.join(process.cwd(), filePath);
  const source = ts.createSourceFile(abs, readFileSync(abs, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let ok = false;
  const findCall = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === fn) {
      const firstArg = node.arguments[0];
      if (firstArg && argMatcher.test(firstArg.getText(source))) ok = true;
    }
    ts.forEachChild(node, findCall);
  };
  const visit = (node: ts.Node): void => {
    // JSX 표현식({ ... }) 안쪽만 대상으로 한다 — 렌더에 실제로 쓰이는 자리.
    if (ts.isJsxExpression(node)) findCall(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.equal(ok, true, `${filePath} 의 JSX 안에서 ${fn}(${argMatcher.source}) 이 호출돼야 한다`);
}

const DETAIL_PAGE = "src/app/(main)/messages/[conversationId]/page.tsx";
const LIST_PAGE = "src/app/(main)/messages/page.tsx";

check("쪽지 상세가 msg.content 로 splitProvenanceForDisplay 를 실제 호출", () => {
  assertImportsFrom(DETAIL_PAGE, ["splitProvenanceForDisplay"]);
  // 상세는 JSX 밖(파생 변수)에서 호출하므로 인자 결속만 고정한다.
  const abs = path.join(process.cwd(), DETAIL_PAGE);
  const raw = readFileSync(abs, "utf8");
  assert.match(raw, /splitProvenanceForDisplay\(\s*msg\.content/, "실제 메시지 본문을 넘겨야 한다");
  // 그리고 그 결과가 렌더에 쓰여야 한다.
  assertCalledInJsxWithArg(DETAIL_PAGE, "linkifyText", /displayContent/);
});

check("쪽지 목록이 JSX 안에서 last_message 로 호출 (삼순 P0-1·P0-2)", () => {
  assertImportsFrom(LIST_PAGE, ["stripProvenanceForPreview"]);
  // decoy 호출을 남기고 raw 값을 alias 로 렌더하면 GREEN 이던 구멍을 막는다.
  assertCalledInJsxWithArg(LIST_PAGE, "stripProvenanceForPreview", /conv\.last_message/);
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

check("일반 DM 은 정규화 대상이 아니다 (삼순 P1)", () => {
  // 유저가 쓴 문장이 우연히 출처 suffix 모양이면 잘려나간다. 야잘알봇 대화에만 적용한다.
  const userText = "이거 봐봐\n\n📄 출처: 나무위키";
  assert.equal(stripProvenanceForPreview(userText), userText, "일반 DM 이 잘렸다");
  assert.equal(stripProvenanceForPreview(userText, false), userText);
  // 야잘알봇 대화로 명시했을 때만 잘라낸다.
  assert.equal(stripProvenanceForPreview(userText, true), "이거 봐봐");
  // legacy 본문도 마찬가지 — 일반 DM 이면 손대지 않는다.
  assert.equal(stripProvenanceForPreview(LEGACY_BODY), LEGACY_BODY);
  assert.equal(stripProvenanceForPreview(LEGACY_BODY, true).includes("crawled"), false);
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
