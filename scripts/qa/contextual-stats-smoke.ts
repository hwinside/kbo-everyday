/**
 * Smoke test for /api/contextual-stats v1.
 *
 * Why
 * ---
 * Each context gate is independent, and getting any one wrong leaks a
 * misleading stat into the box (e.g. RISP shown when no runner on 2B/3B).
 * Spec §5 demands fail-closed at the line level — this smoke verifies that
 * every gate suppresses correctly under its negative cases AND admits under
 * its positive cases, and that the Situation parser anchors on label rather
 * than position (in case KBO reorders columns).
 *
 * Assertions
 * ----------
 *   T1-4: handedness parser — 우/좌, switch, underhand, missing
 *   T5-9: situation parser — Table 0/4/5 row extraction, ASP.NET error detect,
 *         "기록이 없습니다" filtering
 *   T10-12: bases-loaded gate — context off / threshold fail / pass
 *   T13-15: RISP gate — no risp / no runner / pass
 *   T16-17: two-outs gate — context off / pass
 *   T18-19: PH-BA gate — not pinch / pinch + value
 *   T20-22: vs-hand gate — switch suppressed / matching row pass / sample fail
 *   T23-24: no-hitter gate — pre-7회 / 7회 H=0 (admit)
 *   T25: hitter Basic parser extracts RISP + PH-BA from real-shape HTML
 *   T26: pitcher Basic parser extracts HR + SO
 */

import { parseHandedness } from "@/lib/contextual-stats/handedness-parser";
import {
  parseSituation,
  looksLikeAspNetError,
} from "@/lib/contextual-stats/situation-parser";
import {
  parseHitterBasic,
  parsePitcherBasic,
} from "@/lib/contextual-stats/basic-parser";
import {
  selectBasesLoaded,
  selectNoHitter,
  selectPhBA,
  selectRisp,
  selectTwoOuts,
  selectVsHand,
} from "@/lib/contextual-stats/gates";
import type {
  BasicSeasonStats,
  GameContext,
  PlayerHandedness,
  SituationTables,
  SplitRow,
} from "@/lib/contextual-stats/types";

let failures = 0;

function assert(label: string, ok: boolean, detail?: unknown): void {
  const tag = ok ? "PASS" : "FAIL";
  console.log(`[${tag}] ${label}`);
  if (!ok) {
    failures++;
    if (detail !== undefined) console.log("  detail:", detail);
  }
}

function mkCtx(over: Partial<GameContext> = {}): GameContext {
  return {
    gameId: "20260526TEST0",
    inning: 5,
    isTop: false,
    outs: 1,
    balls: 0,
    strikes: 0,
    bases: { first: false, second: false, third: false },
    batterKboId: "78513",
    pitcherKboId: "69446",
    batterIsPinch: false,
    ...over,
  };
}

function mkRow(over: Partial<SplitRow> = {}): SplitRow {
  return {
    label: "x",
    AVG: "0.300",
    AB: 100,
    H: 30,
    HR: 5,
    BB: 10,
    SO: 20,
    ...over,
  };
}

// ===== T1-T4: handedness =====
{
  const profileHtml = `<li><strong>포지션: </strong><span id="x">외야수(우투우타)</span></li>`;
  const r = parseHandedness(profileHtml);
  assert("T1: 우투우타 → throws=right, bat=right", r.throws === "right" && r.bat === "right", r);
}
{
  const r = parseHandedness(
    `<li><strong>포지션: </strong><span id="x">투수(좌투좌타)</span></li>`,
  );
  assert("T2: 좌투좌타 → throws=left, bat=left", r.throws === "left" && r.bat === "left", r);
}
{
  const r = parseHandedness(
    `<li><strong>포지션: </strong><span id="x">투수(언더)</span></li>`,
  );
  assert("T3: 언더 → throws=right (KBO 표기 우회)", r.throws === "right", r);
}
{
  const r = parseHandedness(`<li>no position line</li>`);
  assert("T4: 미파싱 시 bat/throws 둘 다 null", r.bat === null && r.throws === null, r);
}
{
  const r = parseHandedness(
    `<li><strong>포지션: </strong><span>지명(우투양타)</span></li>`,
  );
  assert("T4b: 양타자 → bat=switch", r.bat === "switch", r);
}

