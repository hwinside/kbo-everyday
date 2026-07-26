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
 *  3) OBP/OPS는 PA가 아니라 공식 OBP 분모(AB+BB+HBP+SF)를 써야 한다.
 *     문성주 2026 실측: H50/AB169/BB16/HBP2/SF2/SLG .361 → OBP .360, OPS .721.
 *
 * 실행: npx tsx scripts/qa/war-saber-smoke.ts  (npm run qa:war-saber)
 */
import { calcBatterSaber, calcPitcherSaber } from "@/lib/utils/sabermetrics-calc";
import { rankByStat, parseIP } from "@/lib/stats/title-rankings";

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

const moon = {
  avg: "0.296", hits: 50, hr: 1, doubles: 8, triples: 0,
  ab: 169, pa: 191, runs: 13, rbi: 19, sb: 2, cs: 1,
  bb: 16, so: 24, hbp: 2, sf: 2,
};
const moonComputed = calcBatterSaber(moon);
const moonOfficial = calcBatterSaber({ ...moon, obp: "0.360", slg: "0.361", ops: "0.721" });
ok("T8 OBP는 PA가 아니라 AB+BB+HBP+SF 분모 사용", eq(moonComputed.OBP, 0.360), `OBP ${moonComputed.OBP}`);
ok("T9 문성주 OPS 재계산값 == 공식 OPS", eq(moonComputed.OPS, 0.721), `OPS ${moonComputed.OPS}`);
ok("T10 공식 OPS가 있으면 세이버 카드 SSOT로 우선 사용", eq(moonOfficial.OPS, 0.721), `OPS ${moonOfficial.OPS}`);

// ---------------------------------------------------------------------------
// 삼순 NO-GO 재발 방지 (투수 WAR RA9 전환 — PR #870)
// ---------------------------------------------------------------------------

// Blocker 2-a: RA9(실제 실점) 기반이다 — 동일 FIP 구성이라도 실점(R)이 다르면 WAR가 달라져야 한다.
// (FIP 단독 모델이면 아래 둘은 동일해졌다 = 회귀)
const base = { ip: "100", so: 90, bb: 30, hr: 10, games: 25, wins: 8, losses: 6, saves: 0, whip: 1.25 };
const lucky = calcPitcherSaber({ ...base, era: 3.00, r: 38, er: 33 });   // 실점 적음(행운)
const unlucky = calcPitcherSaber({ ...base, era: 4.50, r: 55, er: 50 });  // 실점 많음(불운)
ok("T11 RA9 기반: 같은 FIP구성이어도 실점 적은 투수 WAR가 더 높다", lucky.WAR > unlucky.WAR, `${lucky.WAR} > ${unlucky.WAR}`);

// Blocker 2-b: R 우선, 없으면 ER, 그리고 ERA×IP/9 순 폴백.
const withR = calcPitcherSaber({ ...base, era: 4.00, r: 50, er: 44 });
const withEr = calcPitcherSaber({ ...base, era: 4.00, er: 44 });          // R 미제공 → ER
const withEra = calcPitcherSaber({ ...base, era: 4.00 });                 // 둘 다 미제공 → ERA*IP/9=44.4
ok("T12 R 우선: R 있으면 R(50)로 RA9, ER(44)보다 WAR 낮다", withR.WAR < withEr.WAR, `R ${withR.WAR} < ER ${withEr.WAR}`);
ok("T13 ER 폴백: R 없으면 ER, ERA폴백과 근사(ER 44 ≈ ERA*IP/9 44.4)", Math.abs(withEr.WAR - withEra.WAR) <= 0.05, `ER ${withEr.WAR} ≈ ERA ${withEra.WAR}`);

// Blocker 2-c: 저이닝(5경기 노출군) 절편 바닥값 방지.
// 삼순 지적: 구 재캘리브(b=0.802 전역 절편)는 저이닝 불펜을 +0.8 바닥값처럼 띄워
// 실점 많은(나쁜) 저이닝 투수까지 과대평가한다. 실제 노출군 캘리브(b=0.398)로
// ① 나쁜 저이닝 투수는 0 근처·음수까지 내려가고 ② 또래는 상한(예: 8IP에서 ~0.5) 이하여야 한다.
const lowInnBad = calcPitcherSaber({ ip: "8", so: 4, bb: 6, hr: 2, r: 9, er: 9, era: 10.13, games: 8, wins: 0, losses: 1, saves: 0, whip: 2.0 });
const lowInnAvg = calcPitcherSaber({ ip: "8", so: 6, bb: 4, hr: 1, r: 5, er: 5, era: 5.63, games: 8, wins: 0, losses: 1, saves: 0, whip: 1.5 });
ok("T14 저이닝 불펜 절편 바닥값 없음: 나쁜 8IP는 0 근처·음수 허용(+0.8 바닥 아님)", lowInnBad.WAR <= 0.15, `나쁜 WAR ${lowInnBad.WAR}`);
ok("T14b 저이닝 평범 8IP도 상한 상식적(<0.6)", lowInnAvg.WAR < 0.6 && lowInnAvg.WAR > lowInnBad.WAR, `평범 ${lowInnAvg.WAR} > 나쁜 ${lowInnBad.WAR}`);

// Blocker 1: 분수 이닝 정렬(rankByStat)·표시값 — "115 2/3" > "113" > "108 2/3" 가 0으로 뭉개지면 안 된다.
const ipRows = [
  { name: "올러", team: "두산", ip: "108 2/3", games: 20, qualifiedRate: 1 },
  { name: "네일", team: "KIA", ip: "115 2/3", games: 20, qualifiedRate: 1 },
  { name: "알칸타라", team: "키움", ip: "113", games: 20, qualifiedRate: 1 },
];
const ipRanked = rankByStat(ipRows as unknown as Parameters<typeof rankByStat>[0], "ip");
ok("T15 분수이닝 정렬: 네일(115⅔) 1위", ipRanked[0]?.name === "네일" && ipRanked[0]?.rank === 1, `1위 ${ipRanked[0]?.name}`);
ok("T16 분수이닝 정렬: 115⅔ > 113 > 108⅔ 순", ipRanked.map((x) => x.name).join(",") === "네일,알칸타라,올러", ipRanked.map((x) => x.name).join(","));
ok("T17 분수이닝 표시값 != 0 (모두 실이닝 보유)", ipRanked.every((x) => parseIP(x.ip as string) > 0), "all>0");

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
