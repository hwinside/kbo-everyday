#!/usr/bin/env node
/**
 * KBO 공식 기록실 컬럼 **expected-set** — 감사 문서에서 기계 추출한 독립 근거.
 *
 * ⚠️ 왜 문서를 파싱하는가 (삼순 #1159 11차 P0).
 * 직전 게이트는 `KBO_OFFICIAL_METRIC_COLUMNS` 자기 자신을 훑어 "전 컬럼이 결속되나"만 봤다.
 * 그건 completeness 가 아니라 **자기 참조**다 — E/PKO/OOB 처럼 따로 찍어둔 항목 외의 컬럼을
 * 하나 지우면 조용히 통과했다(실측 MISS 2건). 그래서 inventory 와 **독립된** expected-set 을
 * 감사 문서(`docs/baseball-qa/kbo-record-endpoint-audit.md`)의 컬럼 표에서 파싱해 대조한다.
 * 문서는 2026-08-11 실측 감사 결과이고, repo 안에 함께 커밋되어 exact 에 고정된다.
 *
 * 표 형식: `| 구분 | URL | 필터 | 컬럼명 | 정렬 가능 지표 | pagination |`
 * 4번째 열(컬럼명)의 백틱 안 쉼표 목록이 그 페이지의 표 헤더 전체다.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const AUDIT_DOC = "docs/baseball-qa/kbo-record-endpoint-audit.md";

/** 표 `구분` → inventory `source`. 역대/Top 표는 통산 컬럼의 부분집합이라 대조 대상이 아니다. */
const SOURCE_BY_LABEL = new Map([
  ["타자 기본 현재", "hitter"],
  ["타자 기본 현재 2", "hitter"],
  ["타자 통산", "hitter"],
  ["타자 세부 현재", "hitter"],
  ["투수 기본 현재", "pitcher"],
  ["투수 기본 현재 2", "pitcher"],
  ["투수 통산", "pitcher"],
  ["투수 세부 현재", "pitcher"],
  ["수비", "defense"],
  ["주루", "runner"],
]);

/** 지표가 아닌 식별/표시 열 — 순위·이름·팀·포지션은 기록 지표가 아니다. */
const NON_METRIC = new Set(["순위", "선수명", "팀명", "POS", "연도", "선수", "소속", "기록"]);

/**
 * 같은 코드가 여러 소스 표에 겹쳐 나오는 경우의 **소유 소스**.
 * 예: `SB`(도루)는 타자 통산 표에도 있지만 주루 표가 정본이고, `IP`·`H`·`HR` 은 투수 지표다.
 * 이 매핑이 없으면 같은 지표가 소스만 다르게 두 번 요구돼 대조가 무의미해진다.
 */
const CODE_OWNER = new Map([
  ["SB", "runner"], ["CS", "runner"],
  ["G", "hitter"], ["GS", "pitcher"], ["IP", "pitcher"], ["E", "defense"],
  ["DP", "defense"], ["PO", "defense"], ["A", "defense"], ["PKO", "runner"],
  ["AVG", "hitter"], ["2B", "hitter"], ["3B", "hitter"], ["SAC", "hitter"],
  ["SF", "hitter"], ["IBB", "hitter"], ["BB", "hitter"], ["HBP", "hitter"],
  ["SO", "hitter"], ["GDP", "hitter"], ["GO", "hitter"], ["AO", "hitter"],
  ["H", "hitter"], ["HR", "hitter"], ["R", "hitter"],
]);

/** 투수 표의 동명 컬럼은 inventory 에서 `-pit` 접미로 구분돼 있다. */
const PITCHER_SUFFIXED = new Map([
  ["H", "H-pit"], ["HR", "HR-pit"], ["R", "R-pit"], ["SO", "SO-pit"], ["AVG", "AVG-pit"],
]);

/**
 * 비율 파생 표기 — `GO/AO` 는 같은 표의 `GO`·`AO` 두 컬럼의 몫이라 독립 지표로 요구하지 않는다.
 * `BB/K`·`P/PA` 는 감사 문서에 독립 컬럼으로 실려 있으므로 **제외하지 않는다**(실측 EXTRA 2건).
 */
const DERIVED_RATIO = new Set(["GO/AO"]);

/** 감사 문서에 있으나 별도 트랙(선발승/구원승 세분)으로 미지원인 컬럼. 사유를 명시해 둔다. */
const DOCUMENTED_EXCLUSIONS = new Map([
  ["Wgs", "선발승 세분 — W(다승)로 통합 지원"],
  ["Wgr", "구원승 세분 — W(다승)로 통합 지원"],
]);

export function parseExpectedColumns(repoRoot = process.cwd()) {
  const raw = readFileSync(path.join(repoRoot, AUDIT_DOC), "utf8");
  const expected = new Set();
  let rowCount = 0;
  for (const line of raw.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").map((cell) => cell.trim());
    // ['', 구분, URL, 필터, 컬럼명, 정렬, pagination, '']
    if (cells.length < 6) continue;
    const source = SOURCE_BY_LABEL.get(cells[1]);
    if (!source) continue;
    const columnCell = cells[4];
    const match = columnCell.match(/`([^`]+)`/);
    if (!match) throw new Error(`audit row has no column list: ${cells[1]}`);
    rowCount += 1;
    for (const rawCode of match[1].split(",")) {
      const code = rawCode.trim();
      if (!code || NON_METRIC.has(code) || DERIVED_RATIO.has(code)) continue;
      if (DOCUMENTED_EXCLUSIONS.has(code)) continue;
      // ⚠️ 순서가 중요하다. 투수 표의 `H`·`HR`·`R`·`SO`·`AVG` 는 타자 동명 컬럼이 아니라
      // 피안타·피홈런·실점·탈삼진·피안타율이다. CODE_OWNER(타자 소유)를 먼저 보면 이 다섯이
      // 통째로 expected 에서 빠져 대조가 무력화된다(실측 EXTRA 5건).
      if (source === "pitcher" && PITCHER_SUFFIXED.has(code)) {
        expected.add(`pitcher:${PITCHER_SUFFIXED.get(code)}`);
        continue;
      }
      const owner = CODE_OWNER.get(code) ?? source;
      // 다른 소스가 소유한 코드가 이 표에도 나온 경우 — 소유 소스에서만 요구한다.
      if (owner !== source) continue;
      expected.add(`${source}:${code}`);
    }
  }
  if (rowCount !== SOURCE_BY_LABEL.size) {
    throw new Error(`audit doc rows ${rowCount} != expected ${SOURCE_BY_LABEL.size} — 문서 구조 변경`);
  }
  return { expected, rowCount, doc: AUDIT_DOC, exclusions: DOCUMENTED_EXCLUSIONS };
}