// ===== T5-T9: situation parser =====
{
  const html = `
<table>
  <tr><th>구분</th><th>AVG</th><th>AB</th><th>H</th><th>2B</th><th>3B</th><th>HR</th><th>RBI</th><th>BB</th><th>HBP</th><th>SO</th><th>GDP</th></tr>
  <tr><td>주자없음</td><td>0.247</td><td>81</td><td>20</td><td>4</td><td>0</td><td>2</td><td>2</td><td>8</td><td>0</td><td>7</td><td>0</td></tr>
  <tr><td>만루</td><td>0.500</td><td>6</td><td>3</td><td>0</td><td>0</td><td>1</td><td>5</td><td>1</td><td>0</td><td>1</td><td>0</td></tr>
</table>
<table><tr><th>구분</th><td colspan="11">기록이 없습니다.</td></tr></table>
<table><tr><th>구분</th></tr></table>
<table><tr><th>구분</th></tr></table>
<table>
  <tr><th>구분</th><th>AVG</th><th>AB</th><th>H</th><th>2B</th><th>3B</th><th>HR</th><th>RBI</th><th>BB</th><th>HBP</th><th>SO</th><th>GDP</th></tr>
  <tr><td>좌투수</td><td>0.277</td><td>47</td><td>13</td><td>2</td><td>0</td><td>1</td><td>4</td><td>2</td><td>0</td><td>6</td><td>2</td></tr>
  <tr><td>우투수</td><td>0.204</td><td>108</td><td>22</td><td>3</td><td>0</td><td>0</td><td>4</td><td>10</td><td>0</td><td>15</td><td>1</td></tr>
</table>
<table>
  <tr><th>구분</th><th>AVG</th><th>AB</th><th>H</th><th>2B</th><th>3B</th><th>HR</th><th>RBI</th><th>BB</th><th>HBP</th><th>SO</th><th>GDP</th></tr>
  <tr><td>2아웃</td><td>0.208</td><td>53</td><td>11</td><td>2</td><td>0</td><td>1</td><td>6</td><td>4</td><td>0</td><td>12</td><td>0</td></tr>
</table>
`;
  const s = parseSituation(html, "batter");
  const 만루 = s.bases.find(r => r.label === "만루");
  assert("T5: Table 0 만루 row extracted", !!만루 && 만루.AB === 6 && 만루.HR === 1, 만루);

  const 좌투수 = s.byHand.find(r => r.label === "좌투수");
  assert("T6: Table 4 좌투수 row extracted", !!좌투수 && 좌투수.AB === 47, 좌투수);

  const 두아웃 = s.byOuts.find(r => r.label === "2아웃");
  assert("T7: Table 5 2아웃 row extracted", !!두아웃 && 두아웃.AB === 53, 두아웃);

  assert("T8: empty/기록없음 tables filtered", s.bases.length === 2, s.bases.map(r => r.label));
}
{
  assert(
    "T9a: looksLikeAspNetError detects Object moved",
    looksLikeAspNetError('<html><head><title>Object moved</title></head>'),
  );
  assert("T9b: clean HTML not flagged", !looksLikeAspNetError(`<table><tr><th>구분</th></tr></table>`));
}

// ===== T10-T12: bases-loaded =====
{
  const sit: SituationTables = {
    bases: [mkRow({ label: "만루", AB: 8 })],
    byHand: [],
    byOuts: [],
  };
  assert(
    "T10: bases NOT loaded → null",
    selectBasesLoaded(sit, mkCtx({ bases: { first: false, second: true, third: true } })) === null,
  );
}
{
  const sit: SituationTables = {
    bases: [mkRow({ label: "만루", AB: 3 })],
    byHand: [],
    byOuts: [],
  };
  assert(
    "T11: bases loaded but AB<5 → null",
    selectBasesLoaded(sit, mkCtx({ bases: { first: true, second: true, third: true } })) === null,
  );
}
{
  const sit: SituationTables = {
    bases: [mkRow({ label: "만루", AB: 6, AVG: "0.500" })],
    byHand: [],
    byOuts: [],
  };
  const res = selectBasesLoaded(
    sit,
    mkCtx({ bases: { first: true, second: true, third: true } }),
  );
  assert("T12: bases loaded AB≥5 → row returned", res?.value.row.AVG === "0.500", res);
}

