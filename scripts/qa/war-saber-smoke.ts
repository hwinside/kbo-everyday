/**
 * Smoke/regression for 예측 WAR 세이버메트릭 산식 (sabermetrics-calc).
 *
 * Why
 * ---
 * 삼순 NO-GO 재발 방지:
 *  1) 투수 IP는 KBO 라이브에서 "25 2/3" 문자열로 들어온다. parseFloat로 읽으면
 *     "25 2/3" → 25 로 분수이닝이 통째로 소실돼 FIP/K9/예측WAR가 틀어진다.
 *     parseInnings로 "25 2/3" == "25.2"(thirds 소수) == 25.667 이어야 하고,
 *     "25 2/3" != "25" 여야 한다.
 *  2) BABIP 분모의 SF는 실제 SF여야 한다. 잔차(PA-AB-BB-HBP)는 희생번트(SH)까지
 *     섞여 분모가 과대해진다 → 실제 SF를 명시 전달하면 BABIP가 (보통) 올라간다.
 *
 * 실행: npx tsx scripts/qa/war-saber-smoke.ts  (npm run qa:war-saber)
 */
import { calcBatterSaber, calcPitcherSaber } from "@/lib/utils/sabermetrics-calc";

let fail = 0;
function ok(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "✅" : "❌"} ${name}${detail ? `  ${detail}` : ""}`);
  if (!cond) fail++;
}

const P = { era: 3.0, so: 80, bb: 20, hr: 5, hits: 70, games: 15, wins: 8, losses: 4, saves: 0, whip: 1.1 };
const frac = calcPitcherSaber({ ...P, ip: "25 2/3" });
const dec = calcPitcherSaber({ ...P, ip: "25.2" });
const num = calcPitcherSaber({ ...P, ip: 25.2 });
const flat = calcPitcherSaber({ ...P, ip: "25" });

const eq = (a: number, b: number) => Math.abs(a - b) < 1e-6;
ok("T1 '25 2/3' == '25.2' (FIP)", eq(frac.FIP, dec.FIP), `${frac.FIP} vs ${dec.FIP}`);
ok("T2 '25 2/3' == '25.2' (K9)", eq(frac.K9, dec.K9), `${frac.K9} vs ${dec.K9}`);
ok("T3 '25 2/3' == '25.2' (WAR)", eq(frac.WAR, dec.WAR), `${frac.WAR} vs ${dec.WAR}`);
ok("T4 number 25.2 == string '25.2' (K9)", eq(num.K9, dec.K9), `${num.K9} vs ${dec.K9}`);
ok("T5 '25 2/3' != '25' (K9 분수이닝 반영)", !eq(frac.K9, flat.K9), `${frac.K9} vs ${flat.K9}`);

// BABIP: 동일 입력에서 잔차(SH 6 섞임)보다 실제 SF=2 가 분모를 줄여 BABIP을 올린다
const B = { avg: 0.3, hits: 30, hr: 3, doubles: 6, triples: 1, ab: 80, pa: 100, runs: 15, rbi: 20, sb: 5, bb: 10, so: 20, hbp: 2 };
const withSf = calcBatterSaber({ ...B, sf: 2 });      // 정확: bd = 80-20-3+2 = 59
const residual = calcBatterSaber({ ...B });            // 잔차: bd = 80-20-3+8 = 64 (SH 섞임)
ok("T6 실제 SF 전달 시 BABIP != 잔차 추정", !eq(withSf.BABIP, residual.BABIP), `${withSf.BABIP} vs ${residual.BABIP}`);
ok("T7 실제 SF(작은 분모) BABIP > 잔차 BABIP", withSf.BABIP > residual.BABIP, `${withSf.BABIP} > ${residual.BABIP}`);

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
