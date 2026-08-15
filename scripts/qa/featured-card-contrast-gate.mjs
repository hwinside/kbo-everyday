#!/usr/bin/env node
/**
 * featured(MY TEAM) 카드 전경 대비 게이트.
 *
 * 왜 필요한가 (삼순 2026-08-15 P1): featured 카드는 배경이 팀색인데 전경을 흰색 계열로
 * 고정했다. 팀색이 밝으면(한화 #FF6600) 대비가 2.94:1 로 AA large 조차 미달한다.
 *
 * 무엇을 검증하는가 (삼순 2026-08-15 ③): 상수를 재구현하지 않고 **production 이 실제로 카드에
 * 인라인 style 로 넣는 FEATURED_SURFACE() 의 반환값 자체**를 파싱해서 검사한다. 따라서
 *  - gradient 시작색을 darken 없이 되돌리거나
 *  - --text-primary/secondary/tertiary 중 아무거나 어둡게 바꾸거나
 *  - FEATURED_SURFACE 배선을 카드에서 떼어내면
 * 곧바로 RED 가 된다.
 *
 * 검사 축:
 *  ① 배선  — CompactGameCard 가 featured 분기에서 FEATURED_SURFACE 를 실제로 쓰는가
 *  ② 대비  — gradient 시작색(가장 밝은 지점) ↔ primary/secondary/tertiary **합성색 전부**가
 *            10개 구단 전 팀색에서 WCAG AA(4.5:1) 이상인가
 *            (secondary/tertiary 는 rgba 알파라 배경과 합성한 실제 색으로 계산한다)
 *
 * --selftest: darken 을 무력화(mix=0)했을 때 실제로 RED 가 나는지 검출력을 증명한다.
 */
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const CARD_PATH = path.join(ROOT, "src/components/game/CompactGameCard.tsx");
const AA = 4.5;

let failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  PASS  ${name}`);
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
};

/* ── 색 유틸 ─────────────────────────────────────────────── */
const parseHex = (hex) => {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) throw new Error(`hex 파싱 실패: ${hex}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
/** "rgba(255,255,255,0.72)" | "#FFFFFF" → {rgb, alpha} */
const parseColor = (v) => {
  const s = String(v).trim();
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(s);
  if (m) return { rgb: [+m[1], +m[2], +m[3]], alpha: m[4] === undefined ? 1 : +m[4] };
  return { rgb: parseHex(s), alpha: 1 };
};
/** 알파 전경을 배경 위에 합성한 실제 색 */
const composite = (fg, bgRgb) => fg.rgb.map((c, i) => c * fg.alpha + bgRgb[i] * (1 - fg.alpha));
const srgb = (c) => { const x = c / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
const lum = ([r, g, b]) => 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
const contrast = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

/* ── production 로드 ─────────────────────────────────────── */
async function loadProduction() {
  const card = await import(pathToFileURL(CARD_PATH).href);
  const teams = await import(pathToFileURL(path.join(ROOT, "src/lib/constants/teams.ts")).href);
  for (const k of ["FEATURED_SURFACE", "darkenForFeatured", "FEATURED_DARKEN_MIX"]) {
    if (card[k] === undefined) throw new Error(`${k} export 를 찾을 수 없다 — 게이트가 production 을 못 태운다`);
  }
  if (!Array.isArray(teams.TEAMS) || teams.TEAMS.length === 0) throw new Error("TEAMS 를 찾을 수 없다");
  return { card, TEAMS: teams.TEAMS.filter((t) => t.id >= 1 && t.id <= 10) };
}

async function run({ selftest }) {
  const { card, TEAMS } = await loadProduction();

  // ① 배선 — 카드가 featured 분기에서 FEATURED_SURFACE 를 실제로 호출하는가.
  //    (배선을 떼고 인라인 객체로 되돌리면 대비 검사가 통과해도 화면은 깨진다)
  const src = readFileSync(CARD_PATH, "utf8");
  const wired = /style=\{featuredTeam \? FEATURED_SURFACE\(featuredTeam\.colorPrimary\)/.test(src);
  check("배선: 카드 featured 분기가 FEATURED_SURFACE(featuredTeam.colorPrimary) 사용", wired);

  // ② 대비 — FEATURED_SURFACE 반환값을 그대로 파싱해 3색 전부 검사
  const FG_KEYS = ["--text-primary", "--text-secondary", "--text-tertiary"];
  const rows = [];
  for (const t of TEAMS) {
    // selftest 는 darken 을 무력화한 표면을 만들어 게이트의 검출력을 증명한다.
    const surface = selftest
      ? { ...card.FEATURED_SURFACE(t.colorPrimary), background: `linear-gradient(135deg, ${t.colorPrimary} 0%, #1A1A1D 78%)` }
      : card.FEATURED_SURFACE(t.colorPrimary);

    const bgHex = /linear-gradient\(135deg,\s*(#[0-9a-fA-F]{6})\s*0%/.exec(String(surface.background))?.[1];
    if (!bgHex) throw new Error(`${t.shortName}: gradient 시작색 파싱 실패 — ${surface.background}`);
    const bgRgb = parseHex(bgHex);

    for (const key of FG_KEYS) {
      const raw = surface[key];
      if (raw === undefined) throw new Error(`${t.shortName}: ${key} 가 FEATURED_SURFACE 에 없다`);
      const ratio = contrast(composite(parseColor(raw), bgRgb), bgRgb);
      rows.push({ team: t.shortName, key, bgHex, ratio });
    }
  }

  const bad = rows.filter((r) => r.ratio < AA);
  for (const t of TEAMS) {
    const mine = rows.filter((r) => r.team === t.shortName);
    const line = mine.map((r) => `${r.key.replace("--text-", "")} ${r.ratio.toFixed(2)}`).join(" · ");
    console.log(`  ${mine.every((r) => r.ratio >= AA) ? "PASS" : "FAIL"}  ${t.shortName.padEnd(4)} bg=${mine[0].bgHex}  ${line}`);
  }
  const worst = rows.reduce((a, b) => (a.ratio < b.ratio ? a : b));
  console.log(`  mix=${selftest ? 0 : card.FEATURED_DARKEN_MIX} · worst=${worst.team}/${worst.key} ${worst.ratio.toFixed(2)}:1 · AA(${AA}:1) ${rows.length - bad.length}/${rows.length}`);
  check(`대비: ${TEAMS.length}개 구단 × 전경 3색 전부 AA(${AA}:1) 이상`, bad.length === 0,
    bad.slice(0, 4).map((b) => `${b.team}/${b.key} ${b.ratio.toFixed(2)}:1`).join(", "));

  console.log();
  if (selftest) {
    if (failed === 0) {
      console.error("✗ SELFTEST FAILED — darken 을 무력화했는데도 전부 통과했다. 게이트에 검출력이 없다.");
      process.exit(1);
    }
    console.log(`✓ SELFTEST PASS — darken 제거 시 RED (검출력 확인: ${bad.map((b) => `${b.team}/${b.key.replace("--text-", "")}`).join(", ") || "배선"})`);
    return;
  }
  if (failed > 0) { console.error(`✗ FAIL — ${failed}건`); process.exit(1); }
  console.log(`✓ PASS — ${TEAMS.length}개 구단 × 3색 = ${rows.length}조합 전부 AA 이상 (최악 ${worst.team}/${worst.key} ${worst.ratio.toFixed(2)}:1)`);
}

run({ selftest: process.argv.includes("--selftest") }).catch((e) => {
  console.error("✗ ERROR:", e.message);
  process.exit(1);
});
