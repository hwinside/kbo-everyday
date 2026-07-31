#!/usr/bin/env node
/**
 * 직관 통계 S2 고정헤더 safe-area 규격 가드 (AST).
 *
 * 배경: `(main)/layout.tsx` 의 `<main className="pb-tab-bar pt-safe">` 가 이미
 * `padding-top: env(safe-area-inset-top)` 을 적용한다. 그 안의 sticky 헤더가
 * `paddingTop: env(safe-area-inset-top)` 만 추가하면 safe-area 가 이중 적용되어
 * 상단 여백이 과다해지고 sticky 기준이 어긋난다(2026-07-31 iPhone 실기기 제보).
 *
 * 앱 전역 공용 규격은 padding 과 음수 margin 의 **쌍**이다.
 *   paddingTop: env(safe-area-inset-top, 0px)
 *   marginTop:  calc(env(safe-area-inset-top, 0px) * -1)
 *
 * 이 가드는 대상 파일에서 `env(safe-area-inset-top` 을 쓰는 style 객체마다
 * 두 선언이 함께 있는지 검사하고, 하나라도 빠지면 exit 1 한다.
 */
import ts from "typescript";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const TARGETS = ["src/components/my/VenueStatsDashboard.tsx"];
const SAFE_TOP = "safe-area-inset-top";

let failures = 0;
let checked = 0;

for (const relative of TARGETS) {
  const filePath = resolve(process.cwd(), relative);
  const source = ts.createSourceFile(
    filePath,
    readFileSync(filePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );

  const literalOf = (node) => {
    // 문자열 리터럴 / 템플릿 리터럴 텍스트를 그대로 뽑는다.
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    return node.getText(source);
  };

  const report = (node, message) => {
    const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
    console.error(`FAIL: ${relative}:${line + 1}:${character + 1} ${message}`);
    failures += 1;
  };

  const visit = (node) => {
    if (ts.isObjectLiteralExpression(node)) {
      const props = new Map();
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const name = property.name && ts.isIdentifier(property.name)
          ? property.name.text
          : property.name && ts.isStringLiteral(property.name)
            ? property.name.text
            : null;
        if (name) props.set(name, literalOf(property.initializer));
      }

      const paddingTop = props.get("paddingTop") ?? "";
      const marginTop = props.get("marginTop") ?? "";
      const usesSafeTop = [...props.values()].some((value) => value.includes(SAFE_TOP));
      if (!usesSafeTop) {
        ts.forEachChild(node, visit);
        return;
      }

      checked += 1;
      if (!paddingTop.includes(SAFE_TOP)) {
        report(node, `safe-area style 에 paddingTop: env(${SAFE_TOP}, 0px) 이 없습니다.`);
      }
      if (!marginTop.includes(SAFE_TOP) || !marginTop.includes("-1")) {
        report(
          node,
          `공용 고정헤더 규격 위반 — paddingTop 만 있고 상쇄용 marginTop: calc(env(${SAFE_TOP}, 0px) * -1) 이 없습니다 ` +
          `(부모 main.pt-safe 와 이중 적용되어 상단 여백·sticky 기준이 어긋납니다).`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  if (checked === 0) {
    console.error(`FAIL: ${relative} 에서 safe-area style 을 찾지 못했습니다(가드 무력화).`);
    failures += 1;
  }
}

if (failures > 0) {
  console.error(`venue stats S2 header guard: FAIL (${failures} violation(s))`);
  process.exit(1);
}

console.log(
  `venue stats S2 header guard: PASS (${TARGETS.length} file(s), safe-area style ${checked}개, padding+음수 margin 쌍 충족)`,
);
