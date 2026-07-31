/**
 * QA: fetchBoxScore 의 KBO→Naver failover 를 검증.
 *
 * 갭: KBO GetBoxScore 하드실패 시 fetchBoxScore 가 trackFallback 후 null 만 반환 →
 * summary·daily 공용 boxscore 가 통째로 비었다. #994(contextual-stats) 와 동일하게
 * Naver record.recordData.battersBoxscore/pitchersBoxscore 로 failover 한다.
 *
 * 삼순 NO-GO 재작업(3건)의 exact 게이트 — 실데이터 대조 + fault injection:
 *  1) 필드 매핑: pitchCount=bf, walks=bbhp, 포지션 BS_POS_MAP, 외국인 이름 playerCode 정규화
 *     → 저장 fixture(2026-07-29 5경기 실캡처) KBO↔Naver 대조로 56/56·130/130 증명.
 *  2) bounded 종료: KBO/Naver response·body stall + dual-fail 을 absolute deadline 안에 결정적 종료.
 *  3) 완전성 계약: 양팀 각각 usable 타자·투수 완전 → 채택, 한 팀/한 섹션 결측 partial → null.
 *
 * 실행: npx tsx scripts/qa/boxscore-naver-failover-smoke.ts
 */
import { readFileSync } from "fs";
import {
  parseNaverBoxScore,
  normalizeNaverInnings,
  fetchNaverBoxScore,
} from "../../src/lib/crawler/naver-record";
import { fetchBoxScore, type BoxScoreResult } from "../../src/lib/crawler/kbo-api";
import { getRecentFallbackBufferSizeForTest } from "../../src/lib/monitoring/api-fallback-tracker";
import { resolvePlayer } from "../../src/lib/utils/resolve-player";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { fail++; console.error(`  \u2717 ${name} ${detail}`); }
}

// ── 저장 fixture: 2026-07-29 5경기 Naver record.recordData + KBO GetBoxScore(파싱·resolve 후) 실캡처.
//    KBO↔Naver 를 독립 소스로 대조(삼순 방식) → pitchCount/walks/포지션/이름 정규화를 결정적으로 증명.
interface KboPit { name: string; pitchCount: number; walks: number }
interface KboBat { name: string; pos: string }
interface Fixture {
  [gameId: string]: {
    naver: unknown;
    kbo: { pit: KboPit[]; bat: KboBat[] };
  };
}
const FIXTURE: Fixture = JSON.parse(
  readFileSync(new URL("./fixtures/boxscore-failover-2026-07-29.json", import.meta.url), "utf-8"),
);
const GAME_IDS = Object.keys(FIXTURE);

// ── stub fetch (signal 인지 — bounded 종료 fault injection 용) ──
const origFetch = globalThis.fetch;
type StubHandler = (url: string, signal?: AbortSignal) => Response | Promise<Response>;
function stubFetch(handler: StubHandler) {
  globalThis.fetch = ((input: unknown, init?: { signal?: AbortSignal }) => {
    const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? input);
    return Promise.resolve(handler(url, init?.signal));
  }) as typeof fetch;
}
function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}
function errResponse(status: number): Response {
  return { ok: false, status, statusText: `E${status}`, json: async () => ({}) } as unknown as Response;
}
function abortError(): Error {
  const e = new Error("The operation was aborted");
  e.name = "AbortError";
  return e;
}
/** 무응답(response stall): signal abort 전까지 resolve 안 됨 → 실 fetch 의 abort 계약 재현. */
function hangResponse(signal?: AbortSignal): Promise<Response> {
  return new Promise<Response>((_, reject) => {
    if (signal?.aborted) return reject(abortError());
    signal?.addEventListener("abort", () => reject(abortError()));
  });
}
/** body stall: 헤더는 오지만 res.json() 이 signal abort 전까지 hang. */
function bodyStallResponse(signal?: AbortSignal): Response {
  return {
    ok: true,
    status: 200,
    json: () =>
      new Promise((_, reject) => {
        if (signal?.aborted) return reject(abortError());
        signal?.addEventListener("abort", () => reject(abortError()));
      }),
  } as unknown as Response;
}

