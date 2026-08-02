#!/usr/bin/env node
/**
 * 직관 다이어리·직관 통계 일반 공개 가드 (AST).
 *
 * 배경: 두 기능은 관리자 전용(`AdminOnly`)으로 prod 배포해 실환경 QA 를 마친 뒤
 * 래퍼를 벗겨 전체 롤아웃했다(통계 #1026 / 다이어리 2026-08-02 하린아빠 지시).
 * 이 계약은 코드에 흔적이 거의 남지 않아 — 래퍼 한 줄만 다시 감싸면 조용히
 * 전 유저에게서 사라진다. 실제로 2026-07-21 에 파생 `/my` 카드가 게이트 전파
 * 누락으로 잠긴 전례가 있다.
 *
 * 그래서 **표시 게이트가 다시 닫히는 것**을 정적으로 막는다:
 *   1) `/my` 페이지의 `<VenueDiaryCard />`·`<VenueStatsEntryCard />` 가
 *      `<AdminOnly>` (또는 그 fallback prop) 하위에 있으면 FAIL
 *   2) 두 컴포넌트 자신이 `useIsAdmin` 으로 렌더를 가르면 FAIL
 *      (래퍼 대신 내부에서 막는 우회 차단)
 *
 * ⚠️ 스토리 조회수 배지(`VenueStoryViewer`)의 `AdminOnly` 는 운영 지표라
 * 공개 대상이 아니다 — 검사 대상에 넣지 않는다.
 * ⚠️ 업로드 컴포저의 `useIsAdmin` 은 표시 게이트가 아니라 관리자 GPS 우회(구장 밖
 * QA)라서 역시 대상이 아니다. 그걸 지우면 일반 유저 GPS 인증이 뚫린다.
 */
import ts from "typescript";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** `/my` 에서 admin 래핑되면 안 되는 컴포넌트. */
const PUBLIC_COMPONENTS = ["VenueDiaryCard", "VenueStatsEntryCard"];
const PAGE = "src/app/(main)/my/page.tsx";
/** 자체적으로 admin 분기를 두면 안 되는 컴포넌트 파일. */
const COMPONENT_FILES = [
  "src/components/my/VenueDiaryCard.tsx",
  "src/components/my/VenueStatsEntryCard.tsx",
];

let failures = 0;
let checked = 0;

function parse(relative) {
  const filePath = resolve(process.cwd(), relative);
  return ts.createSourceFile(
    filePath,
    readFileSync(filePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
}

function fail(source, node, relative, message) {
  const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
  console.error(`FAIL: ${relative}:${line + 1}:${character + 1} ${message}`);
  failures++;
}

// ── ① `/my` 에서 admin 래핑 여부 ──────────────────────────────────────────
{
  const source = parse(PAGE);
  const tagName = (node) => {
    if (ts.isJsxElement(node)) return node.openingElement.tagName.getText(source);
    if (ts.isJsxSelfClosingElement(node)) return node.tagName.getText(source);
    return null;
  };

  const found = new Set();

  const walk = (node, adminDepth) => {
    const name = tagName(node);
    const nextDepth = name === "AdminOnly" ? adminDepth + 1 : adminDepth;

    if (name && PUBLIC_COMPONENTS.includes(name)) {
      found.add(name);
      checked++;
      if (nextDepth > 0) {
        fail(source, node, PAGE, `<${name}> 이 <AdminOnly> 하위에 있다 — 일반 공개 계약 위반`);
      }
    }

    // `<AdminOnly fallback={<VenueDiaryCard />}>` 같은 우회도 admin 취급한다.
    ts.forEachChild(node, (child) => walk(child, nextDepth));
  };
  walk(source, 0);

  // 컴포넌트가 아예 사라지면 "게이트 통과"가 아니라 기능 소실이다.
  for (const name of PUBLIC_COMPONENTS) {
    if (!found.has(name)) {
      console.error(`FAIL: ${PAGE} 에서 <${name}> 을 찾지 못했다 — 렌더 자체가 제거됐는지 확인 필요`);
      failures++;
    }
  }
}

// ── ② 컴포넌트 자체의 admin 분기 ─────────────────────────────────────────
for (const relative of COMPONENT_FILES) {
  const source = parse(relative);
  const walk = (node) => {
    if (ts.isIdentifier(node) && node.text === "useIsAdmin") {
      fail(source, node, relative, "표시 게이트를 컴포넌트 내부 useIsAdmin 으로 되돌렸다");
    }
    if (
      (ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === "AdminOnly") ||
      (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === "AdminOnly")
    ) {
      fail(source, node, relative, "컴포넌트 내부에서 <AdminOnly> 로 다시 감쌌다");
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  checked++;
}

if (failures > 0) {
  console.error(`\nvenue diary/stats public guard: FAIL (${failures} violation)`);
  process.exit(1);
}
console.log(`venue diary/stats public guard: PASS (${checked} checks — /my 래핑 없음 · 컴포넌트 내부 admin 분기 없음)`);
