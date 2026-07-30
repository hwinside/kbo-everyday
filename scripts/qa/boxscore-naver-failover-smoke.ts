/**
 * QA: fetchBoxScore 의 KBO→Naver failover 를 검증.
 *
 * 갭: KBO GetBoxScore 하드실패 시 fetchBoxScore 가 trackFallback 후 null 만 반환 →
 * summary·daily 공용 boxscore 가 통째로 비었다. #994(contextual-stats) 와 동일하게
 * Naver record.recordData.battersBoxscore/pitchersBoxscore 로 failover 한다.
 *
 * 실행: npx tsx scripts/qa/boxscore-naver-failover-smoke.ts
 */
import {
  parseNaverBoxScore,
  normalizeNaverInnings,
  fetchNaverBoxScore,
} from "../../src/lib/crawler/naver-record";
import { fetchBoxScore, type BoxScoreResult } from "../../src/lib/crawler/kbo-api";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { fail++; console.error(`  \u2717 ${name} ${detail}`); }
}

// 실측 캡처: WOLG0 20260729 record.recordData (선수 일부만 발췌 — 필드/포맷은 실제 원값).
const WOLG0: unknown = {
  battersBoxscore: {
    away: [
      { batOrder: 1, pos: "\uc9c0", name: "\uc11c\uac74\ucc3d", ab: 6, hit: 5, run: 3, rbi: 2, hr: 0, bb: 0, kk: 0, sb: 1, hra: "0.302" },
      { batOrder: 1, pos: "\ud0c0", name: "\uae40\uc6c5\ube48", ab: 0, hit: 0, run: 0, rbi: 0, hr: 0, bb: 1, kk: 0, sb: 0, hra: "0.250" },
      { batOrder: 2, pos: "\u4e8c", name: "\uc548\uce58\ud64d", ab: 6, hit: 3, run: 2, rbi: 2, hr: 0, bb: 0, kk: 0, sb: 0, hra: "0.270" },
    ],
    home: [
      { batOrder: 1, pos: "\uc6b0", name: "\ud64d\ucc3d\uae30", ab: 3, hit: 1, run: 2, rbi: 0, hr: 0, bb: 0, kk: 1, sb: 0, hra: "0.262" },
      { batOrder: 1, pos: "\ud0c0\uc6b0", name: "\uc1a1\ucc2c\uc758", ab: 2, hit: 2, run: 2, rbi: 0, hr: 0, bb: 1, kk: 0, sb: 0, hra: "0.292" },
    ],
  },
  pitchersBoxscore: {
    away: [
      { name: "\ud558\uc601\ubbfc", inn: "3 \u2154", wls: "", hit: 10, r: 7, hr: 1, kk: 3, bb: 1, er: 7, era: "4.55" },
      { name: "\uae40\uc120\uae30", inn: "1 \u2154", wls: "\uc2b9", hit: 2, r: 2, hr: 1, kk: 0, bb: 1, er: 2, era: "6.10" },
      { name: "\uae40\uc131\ubbfc", inn: "0 \u2154", wls: "", hit: 0, r: 0, hr: 0, kk: 0, bb: 0, er: 0, era: "0.00" },
    ],
    home: [
      { name: "\uc6f0\uc2a4", inn: "3", wls: "", hit: 9, r: 5, hr: 2, kk: 2, bb: 2, er: 5, era: "4.04" },
      { name: "\uae40\uc601\uc6b0", inn: "1 \u2153", wls: "", hit: 2, r: 2, hr: 0, kk: 2, bb: 1, er: 2, era: "3.16" },
    ],
  },
};

const origFetch = globalThis.fetch;
function stubFetch(handler: (url: string) => Response | Promise<Response>) {
  globalThis.fetch = ((input: unknown) => {
    const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? input);
    return Promise.resolve(handler(url));
  }) as typeof fetch;
}
function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}
function errResponse(status: number): Response {
  return { ok: false, status, statusText: `E${status}`, json: async () => ({}) } as unknown as Response;
}