async function main() {
  console.log("[boxscore-naver-failover-smoke]");
  // 서버(Next/Vercel) 이벤트 루프는 항상 살아있어 AbortSignal.timeout(unref 타이머)이 확실히 발화한다.
  // 스탠드얼론 스크립트는 루프가 조기 drain 될 수 있어 ref 타이머로 서버 환경을 충실히 재현한다.
  const keepAlive = setInterval(() => {}, 1000);

  // ── normalizeNaverInnings: Naver 유니코드 분수 → KBO GetBoxScore 표기 ──
  console.log("\n1) normalizeNaverInnings (Naver \u2192 KBO \ud3ec\ub9f7)");
  check("'3 \u2154' \u2192 '3 2/3'", normalizeNaverInnings("3 \u2154") === "3 2/3", `got ${normalizeNaverInnings("3 \u2154")}`);
  check("'1 \u2153' \u2192 '1 1/3'", normalizeNaverInnings("1 \u2153") === "1 1/3", `got ${normalizeNaverInnings("1 \u2153")}`);
  check("'0 \u2154' \u2192 '2/3' (\uc815\uc218\ubd80 0 \uc0dd\ub7b5)", normalizeNaverInnings("0 \u2154") === "2/3", `got ${normalizeNaverInnings("0 \u2154")}`);
  check("'3' \u2192 '3'", normalizeNaverInnings("3") === "3", `got ${normalizeNaverInnings("3")}`);

  // ── NO-GO#1 필드 매핑: 실데이터 5경기 KBO↔Naver 대조 (pitchCount=bf, walks=bbhp, pos, 이름) ──
  console.log("\n2) \uc2e4\ub370\uc774\ud130 5\uacbd\uae30 KBO\u2194Naver \ub300\uc870 (pitchCount=bf / walks=bbhp / \ud3ec\uc9c0\uc158 / \uc774\ub984)");
  let pcOk = 0, pcTot = 0, bbhpOk = 0, posOk = 0, posTot = 0, nameNormOk = 0, nameNormTot = 0;
  let flaggedWellsSeen = false;
  for (const g of GAME_IDS) {
    const box = parseNaverBoxScore(FIXTURE[g].naver as never);
    check(`${g} \uc644\uc804 fixture \u2192 non-null`, box !== null);
    if (!box) continue;
    const boxPit = [...box.awayPitchers, ...box.homePitchers];
    const boxBat = [...box.awayBatters, ...box.homeBatters];
    const kPit = FIXTURE[g].kbo.pit;
    const kBat = FIXTURE[g].kbo.bat;
    check(`${g} \ud22c\uc218 \uc218 \uc77c\uce58 (${boxPit.length}=${kPit.length})`, boxPit.length === kPit.length, `${boxPit.length} vs ${kPit.length}`);
    check(`${g} \ud0c0\uc790 \uc218 \uc77c\uce58 (${boxBat.length}=${kBat.length})`, boxBat.length === kBat.length, `${boxBat.length} vs ${kBat.length}`);
    const np = Math.min(boxPit.length, kPit.length);
    for (let i = 0; i < np; i++) {
      pcTot++;
      if (boxPit[i].pitchCount === kPit[i].pitchCount) pcOk++;
      else console.error(`    pitchCount MISS ${g} ${boxPit[i].name} naver=${boxPit[i].pitchCount} kbo=${kPit[i].pitchCount}`);
      if (boxPit[i].walks === kPit[i].walks) bbhpOk++;
      else console.error(`    walks MISS ${g} ${boxPit[i].name} naver=${boxPit[i].walks} kbo=${kPit[i].walks}`);
    }
    const nb = Math.min(boxBat.length, kBat.length);
    for (let i = 0; i < nb; i++) {
      posTot++;
      if (boxBat[i].position === kBat[i].pos) posOk++;
      else console.error(`    pos MISS ${g} ${boxBat[i].name} naver='${boxBat[i].position}' kbo='${kBat[i].pos}'`);
    }
  }
  // 이름 정규화: playerCode 가 resolve 되는 모든 선수는 canonical(로스터) 명으로 정규화됐는지 검증.
  const rd = (FIXTURE["20260729WOLG0"].naver as { pitchersBoxscore: { away: { name: string; pcode: string }[]; home: { name: string; pcode: string }[] } }).pitchersBoxscore;
  for (const p of [...rd.away, ...rd.home]) {
    const resolved = resolvePlayer(String(p.pcode));
    if (!resolved) continue;
    nameNormTot++;
    const box = parseNaverBoxScore(FIXTURE["20260729WOLG0"].naver as never)!;
    const rec = [...box.awayPitchers, ...box.homePitchers].find((x) => x.name === resolved.name);
    if (rec) nameNormOk++;
    if (p.name === "\uc6f0\uc2a4" && resolved.name === "\ub77c\ud074\ub780 \uc6f0\uc2a4") {
      flaggedWellsSeen = !![...box.awayPitchers, ...box.homePitchers].find((x) => x.name === "\ub77c\ud074\ub780 \uc6f0\uc2a4");
    }
  }
  check(`pitchCount = Naver bf : ${pcOk}/${pcTot} (56/56 \uae30\ub300)`, pcOk === pcTot && pcTot === 56, `${pcOk}/${pcTot}`);
  check(`walks = Naver bbhp : ${bbhpOk}/${pcTot} (56/56 \uae30\ub300)`, bbhpOk === pcTot && pcTot === 56, `${bbhpOk}/${pcTot}`);
  check(`\ud0c0\uc790 \ud3ec\uc9c0\uc158 BS_POS_MAP \uc815\uaddc\ud654 : ${posOk}/${posTot} (130/130 \uae30\ub300)`, posOk === posTot && posTot === 130, `${posOk}/${posTot}`);
  check(`playerCode \uc774\ub984 \uc815\uaddc\ud654(canonical) : ${nameNormOk}/${nameNormTot}`, nameNormOk === nameNormTot && nameNormTot > 0, `${nameNormOk}/${nameNormTot}`);
  check("\uc678\uad6d\uc778 \ud22c\uc218 \uc815\uaddc\ud654: '\uc6f0\uc2a4'(pcode 55348) \u2192 '\ub77c\ud074\ub780 \uc6f0\uc2a4' (\uc0bc\uc21c flagged 1\uac74)", flaggedWellsSeen);

  // 한국 선수 대조군: 정규화가 기존 이름을 깨지 않음.
  const wolg0 = parseNaverBoxScore(FIXTURE["20260729WOLG0"].naver as never)!;
  check("\ud55c\uad6d \ud22c\uc218 '\ud558\uc601\ubbfc' \uc774\ub984 \ubcf4\uc874(\uc815\uaddc\ud654 \ubb34\ud574)", [...wolg0.awayPitchers, ...wolg0.homePitchers].some((p) => p.name === "\ud558\uc601\ubbfc"));

  // ── inningsPitched 유니코드 정규화 (WOLG0 하영민 3 2/3) ──
  const hy = wolg0.awayPitchers.find((p) => p.name === "\ud558\uc601\ubbfc");
  check("\ud558\uc601\ubbfc inningsPitched='3 2/3'", hy?.inningsPitched === "3 2/3", String(hy?.inningsPitched));

  // ── NO-GO#3 완전성 계약: partial fixture → null, 완전 fixture → 채택 ──
  console.log("\n3) \uc644\uc804\uc131 \uacc4\uc57d fail-close (partial \u2192 null)");
  const completeNaver = FIXTURE["20260729WOLG0"].naver as {
    battersBoxscore: { away: unknown[]; home: unknown[] };
    pitchersBoxscore: { away: unknown[]; home: unknown[] };
  };
  // 삼순이 잡은 실제 partial: awayBatters 1명만, home batters·양팀 pitchers 전부 빈 fixture.
  const partialOneBatter = {
    battersBoxscore: { away: [completeNaver.battersBoxscore.away[0]], home: [] },
    pitchersBoxscore: { away: [], home: [] },
  };
  check("awayBatters 1\uba85\u00b7\ub098\uba38\uc9c0 empty \u2192 null (\uacfc\uac70 \ud1b5\uacfc\ud558\ub358 partial)", parseNaverBoxScore(partialOneBatter as never) === null);
  // 한 팀만 완전, 상대 팀 batters 결측 → null.
  const homeBattersMissing = {
    battersBoxscore: { away: completeNaver.battersBoxscore.away, home: [] },
    pitchersBoxscore: { away: completeNaver.pitchersBoxscore.away, home: completeNaver.pitchersBoxscore.home },
  };
  check("home batters \uc139\uc158 \uacb0\uce21 \u2192 null", parseNaverBoxScore(homeBattersMissing as never) === null);
  // 한 섹션(away pitchers) 결측 → null.
  const awayPitchersMissing = {
    battersBoxscore: { away: completeNaver.battersBoxscore.away, home: completeNaver.battersBoxscore.home },
    pitchersBoxscore: { away: [], home: completeNaver.pitchersBoxscore.home },
  };
  check("away pitchers \uc139\uc158 \uacb0\uce21 \u2192 null", parseNaverBoxScore(awayPitchersMissing as never) === null);
  // batters 부족(팀당 <9) → null.
  const tooFewBatters = {
    battersBoxscore: { away: completeNaver.battersBoxscore.away.slice(0, 5), home: completeNaver.battersBoxscore.home.slice(0, 5) },
    pitchersBoxscore: { away: completeNaver.pitchersBoxscore.away, home: completeNaver.pitchersBoxscore.home },
  };
  check("\ud300\ub2f9 \ud0c0\uc790 <9 \u2192 null (\ubbf8\uc644 \ub77c\uc778\uc5c5)", parseNaverBoxScore(tooFewBatters as never) === null);
  check("recordData null \u2192 null", parseNaverBoxScore(null) === null);
  check("battersBoxscore \uacb0\uce21 \u2192 null", parseNaverBoxScore({ pitchersBoxscore: { away: [], home: [] } } as never) === null);
  // 완전 fixture(양팀 9+타자·1+투수) → 채택.
  check("\uc644\uc804 fixture(\uc591\ud300 \uc644\uc804) \u2192 non-null \ucc44\ud0dd", parseNaverBoxScore(completeNaver as never) !== null);

  // ── 2차 NO-GO 회귀: 관제(trackFallback) Telegram stall 이 응답/Naver failover 를 블록하면 안 됨 ──
  //   삼순 실측: 동일 이벤트 키(kbo-boxscore) 3회째부터 legacy Telegram alert 가 timeout 없는 fetch 를
  //   await 해 fetchBoxScore 공용 absolute deadline 을 깨버렸다(KBO 503 케이스 8s+ 미종료).
  //   현 smoke 44/44 GREEN 은 TELEGRAM_BOT_TOKEN 미설정으로 alert 경로를 우회한 false-green.
  //   → 여기서만 토큰을 강제 설정하고 Telegram 을 stall 시켜, 미수정=RED(watchdog hang)/수정=GREEN.
  console.log("\n4a) 관제(trackFallback) Telegram stall 비블록 (2차 NO-GO 회귀)");
  const RB_KBO = 200, RB_NAVER = 150, RB_SLACK = 900, RB_WATCHDOG = 4000;
  const THRESHOLD = 3; // api-fallback-tracker ALERT_THRESHOLD: 동일 키 3회째부터 legacy Telegram alert
  const prevTgToken = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = "test-token-regression"; // false-green 제거: 임계치 alert 경로 강제
  const bufferBefore = getRecentFallbackBufferSizeForTest();
  let telegramOutstanding = 0;
  let telegramMaxOutstanding = 0;
  let telegramCalls = 0;
  function stalledTelegram(signal?: AbortSignal): Promise<Response> {
    telegramCalls++;
    telegramOutstanding++;
    telegramMaxOutstanding = Math.max(telegramMaxOutstanding, telegramOutstanding);
    return new Promise<Response>((_, reject) => {
      const finish = () => {
        telegramOutstanding--;
        reject(abortError());
      };
      if (signal?.aborted) return finish();
      signal?.addEventListener("abort", finish, { once: true });
    });
  }
  async function raceBounded(fn: () => Promise<BoxScoreResult | null>) {
    const t = Date.now();
    return await Promise.race([
      fn().then((res) => ({ hang: false as const, res, ms: Date.now() - t })),
      new Promise<{ hang: true }>((r) => setTimeout(() => r({ hang: true }), RB_WATCHDOG)),
    ]);
  }
  // 예열: 임계치 미만(count 1,2) — alert 미발화(await 해도 빠름). 3회째부터 alert 발화.
  stubFetch((url, signal) => {
    if (url.includes("koreabaseball.com")) return errResponse(503);
    if (url.includes("api-gw.sports.naver.com")) return errResponse(503);
    if (url.includes("api.telegram.org")) return stalledTelegram(signal);
    return errResponse(404);
  });
  for (let i = 1; i < THRESHOLD; i++) {
    await fetchBoxScore("20260729WOLG0", undefined, { kboTimeoutMs: RB_KBO, naverTimeoutMs: RB_NAVER });
  }
  // (A) KBO 503 + Telegram stall(3회째) → Naver 성공 + deadline 내 결정적 종료.
  stubFetch((url, signal) => {
    if (url.includes("koreabaseball.com")) return errResponse(503);
    if (url.includes("api-gw.sports.naver.com")) return jsonResponse({ result: { recordData: completeNaver } });
    if (url.includes("api.telegram.org")) return stalledTelegram(signal);
    return errResponse(404);
  });
  {
    const r = await raceBounded(() => fetchBoxScore("20260729WOLG0", undefined, { kboTimeoutMs: RB_KBO, naverTimeoutMs: RB_NAVER }));
    check(
      `(A) KBO 503 + Telegram stall(3회째) → deadline 내 종료 + Naver failover (${r.hang ? ">" + RB_WATCHDOG : r.ms}ms)`,
      !r.hang && r.res !== null && r.ms < RB_KBO + RB_NAVER + RB_SLACK,
      r.hang ? `HANG>${RB_WATCHDOG}ms (미수정 8s+)` : `${r.ms}ms res=${r.res ? "ok" : "null"}`,
    );
  }
  // (B) KBO 무응답(catch/timeout 분기) + Telegram stall → Naver 성공 + bounded.
  stubFetch((url, signal) => {
    if (url.includes("koreabaseball.com")) return hangResponse(signal);
    if (url.includes("api-gw.sports.naver.com")) return jsonResponse({ result: { recordData: completeNaver } });
    if (url.includes("api.telegram.org")) return stalledTelegram(signal);
    return errResponse(404);
  });
  {
    const r = await raceBounded(() => fetchBoxScore("20260729WOLG0", undefined, { kboTimeoutMs: RB_KBO, naverTimeoutMs: RB_NAVER }));
    check(
      `(B) KBO 무응답 + Telegram stall → deadline 내 종료 + Naver failover (${r.hang ? ">" + RB_WATCHDOG : r.ms}ms)`,
      !r.hang && r.res !== null && r.ms >= RB_KBO && r.ms < RB_KBO + RB_NAVER + RB_SLACK,
      r.hang ? `HANG>${RB_WATCHDOG}ms` : `${r.ms}ms res=${r.res ? "ok" : "null"}`,
    );
  }
  // (C) dual-fail (KBO 503 + Naver 무응답) + Telegram stall → null, deadline 내 종료.
  stubFetch((url, signal) => {
    if (url.includes("koreabaseball.com")) return errResponse(503);
    if (url.includes("api-gw.sports.naver.com")) return hangResponse(signal);
    if (url.includes("api.telegram.org")) return stalledTelegram(signal);
    return errResponse(404);
  });
  {
    const r = await raceBounded(() => fetchBoxScore("20260729WOLG0", undefined, { kboTimeoutMs: RB_KBO, naverTimeoutMs: RB_NAVER }));
    check(
      `(C) dual-fail + Telegram stall → null, deadline 내 종료 (${r.hang ? ">" + RB_WATCHDOG : r.ms}ms)`,
      !r.hang && r.res === null && r.ms < RB_KBO + RB_NAVER + RB_SLACK,
      r.hang ? `HANG>${RB_WATCHDOG}ms` : `${r.ms}ms`,
    );
  }
  check("Telegram stall 중 alert fanout ≤1", telegramCalls === 1 && telegramMaxOutstanding === 1, `calls=${telegramCalls} max=${telegramMaxOutstanding}`);
  check(
    "fallback 이벤트 버퍼 유지",
    getRecentFallbackBufferSizeForTest() >= bufferBefore + THRESHOLD + 2,
    `before=${bufferBefore} after=${getRecentFallbackBufferSizeForTest()}`,
  );
  await new Promise((resolve) => setTimeout(resolve, 8200));
  check("Telegram timeout 뒤 outstanding 0", telegramOutstanding === 0, `outstanding=${telegramOutstanding}`);
  process.env.TELEGRAM_BOT_TOKEN = prevTgToken;

  // ── NO-GO#2 bounded 종료: fault injection 결정적 종료 (absolute deadline) ──
  console.log("\n4) bounded \uc885\ub8cc (KBO/Naver response\u00b7body stall + dual-fail)");
  const KBO = 200, NAVER = 150, SLACK = 900; // 주입 budget (prod \uae30\ubcf8 6000/2500 \u2192 \ud14c\uc2a4\ud2b8 \ucd95\uc18c)
  async function timed(fn: () => Promise<BoxScoreResult | null>): Promise<{ ms: number; res: BoxScoreResult | null }> {
    const t = Date.now();
    const res = await fn();
    return { ms: Date.now() - t, res };
  }

  // (a) KBO response stall(무응답) → KBO budget 에서 abort → Naver 성공.
  stubFetch((url, signal) => {
    if (url.includes("koreabaseball.com")) return hangResponse(signal);
    if (url.includes("api-gw.sports.naver.com")) return jsonResponse({ result: { recordData: completeNaver } });
    return errResponse(404);
  });
  {
    const { ms, res } = await timed(() => fetchBoxScore("20260729WOLG0", undefined, { kboTimeoutMs: KBO, naverTimeoutMs: NAVER }));
    check(`(a) KBO \ubb34\uc751\ub2f5 \u2192 KBO budget \uc18c\uc9c4 \ud6c4 Naver failover \uc131\uacf5 (${ms}ms)`, res !== null && ms >= KBO && ms < KBO + NAVER + SLACK, `${ms}ms res=${res ? "ok" : "null"}`);
  }

  // (b) KBO response stall + Naver response stall → dual-fail, absolute deadline 결정적 종료.
  //     (supabase/telegram 등 KBO/Naver 외 URL 은 즉시 error — trackFallback 내부 fetch 는 stall 대상 아님)
  stubFetch((url, signal) =>
    url.includes("koreabaseball.com") || url.includes("api-gw.sports.naver.com") ? hangResponse(signal) : errResponse(500),
  );
  {
    const { ms, res } = await timed(() => fetchBoxScore("20260729WOLG0", undefined, { kboTimeoutMs: KBO, naverTimeoutMs: NAVER }));
    check(`(b) KBO+Naver \ubb34\uc751\ub2f5 dual-fail \u2192 null, deadline \uc548 \uc885\ub8cc (${ms}ms)`, res === null && ms >= KBO && ms < KBO + NAVER + SLACK, `${ms}ms res=${JSON.stringify(res)}`);
  }

  // (c) KBO 503(\uc989\uc2dc) + Naver response stall → Naver reserve 에서 abort.
  stubFetch((url, signal) => {
    if (url.includes("koreabaseball.com")) return errResponse(503);
    return hangResponse(signal);
  });
  {
    const { ms, res } = await timed(() => fetchBoxScore("20260729WOLG0", undefined, { kboTimeoutMs: KBO, naverTimeoutMs: NAVER }));
    check(`(c) KBO 503 + Naver \ubb34\uc751\ub2f5 \u2192 null, reserve \uc548 \uc885\ub8cc (${ms}ms)`, res === null && ms < KBO + NAVER + SLACK, `${ms}ms`);
  }

  // (d) KBO body stall(res.json() hang) → signal 이 body \ub3c4 \uc911\ub2e8 \u2192 failover.
  stubFetch((url, signal) => {
    if (url.includes("koreabaseball.com")) return bodyStallResponse(signal);
    if (url.includes("api-gw.sports.naver.com")) return jsonResponse({ result: { recordData: completeNaver } });
    return errResponse(404);
  });
  {
    const { ms, res } = await timed(() => fetchBoxScore("20260729WOLG0", undefined, { kboTimeoutMs: KBO, naverTimeoutMs: NAVER }));
    check(`(d) KBO body stall \u2192 KBO signal abort \ud6c4 Naver failover (${ms}ms)`, res !== null && ms >= KBO && ms < KBO + NAVER + SLACK, `${ms}ms res=${res ? "ok" : "null"}`);
  }

  // (e) Naver body stall → Naver 도 결정적 종료(null).
  stubFetch((url, signal) => {
    if (url.includes("koreabaseball.com")) return errResponse(503);
    if (url.includes("api-gw.sports.naver.com")) return bodyStallResponse(signal);
    return errResponse(500);
  });
  {
    const { ms, res } = await timed(() => fetchBoxScore("20260729WOLG0", undefined, { kboTimeoutMs: KBO, naverTimeoutMs: NAVER }));
    check(`(e) KBO 503 + Naver body stall \u2192 null, deadline \uc548 \uc885\ub8cc (${ms}ms)`, res === null && ms < KBO + NAVER + SLACK, `${ms}ms`);
  }

  // ── failover 통합: KBO 실패 주입 → Naver 성공/partial ──
  console.log("\n5) fetchBoxScore failover \ud1b5\ud569");
  // (a) KBO 503 → Naver \uc644\uc804 fixture \uc131\uacf5 (summary/prewarm/daily \uc18c\ube44 PASS).
  stubFetch((url) => {
    if (url.includes("koreabaseball.com")) return errResponse(503);
    if (url.includes("api-gw.sports.naver.com")) return jsonResponse({ result: { recordData: completeNaver } });
    return errResponse(404);
  });
  const failover = await fetchBoxScore("20260729WOLG0");
  check("KBO 503 \u2192 Naver failover \ube44\uc9c0 \uc54a\uc74c", failover !== null);
  check("failover pitchCount(bf) \ubcf5\uc6d0 (\ubaa8\ub450 \u22650, \ud558\ub098\ub77c\ub3c4 >0)", (failover?.awayPitchers ?? []).some((p) => p.pitchCount > 0));
  check("failover walks(bbhp) \ub9e4\ud551", (failover?.awayPitchers ?? []).every((p) => typeof p.walks === "number"));

  // (b) KBO 503 → Naver partial(awayBatters 1\uba85) \u2192 null fail-close.
  stubFetch((url) => {
    if (url.includes("koreabaseball.com")) return errResponse(503);
    if (url.includes("api-gw.sports.naver.com")) return jsonResponse({ result: { recordData: partialOneBatter } });
    return errResponse(404);
  });
  const partialFailover = await fetchBoxScore("20260729WOLG0");
  check("KBO 503 \u2192 Naver partial \u2192 null (fail-close)", partialFailover === null, JSON.stringify(partialFailover));

  // (c) KBO 503 + Naver 503 → null.
  stubFetch(() => errResponse(503));
  check("KBO 503 + Naver 503 \u2192 null", (await fetchBoxScore("20260729WOLG0")) === null);

  // ── fetchNaverBoxScore 직접(bounded) ──
  console.log("\n6) fetchNaverBoxScore wrapper (bounded)");
  stubFetch((url) => (url.includes("api-gw.sports.naver.com") ? jsonResponse({ result: { recordData: completeNaver } }) : errResponse(404)));
  const direct = await fetchNaverBoxScore("20260729WOLG0", { timeoutMs: 500 });
  check("fetchNaverBoxScore \u2192 BoxScoreResult", direct !== null && direct.awayPitchers.length > 0);

  globalThis.fetch = origFetch;
  clearInterval(keepAlive);
  console.log(`\n\uacb0\uacfc: ${pass} pass / ${fail} fail`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