// ===== T13-T15: RISP (Situation-aggregated, sample-size gate) =====
{
  // Empty bases table → null
  const sit: SituationTables = { bases: [], byHand: [], byOuts: [] };
  assert(
    "T13: no Situation data → null",
    selectRisp(sit, mkCtx({ bases: { first: false, second: true, third: false } })) === null,
  );
}
{
  // AB합 = 5 + 4 + 1 + 2 = 12, H합 = 2 + 1 + 0 + 1 = 4 → 0.333, AB≥10 admit
  const sit: SituationTables = {
    bases: [
      mkRow({ label: "주자없음", AB: 50, H: 15 }), // 비-RISP, 합산 제외
      mkRow({ label: "1루", AB: 20, H: 6 }),       // 비-RISP, 합산 제외
      mkRow({ label: "2루", AB: 5, H: 2 }),
      mkRow({ label: "3루", AB: 4, H: 1 }),
      mkRow({ label: "1,2루", AB: 1, H: 0 }),
      mkRow({ label: "만루", AB: 2, H: 1 }),
    ],
    byHand: [],
    byOuts: [],
  };
  const res = selectRisp(sit, mkCtx({ bases: { first: false, second: true, third: false } }));
  assert(
    "T14: RISP aggregate AB=12 (≥10), H=4 → AVG=0.333 admit",
    res?.value.AVG === "0.333" && res?.value.AB === 12,
    res,
  );
}
{
  // AB합 = 3 (< threshold 10) → suppress
  const sit: SituationTables = {
    bases: [
      mkRow({ label: "2루", AB: 1, H: 0 }),
      mkRow({ label: "3루", AB: 2, H: 1 }),
    ],
    byHand: [],
    byOuts: [],
  };
  assert(
    "T15a: RISP aggregate AB<10 → null (표본 가드)",
    selectRisp(sit, mkCtx({ bases: { first: false, second: true, third: false } })) === null,
  );
}
{
  // Bases include qualifying rows but context (no runner 2B/3B) is wrong
  const sit: SituationTables = {
    bases: [mkRow({ label: "2,3루", AB: 30, H: 10 })],
    byHand: [],
    byOuts: [],
  };
  assert(
    "T15b: no runner on 2B/3B → null even with sufficient sample",
    selectRisp(sit, mkCtx({ bases: { first: true, second: false, third: false } })) === null,
  );
}

// ===== T16-T17: two-outs =====
{
  const sit: SituationTables = {
    bases: [],
    byHand: [],
    byOuts: [mkRow({ label: "2아웃", AB: 30 })],
  };
  assert("T16: outs != 2 → null", selectTwoOuts(sit, mkCtx({ outs: 1 }), "batter") === null);
}
{
  const sit: SituationTables = {
    bases: [],
    byHand: [],
    byOuts: [mkRow({ label: "2아웃", AB: 30, AVG: "0.220" })],
  };
  const res = selectTwoOuts(sit, mkCtx({ outs: 2 }), "batter");
  assert("T17: outs=2 AB≥20 → admit", res?.value.row.AVG === "0.220", res);
}

// ===== T18-T19: PH-BA =====
{
  const basic: BasicSeasonStats = { kboId: "1", name: "X", phBA: "0.300" };
  assert(
    "T18: not pinch hitter → null",
    selectPhBA(basic, mkCtx({ batterIsPinch: false })) === null,
  );
}
{
  const basic: BasicSeasonStats = { kboId: "1", name: "X", phBA: "0.300" };
  const res = selectPhBA(basic, mkCtx({ batterIsPinch: true }));
  assert("T19: pinch + phBA value → admit", res?.value.AVG === "0.300", res);
}

// ===== T20-T22: vs-hand =====
{
  const pitcherSit: SituationTables = {
    bases: [],
    byHand: [
      mkRow({ label: "좌타자", AB: 60, AVG: "0.219" }),
      mkRow({ label: "우타자", AB: 100, AVG: "0.286" }),
    ],
    byOuts: [],
  };
  const switchH: PlayerHandedness = { kboId: "1", name: "X", bat: "switch", throws: "right" };
  assert("T20: switch hitter → null (v1 conservative)", selectVsHand(pitcherSit, switchH) === null);
}
{
  const pitcherSit: SituationTables = {
    bases: [],
    byHand: [
      mkRow({ label: "좌타자", AB: 60, AVG: "0.219" }),
      mkRow({ label: "우타자", AB: 100, AVG: "0.286" }),
    ],
    byOuts: [],
  };
  const rightH: PlayerHandedness = { kboId: "1", name: "X", bat: "right", throws: "right" };
  const res = selectVsHand(pitcherSit, rightH);
  assert(
    "T21: right batter → 우타자 row, AB≥30 admit",
    res?.value.row.AVG === "0.286" && res?.value.opponentSide === "right",
    res,
  );
}
{
  const pitcherSit: SituationTables = {
    bases: [],
    byHand: [mkRow({ label: "좌타자", AB: 12, AVG: "0.219" })],
    byOuts: [],
  };
  const leftH: PlayerHandedness = { kboId: "1", name: "X", bat: "left", throws: "right" };
  assert(
    "T22: matching row but AB<30 → null",
    selectVsHand(pitcherSit, leftH) === null,
  );
}