async function main() {
  console.log("[boxscore-naver-failover-smoke]");

  // ── normalizeNaverInnings: Naver 유니코드 분수 → KBO GetBoxScore 표기 ──
  console.log("\n1) normalizeNaverInnings (Naver \u2192 KBO \ud3ec\ub9f7)");
  check("'3 \u2154' \u2192 '3 2/3'", normalizeNaverInnings("3 \u2154") === "3 2/3", `got ${normalizeNaverInnings("3 \u2154")}`);
  check("'1 \u2153' \u2192 '1 1/3'", normalizeNaverInnings("1 \u2153") === "1 1/3", `got ${normalizeNaverInnings("1 \u2153")}`);
  check("'0 \u2154' \u2192 '2/3' (\uc815\uc218\ubd80 0 \uc0dd\ub7b5)", normalizeNaverInnings("0 \u2154") === "2/3", `got ${normalizeNaverInnings("0 \u2154")}`);
  check("'3' \u2192 '3'", normalizeNaverInnings("3") === "3", `got ${normalizeNaverInnings("3")}`);

  // ── (RED baseline) pure mapper: 실측 fixture → BoxScoreResult exact ──
  console.log("\n2) parseNaverBoxScore (\uc2e4\uce21 fixture \u2192 BoxScoreResult exact)");
  const box = parseNaverBoxScore(WOLG0 as never)!;
  check("not null", !!box);
  check("awayBatters 3\uba85", box.awayBatters.length === 3, `got ${box.awayBatters.length}`);
  check("homeBatters 2\uba85", box.homeBatters.length === 2, `got ${box.homeBatters.length}`);
  check("awayPitchers 3\uba85", box.awayPitchers.length === 3, `got ${box.awayPitchers.length}`);
  check("homePitchers 2\uba85", box.homePitchers.length === 2, `got ${box.homePitchers.length}`);

  const seogeon = box.awayBatters[0];
  check("\uc11c\uac74\ucc3d order=1/pos=\uc9c0/ab=6/hit=5/run=3/rbi=2/sb=1/avg=0.302",
    seogeon.order === 1 && seogeon.position === "\uc9c0" && seogeon.atBats === 6 && seogeon.hits === 5 &&
    seogeon.runs === 3 && seogeon.rbi === 2 && seogeon.sb === 1 && seogeon.avg === "0.302" && seogeon.name === "\uc11c\uac74\ucc3d",
    JSON.stringify(seogeon));
  check("\uc11c\uac74\ucc3d isSubstitute=false (\uc120\ubc1c)", seogeon.isSubstitute === false);

  const kimwoongbin = box.awayBatters[1];
  check("\uae40\uc6c5\ube48 isSubstitute=true (batOrder \uc911\ubcf5 + pos '\ud0c0')", kimwoongbin.isSubstitute === true);
  check("\uae40\uc6c5\ube48 bb=1", kimwoongbin.bb === 1);

  const songchani = box.homeBatters[1];
  check("\uc1a1\ucc2c\uc758 isSubstitute=true (pos '\ud0c0\uc6b0')", songchani.isSubstitute === true);

  const hayoungmin = box.awayPitchers[0];
  check("\ud558\uc601\ubbfc inningsPitched='3 2/3' (\uc720\ub2c8\ucf54\ub4dc \uc815\uaddc\ud654)", hayoungmin.inningsPitched === "3 2/3", hayoungmin.inningsPitched);
  check("\ud558\uc601\ubbfc decision='' (wls \ube48\uac12)", hayoungmin.decision === "", `got '${hayoungmin.decision}'`);
  check("\ud558\uc601\ubbfc hits=10/runs=7/hr=1/K=3/bb=1/er=7/era=4.55",
    hayoungmin.hits === 10 && hayoungmin.runs === 7 && hayoungmin.hr === 1 && hayoungmin.strikeouts === 3 &&
    hayoungmin.walks === 1 && hayoungmin.earnedRuns === 7 && hayoungmin.era === "4.55", JSON.stringify(hayoungmin));

  const kimseongi = box.awayPitchers[1];
  check("\uae40\uc120\uae30 decision='\uc2b9' + inn='1 2/3'", kimseongi.decision === "\uc2b9" && kimseongi.inningsPitched === "1 2/3", JSON.stringify(kimseongi));
  check("\uae40\uc131\ubbfc inn='2/3' (0 \u2154 \u2192 2/3)", box.awayPitchers[2].inningsPitched === "2/3", box.awayPitchers[2].inningsPitched);

  // ── pitchCount degrade (P0: Naver \ubbf8\uc81c\uacf5 \u2192 0, \uc704\uc7a5 \uae08\uc9c0) ──
  console.log("\n3) pitchCount degrade (Naver \ubbf8\uc81c\uacf5 \u2192 0)");
  const allPitchers = [...box.awayPitchers, ...box.homePitchers];
  check("\ubaa8\ub4e0 \ud22c\uc218 pitchCount=0", allPitchers.every((p) => p.pitchCount === 0), JSON.stringify(allPitchers.map((p) => p.pitchCount)));

  // ── fail-close: 빈/결측 → null ──
  console.log("\n4) fail-close (\uacb0\uce21/\ube48\ubc30\uc5f4 \u2192 null)");
  check("battersBoxscore \uacb0\uce21 \u2192 null", parseNaverBoxScore({ pitchersBoxscore: { away: [], home: [] } } as never) === null);
  check("\uc591\ud300 \uc804\ubd80 \ube48\ubc30\uc5f4 \u2192 null",
    parseNaverBoxScore({ battersBoxscore: { away: [], home: [] }, pitchersBoxscore: { away: [], home: [] } } as never) === null);
  check("recordData null \u2192 null", parseNaverBoxScore(null) === null);

  // ── (a) KBO 실패 주입 → Naver 성공 → BoxScoreResult ──
  console.log("\n5) fetchBoxScore failover (a) KBO \uc2e4\ud328 \u2192 Naver \uc131\uacf5");
  stubFetch((url) => {
    if (url.includes("koreabaseball.com")) return errResponse(503); // KBO \ud558\ub4dc\uc2e4\ud328
    if (url.includes("api-gw.sports.naver.com")) return jsonResponse({ result: { recordData: WOLG0 } });
    return errResponse(404);
  });
  const failover: BoxScoreResult | null = await fetchBoxScore("20260729WOLG0");
  check("KBO 503 \u2192 Naver failover \ube44\uc9c0 \uc54a\uc74c", failover !== null);
  check("failover awayPitchers[0].inn='3 2/3'", failover?.awayPitchers[0].inningsPitched === "3 2/3", String(failover?.awayPitchers[0].inningsPitched));
  check("failover awayBatters 3\uba85 + \uc11c\uac74\ucc3d hit=5", failover?.awayBatters.length === 3 && failover?.awayBatters[0].hits === 5);
  check("failover pitchCount=0 degrade", (failover?.awayPitchers ?? []).every((p) => p.pitchCount === 0));

  // ── (b) KBO 실패 + Naver 실패 → null ──
  console.log("\n6) fetchBoxScore failover (b) KBO+Naver \ubaa8\ub450 \uc2e4\ud328 \u2192 null");
  stubFetch(() => errResponse(503));
  const both = await fetchBoxScore("20260729WOLG0");
  check("KBO 503 + Naver 503 \u2192 null (fail-close)", both === null, JSON.stringify(both));

  // ── fetchNaverBoxScore \uc9c1\uc811(\ub124\ud2b8\uc6cc\ud06c \ub798\ud37c) ──
  console.log("\n7) fetchNaverBoxScore wrapper");
  stubFetch((url) => (url.includes("api-gw.sports.naver.com") ? jsonResponse({ result: { recordData: WOLG0 } }) : errResponse(404)));
  const direct = await fetchNaverBoxScore("20260729WOLG0");
  check("fetchNaverBoxScore \u2192 BoxScoreResult", direct?.homePitchers[1].inningsPitched === "1 1/3", String(direct?.homePitchers[1].inningsPitched));

  globalThis.fetch = origFetch;
  console.log(`\n\uacb0\uacfc: ${pass} pass / ${fail} fail`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
