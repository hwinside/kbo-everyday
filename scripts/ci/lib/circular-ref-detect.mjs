/**
 * 순환참조 검출기 (축② 핵심 순수함수).
 *
 * 순환참조 안티패턴 = "크롤이 매일 갱신하는 관리 데이터 파일에서 읽은 값을, 소스코드에
 * 박힌 리터럴 기대값과 assert 비교". 크롤이 값을 바꾸면 게이트가 RED → 자동 업데이트 차단.
 *
 * 두 규칙:
 *   규칙1(애노테이션 강제): 관리파일을 readFileSync/import 하는 QA/CI 파일은 상단에
 *     `@crawl-managed-read: structural|fixture` 를 선언해야 한다. 없으면 위반.
 *   규칙2(값 하드코딩 정적 검출): 관리파일 read 로 바인딩된 변수(및 그로부터 파생된 변수)를
 *     리터럴(숫자/문자열)과 assert.equal/strictEqual/deepEqual 비교하면 위반.
 *     한 줄 위에 `// @crawl-ref-allow: <이유>` 가 있으면 그 assert 만 면제(합성 fixture 등).
 *
 * TypeScript 컴파일러 API 로 .mjs/.ts 를 함께 파싱한다(repo 에 이미 의존성 존재).
 */
import ts from "typescript";
import { matchManagedFile, parseManagedReadAnnotation } from "./crawl-managed-registry.mjs";

const ASSERT_EQ = new Set(["equal", "strictEqual", "deepEqual", "deepStrictEqual"]);

/** node 가 readFileSync(<managed>) 또는 그것을 감싼 JSON.parse 이면 매치된 basename 반환. */
function managedReadBasename(node) {
  if (!ts.isCallExpression(node)) return null;
  // JSON.parse(readFileSync(...)) → 내부 인자를 재귀 확인
  const callee = node.expression;
  const calleeName = ts.isPropertyAccessExpression(callee)
    ? callee.name.text
    : ts.isIdentifier(callee)
      ? callee.text
      : "";
  if (calleeName === "parse") {
    for (const arg of node.arguments) {
      const inner = managedReadBasename(arg);
      if (inner) return inner;
    }
    return null;
  }
  if (calleeName === "readFileSync" || calleeName === "readFile") {
    const first = node.arguments[0];
    if (!first) return null;
    return managedPathFromExpr(first);
  }
  return null;
}

/** 문자열 리터럴 / join(...,"x.json") / 템플릿에서 관리파일 basename 추출. */
function managedPathFromExpr(expr) {
  if (ts.isStringLiteralLike(expr)) return matchManagedFile(expr.text);
  // join(DIR, "players-roster.json") → 인자들 중 관리파일 매치
  if (ts.isCallExpression(expr)) {
    for (const a of expr.arguments) {
      const hit = managedPathFromExpr(a);
      if (hit) return hit;
    }
  }
  // `${DIR}/players-roster.json` 템플릿
  if (ts.isTemplateExpression(expr)) {
    const tail = expr.templateSpans.map((s) => s.literal.text).join("");
    const head = expr.head.text;
    return matchManagedFile(head + tail);
  }
  return null;
}

/** member/call 체인의 뿌리 식별자 이름을 반환(pitchers.find(...).era → "pitchers"). */
function rootIdentifier(node) {
  let cur = node;
  while (cur) {
    if (ts.isIdentifier(cur)) return cur.text;
    if (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) {
      cur = cur.expression;
    } else if (ts.isCallExpression(cur)) {
      cur = cur.expression;
    } else if (ts.isNonNullExpression(cur) || ts.isParenthesizedExpression(cur)) {
      cur = cur.expression;
    } else {
      return null;
    }
  }
  return null;
}

function isLiteralOperand(node) {
  let n = node;
  if (ts.isPrefixUnaryExpression(n)) n = n.operand; // -2.64
  return (
    ts.isNumericLiteral(n) ||
    ts.isStringLiteralLike(n) ||
    n.kind === ts.SyntaxKind.TrueKeyword ||
    n.kind === ts.SyntaxKind.FalseKeyword
  );
}

/**
 * @param {string} source  소스 코드
 * @param {string} fileName  진단용 파일명(.ts/.mjs 판별)
 * @returns {{ reads: string[], annotation: object|null, violations: Array<{rule:string,line:number,detail:string}> }}
 */
