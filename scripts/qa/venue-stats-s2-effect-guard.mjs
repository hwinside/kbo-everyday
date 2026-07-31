#!/usr/bin/env node
/**
 * 직관 통계 S2 대시보드 effect 소스 가드 (AST).
 *
 * react-hooks/set-state-in-effect 는 이 컴포넌트에서 direct setter 재유입을 실제로 잡지 못했다
 * (삼순 4차 리뷰: 실제 파일 effect 안 `setData(null)` 주입에도 lint/tsc/smoke 전부 green).
 * 그래서 committed gate 로서 실제 소스를 직접 파싱해,
 * useEffect/useLayoutEffect 콜백 안에 useState setter 호출이 lexically 존재하면 FAIL 한다.
 *
 * 계약: "시즌 전환과 같은 틱에 로딩 UI" 는 렌더 파생으로만 유지한다.
 * 상태 전이는 이벤트 핸들러나 async 요청 경로에서만 일어나야 한다.
 */
import ts from "typescript";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const TARGETS = ["src/components/my/VenueStatsDashboard.tsx"];
const EFFECT_HOOKS = new Set(["useEffect", "useLayoutEffect", "useInsertionEffect"]);

let failures = 0;
let checkedEffects = 0;
let checkedSetters = 0;

for (const relative of TARGETS) {
  const filePath = resolve(process.cwd(), relative);
  const source = ts.createSourceFile(
    filePath,
    readFileSync(filePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );

  // 1) useState 구조분해에서 setter 이름 수집: const [x, setX] = useState(...)
  const setters = new Set();
  const collectSetters = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === "useState" &&
      node.name &&
      ts.isArrayBindingPattern(node.name) &&
      node.name.elements.length >= 2
    ) {
      const setterElement = node.name.elements[1];
      if (ts.isBindingElement(setterElement) && ts.isIdentifier(setterElement.name)) {
        setters.add(setterElement.name.text);
      }
    }
    ts.forEachChild(node, collectSetters);
  };
  collectSetters(source);
  checkedSetters += setters.size;

  if (setters.size === 0) {
    console.error(`FAIL: ${relative} 에서 useState setter 를 찾지 못했습니다(가드가 무력화됨).`);
    failures += 1;
    continue;
  }

  // 2) effect 콜백 안의 setter 호출 탐지
  const report = (node, setterName) => {
    const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
    console.error(
      `FAIL: ${relative}:${line + 1}:${character + 1} effect 안에서 상태 setter '${setterName}(...)' 를 호출합니다.`,
    );
    failures += 1;
  };

  const scanEffectBody = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      setters.has(node.expression.text)
    ) {
      report(node, node.expression.text);
    }
    ts.forEachChild(node, scanEffectBody);
  };

  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      EFFECT_HOOKS.has(node.expression.text) &&
      node.arguments.length > 0
    ) {
      const callback = node.arguments[0];
      if (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) {
        checkedEffects += 1;
        scanEffectBody(callback.body);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

if (failures > 0) {
  console.error(`venue stats S2 effect guard: FAIL (${failures} violation(s))`);
  process.exit(1);
}

console.log(
  `venue stats S2 effect guard: PASS (${TARGETS.length} file(s), ${checkedEffects} effect(s), ${checkedSetters} setter(s), effect 내 direct setState 0건)`,
);
