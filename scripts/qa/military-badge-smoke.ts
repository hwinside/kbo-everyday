/**
 * 군 복무(상무) 배지 hero/non-hero 회귀 스모크.
 *
 * 존재 이유 (삼순 #1292 NO-GO P0): 배지가 PlayerHero(hero 분기)에만 있어서
 * hero allowlist 밖 선수(상무 41명 중 33명)는 프로필 표기가 0이었다.
 * 이 스모크는 ①공용 라벨 함수 계약 ②hero/fallback 두 분기가 같은 SSOT
 * (militaryLabel + data-testid="military-badge")를 쓰는지를 함께 고정한다.
 *
 * 판정은 주석이 아니라 코드에 걸리도록 소스에서 주석을 blank 처리 후 검사한다
 * (게이트가 주석 문면에 속는 결함 재발 방지 — M90 lesson).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { militaryLabel } from "../../src/lib/utils/military-label";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
let pass = 0;
const check = (name: string, fn: () => void) => {
  fn();
  console.log(`✓ ${name}`);
  pass++;
};

// 주석 제거(오프셋 무관, 판정용) — 블록/라인 주석을 공백으로 치환
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));
}

// ── ① 공용 라벨 함수 계약 (순수 함수 — 실제 production seam 동일 호출)
check("상무 → '상무 복무 중'", () => {
  assert.equal(militaryLabel("상무"), "상무 복무 중");
});
check("공백/빈값/undefined/null → null (배지 미노출)", () => {
  assert.equal(militaryLabel(""), null);
  assert.equal(militaryLabel("   "), null);
  assert.equal(militaryLabel(undefined), null);
  assert.equal(militaryLabel(null), null);
});
check("앞뒤 공백은 trim", () => {
  assert.equal(militaryLabel(" 상무 "), "상무 복무 중");
});

// ── ② hero/fallback 두 분기가 같은 SSOT를 쓴다 (주석 blank 후 코드 기준)
const HERO = stripComments(
  fs.readFileSync(path.join(ROOT, "src/components/player/PlayerHero.tsx"), "utf8"),
);
const PAGE = stripComments(
  fs.readFileSync(path.join(ROOT, "src/app/(main)/community/players/[playerId]/page.tsx"), "utf8"),
);

check("PlayerHero(hero 분기)가 militaryLabel을 import·호출", () => {
  assert.match(HERO, /from "@\/lib\/utils\/military-label"/);
  assert.match(HERO, /militaryLabel\(military\)/);
  assert.match(HERO, /data-testid="military-badge"/);
});
check("players/[playerId] fallback 분기도 militaryLabel·동일 testid 사용", () => {
  assert.match(PAGE, /militaryLabel\(rosterMilitary\)/);
  assert.match(PAGE, /data-testid="military-badge"/);
});
check("fallback 분기의 military 소스는 roster SSOT(rosterPlayer)", () => {
  assert.match(PAGE, /rosterMilitary\s*=\s*\(rosterPlayer/);
});
check("PlayerHero로도 같은 값 전달 (hero/fallback 값 분기 없음)", () => {
  assert.match(PAGE, /military=\{rosterMilitary\}/);
});

// ── ③ 데이터 계약: military 보유자는 team이 원소속 10구단이다 (상무로 덮지 않음)
check("roster: military 보유자 전원 team이 10개 구단", () => {
  const roster = JSON.parse(
    fs.readFileSync(path.join(ROOT, "src/lib/constants/players-roster.json"), "utf8"),
  ) as Array<{ team: string; military?: string; militaryAsOf?: string; militarySource?: string }>;
  const KBO = new Set(["LG", "두산", "KT", "SSG", "NC", "KIA", "롯데", "삼성", "한화", "키움"]);
  const withMilitary = roster.filter((p) => p.military);
  assert.ok(withMilitary.length > 0, "military 보유자가 존재해야 한다");
  for (const p of withMilitary) {
    assert.ok(KBO.has(p.team), `military 보유자의 team은 원소속 구단이어야 한다: ${JSON.stringify(p)}`);
    assert.ok(p.militaryAsOf && p.militarySource, `상태·기준일·출처 3필드 완비: ${JSON.stringify(p)}`);
  }
});

console.log(`\nPASS — military badge hero/non-hero regression (${pass} checks)`);