// ===== T23-T24: no-hitter (team-aggregated H, 7회 게이트, perfect v1 제외) =====
{
  assert(
    "T23: inning<7 → null (관습 게이트)",
    selectNoHitter(0, mkCtx({ inning: 5 })) === null,
  );
}
{
  // 팀 합산 H = 0 + 7회 → admit
  const res = selectNoHitter(0, mkCtx({ inning: 7, isTop: false, outs: 0 }));
  assert("T24a: 7회 팀합산 H=0 → 노히터 진행", res?.inning === 7, res);
}
{
  // 현재 투수 row만 H=0이라도 팀 합산이 양수면 차단 (구원투수 false positive 방지)
  assert(
    "T24b: 팀 합산 H>0 → null (구원투수 본인 H=0이어도 팀 안타 있음)",
    selectNoHitter(3, mkCtx({ inning: 8 })) === null,
  );
}
{
  assert(
    "T24c: null 입력 → null (boxscore 미파싱/에러)",
    selectNoHitter(null, mkCtx({ inning: 9 })) === null,
  );
}
{
  // 9회말 H=0 → 완성된 노히터
  const res = selectNoHitter(0, mkCtx({ inning: 9, isTop: false, outs: 3 }));
  assert("T24d: 9회 팀합산 H=0 → 노히터 진행 (perfect는 v1 비포함)", res?.inning === 9, res);
}

// ===== T25-T26: Basic parsers =====
{
  // Real-shape HitterDetail/Basic.aspx fixture (trimmed)
  const html = `
<table><tr><th>팀명</th><th>AVG</th><th>G</th><th>PA</th><th>AB</th><th>R</th><th>H</th><th>2B</th><th>3B</th><th>HR</th><th>TB</th><th>RBI</th><th>SB</th><th>CS</th><th>SAC</th><th>SF</th></tr>
<tr><td>롯데</td><td>0.238</td><td>45</td><td>174</td><td>160</td><td>12</td><td>38</td><td>5</td><td>0</td><td>2</td><td>49</td><td>10</td><td>0</td><td>1</td><td>0</td><td>1</td></tr></table>
<table><tr><th>BB</th><th>IBB</th><th>HBP</th><th>SO</th><th>GDP</th><th>SLG</th><th>OBP</th><th>E</th><th>SB%</th><th>MH</th><th>OPS</th><th>RISP</th><th>PH-BA</th></tr>
<tr><td>13</td><td>0</td><td>0</td><td>22</td><td>3</td><td>0.306</td><td>0.293</td><td>1</td><td>0.0</td><td>9</td><td>0.599</td><td>0.171</td><td>0.667</td></tr></table>
`;
  const res = parseHitterBasic(html, "78513", "테스트");
  assert(
    "T25: hitter Basic → phBA=0.667, hr=2 (risp v1 비사용, Situation 합산으로 대체)",
    res?.phBA === "0.667" && res?.hr === 2,
    res,
  );
}
{
  const html = `
<table><tr><th>팀</th><th>ERA</th><th>G</th><th>CG</th><th>SHO</th><th>W</th><th>L</th><th>SV</th><th>HLD</th><th>WPCT</th><th>TBF</th><th>NP</th><th>IP</th><th>H</th><th>2B</th><th>3B</th><th>HR</th></tr>
<tr><td>삼성</td><td>2.50</td><td>10</td><td>0</td><td>0</td><td>5</td><td>2</td><td>0</td><td>0</td><td>0.714</td><td>200</td><td>800</td><td>50.0</td><td>40</td><td>8</td><td>1</td><td>7</td></tr></table>
<table><tr><th>SAC</th><th>SF</th><th>BB</th><th>IBB</th><th>SO</th><th>WP</th><th>BK</th><th>R</th><th>ER</th><th>BSV</th><th>WHIP</th><th>AVG</th><th>QS</th></tr>
<tr><td>0</td><td>1</td><td>10</td><td>0</td><td>55</td><td>0</td><td>0</td><td>20</td><td>15</td><td>0</td><td>1.10</td><td>0.210</td><td>5</td></tr></table>
`;
  const res = parsePitcherBasic(html, "69446", "테스트");
  assert("T26: pitcher Basic → hr=7, so=55", res?.hr === 7 && res?.so === 55, res);
}

// ===== Summary =====

if (failures > 0) {
  console.log(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll contextual-stats v1 gate/parser checks passed");