export function detectCircularRefs(source, fileName) {
  const scriptKind = /\.ts$/.test(fileName) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind);
  const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  const reads = new Set();
  const violations = [];

  // ── 스코프 인식 taint 분석 ──
  // 각 스코프(함수/소스파일)마다 tainted 변수명 Set 을 두고 scope chain 으로 해석한다.
  // 변수명만 보는 전역 Set 은 다른 함수의 동명이인(예: 합성 mock 의 `rows` vs 관리파일 유래
  // `rows`)을 섞어 오검출을 낸다. 그래서 선언은 현재 스코프에만 등록하고, 참조는 안쪽→바깥
  // 스코프 순으로 가장 가까운 선언을 찾는다(shadowing 존중).
  const isFnScope = (n) =>
    ts.isFunctionDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isConstructorDeclaration(n) ||
    ts.isGetAccessorDeclaration(n) ||
    ts.isSetAccessorDeclaration(n) ||
    ts.isSourceFile(n);

  // scopeStack[i] = Set<변수명> tainted in that scope
  const scopeStack = [new Set()];
  const taintedInChain = (name) => {
    for (let i = scopeStack.length - 1; i >= 0; i--) {
      if (scopeStack[i].has(name)) return true;
    }
    return false;
  };

  // import x from "...managed.json" → 최상위(파일) 스코프에 taint
  const collectImports = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const base = matchManagedFile(node.moduleSpecifier.text);
      if (base) {
        reads.add(base);
        const clause = node.importClause;
        if (clause?.name) scopeStack[0].add(clause.name.text);
      }
    }
    ts.forEachChild(node, collectImports);
  };
  collectImports(sf);

  // 스코프를 따라 내려가며: (1) 관리파일 read 바인딩 + tainted-root 파생 바인딩을 현재 스코프에 등록
  // (2) assert.equal(tainted, literal) 검출. 선언이 참조보다 먼저 방문되도록 DFS 순서를 쓴다
  // (JS/TS 의 순차적 const 선언·사용 패턴에서 충분. 함수 스코프 단위 격리가 핵심).
  const walkScopes = (node) => {
    const opensScope = isFnScope(node) && !ts.isSourceFile(node);
    if (opensScope) scopeStack.push(new Set());

    // 변수 선언: 관리파일 read 이거나 tainted-root 파생이면 현재 스코프에 등록
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
      const base = managedReadBasename(node.initializer);
      if (base) {
        reads.add(base);
        scopeStack[scopeStack.length - 1].add(node.name.text);
      } else {
        const root = rootIdentifier(node.initializer);
        if (root && taintedInChain(root)) {
          scopeStack[scopeStack.length - 1].add(node.name.text);
        }
      }
    }

    checkAssert(node);
    ts.forEachChild(node, walkScopes);
    if (opensScope) scopeStack.pop();
  };

  // ── 규칙2: assert.equal(tainted-chain, literal) 검출 ──
  const allowLines = new Set();
  // `// @crawl-ref-allow` 가 붙은 라인 다음 assert 를 면제(주석은 대상 표현식 바로 위/같은 줄).
  const commentRe = /@crawl-ref-allow\b/;
  source.split(/\r?\n/).forEach((ln, i) => {
    if (commentRe.test(ln)) {
      allowLines.add(i + 1); // 같은 줄
      allowLines.add(i + 2); // 바로 다음 줄
    }
  });

  // assert.equal/strictEqual(tainted-chain, literal) — 현재 scope chain 기준 taint 판정.
  function checkAssert(node) {
    if (!(ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression))) return;
    const method = node.expression.name.text;
    const recvRoot = rootIdentifier(node.expression.expression);
    if (!(ASSERT_EQ.has(method) && (recvRoot === "assert" || recvRoot === "strict"))) return;
    const [a, b] = node.arguments;
    if (!a || !b) return;
    const aRoot = rootIdentifier(a);
    const bRoot = rootIdentifier(b);
    const aTaint = aRoot && taintedInChain(aRoot);
    const bTaint = bRoot && taintedInChain(bRoot);
    const taintLit = (aTaint && isLiteralOperand(b)) || (bTaint && isLiteralOperand(a));
    if (!taintLit) return;
    const line = lineOf(node);
    if (allowLines.has(line)) return;
    violations.push({
      rule: "value-hardcode",
      line,
      detail: `관리파일 유래 값(${aTaint ? aRoot : bRoot})을 리터럴과 ${method} 비교`,
    });
  }

  walkScopes(sf);

  // ── 규칙1: 관리파일을 read 하는데 애노테이션이 없거나 잘못됨 ──
  const annotation = parseManagedReadAnnotation(source);
  if (reads.size > 0) {
    if (!annotation) {
      violations.push({
        rule: "missing-annotation",
        line: 1,
        detail: `관리파일(${[...reads].join(", ")})을 읽는데 @crawl-managed-read 애노테이션이 없다`,
      });
    } else if (annotation.mode === null) {
      violations.push({
        rule: "invalid-annotation",
        line: 1,
        detail: `@crawl-managed-read 모드가 잘못됨: '${annotation.raw}' (structural|fixture 만 허용)`,
      });
    }
  }

  return { reads: [...reads], annotation, violations };
}
