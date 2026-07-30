/**
 * KBO LINEUP_CK 파서 순수 회귀 (라인업 확정 트리거)
 * + Naver preview 확정 폴백 회귀(삼순 PR#988 P0-2 ② — 완전 라인업→true / 부분→null fail-close).
 * 실행: npm run qa:lineup-ck
 */
import { parseLineupCk, fetchLineupConfirmed } from "../../src/lib/crawler/lineup-confirmed";
import { parseNaverPreviewLineup } from "../../src/lib/crawler/naver-lineup";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.error(`  ❌ ${name}`); }
}

// game-detail 응답 형태: data[0] = [{ LINEUP_CK: true/false }]
ok("LINEUP_CK true → true", parseLineupCk([[{ LINEUP_CK: true }], [], [], [], []]) === true);
ok("LINEUP_CK false → false", parseLineupCk([[{ LINEUP_CK: false }], []]) === false);
ok("빈 배열 → null", parseLineupCk([]) === null);
ok("data[0] 빈 → null", parseLineupCk([[]]) === null);
ok("LINEUP_CK 키 없음 → null", parseLineupCk([[{ FOO: 1 }]]) === null);
ok("비배열 → null", parseLineupCk(null) === null);
ok("문자열 → null", parseLineupCk("x") === null);
ok("truthy 비-boolean(1) → true", parseLineupCk([[{ LINEUP_CK: 1 }]]) === true);
ok("falsy(0) → false", parseLineupCk([[{ LINEUP_CK: 0 }]]) === false);

// ── (삼순 #952 4차 blocker1) timeoutMs 는 srId 0/1 합산 절대 예산 — 2배 초과 금지 ──
async function budget() {
  const realFetch = globalThis.fetch;
  // fetch 를 자기 signal.abort 에서만 reject 하도록 mock(서버 응답 없음=느린 경기).
  // ⚠️ AbortSignal.timeout() 타이머는 Node 에서 unref 되어, 순수 promise mock 만 있으면
  //    이벤트루프가 abort 전에 비어 종료된다(실 fetch 는 refed 소켓으로 정상). refed keepAlive 로
  //    루프를 살려 abort 가 실제로 발생하게 한다.
  const keepAlive = setInterval(() => {}, 5);
  let kboCalls = 0;
  let naverCalls = 0;
  globalThis.fetch = ((url: unknown, init?: { signal?: AbortSignal }) => {
    if (String(url).includes("/preview")) naverCalls++;
    else kboCalls++;
    return new Promise((_resolve, reject) => {
      const sig = init?.signal;
      if (!sig) return;
      if (sig.aborted) return reject(new Error("aborted"));
      sig.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  }) as typeof fetch;
  try {
    const BUDGET = 40;
    const t0 = Date.now();
    const ck = await fetchLineupConfirmed("20260729LGWO0", { timeoutMs: BUDGET });
    const elapsed = Date.now() - t0;
    ok("전건 abort → null(신호 못 얻음)", ck === null);
    // KBO hang 은 kboBudget(=60%)에서 abort, Naver 는 reserve(=잔여 40%)에서 abort → 합계 ≈ BUDGET.
    // 구 코드(srId 마다 40ms) 면 ~80ms. 신 코드는 전체 절대 예산 결속로 1배 근처.
    ok(`전체 소요 ≤ 2배 미만(${elapsed}ms < 70ms)`, elapsed < 70);
    // srId 예산 공유: srId0 가 kboBudget 소진 → srId1 은 remaining≤0 으로 break → kboCalls=1.
    ok(`srId 예산 공유 — srId0 소진 후 srId1 즉시 break(kboCalls=${kboCalls}===1)`, kboCalls === 1);
    // 삼순 #988 재리뷰 P0: KBO hard-hang 이 전체 예산을 삼켜도 Naver 폴백은 reserve 에서 반드시 시도된다.
    ok(`KBO hang 이후 Naver reserve 호출 보장(naverCalls=${naverCalls}===1)`, naverCalls === 1);
  } finally {
    clearInterval(keepAlive);
    globalThis.fetch = realFetch;
  }
}

// ── Naver preview 파서(공용 어댑터) — 완전 라인업(선발1+타자9)만 스냅샷, 그 외 전부 null ──
const POSITIONS = ["중견수", "유격수", "지명타자", "1루수", "우익수", "좌익수", "3루수", "포수", "2루수"];
function sideJson(sp: string, batterCount = 9, starterCount = 1) {
  return {
    fullLineUp: [
      ...Array.from({ length: starterCount }, () => ({ positionName: "선발투수", playerName: sp })),
      ...POSITIONS.slice(0, batterCount).map((positionName, i) => ({ positionName, playerName: `타자${i + 1}` })),
    ],
  };
}
function previewJson(away: unknown, home: unknown) {
  return { result: { previewData: { awayTeamLineUp: away, homeTeamLineUp: home } } };
}

const full = parseNaverPreviewLineup(previewJson(sideJson("네일"), sideJson("페덱")));
ok("완전 라인업 → 스냅샷 confirmed=true", full?.confirmed === true);
ok("선발투수 보존(away/home)", full?.away.starter === "네일" && full?.home.starter === "페덱");
ok("타자 정확히 9 + 타순 1~9", full?.away.batters.length === 9 && full?.away.batters[8].order === 9);
ok("포지션 영문 매핑(중견수→CF)", full?.away.batters[0].position === "CF");
ok("타자 8명(부분) → null", parseNaverPreviewLineup(previewJson(sideJson("네일", 8), sideJson("페덱"))) === null);
ok("선발투수 0명 → null", parseNaverPreviewLineup(previewJson(sideJson("네일", 9, 0), sideJson("페덱"))) === null);
ok("선발투수 2명 → null", parseNaverPreviewLineup(previewJson(sideJson("네일", 9, 2), sideJson("페덱"))) === null);
ok("미확정(fullLineUp 빈 배열) → null", parseNaverPreviewLineup(previewJson({ fullLineUp: [] }, sideJson("페덱"))) === null);
ok("previewData 결측 → null", parseNaverPreviewLineup({ result: {} }) === null);
ok("이름 결측 엔트리 → null(fail-close)", parseNaverPreviewLineup(previewJson({
  fullLineUp: [{ positionName: "선발투수", playerName: "" }, ...POSITIONS.map((p, i) => ({ positionName: p, playerName: `타자${i + 1}` }))],
}, sideJson("페덱"))) === null);

// ── fetchLineupConfirmed × Naver 확정 폴백 경로(watchdog 소비 계약) ──
async function naverConfirmFallback() {
  const realFetch = globalThis.fetch;
  const mock = (kbo: () => Promise<Response> | Response, naver: (() => Promise<Response> | Response) | null) => {
    let naverCalls = 0;
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url);
      if (u.includes("GetLineUpAnalysis")) return kbo();
      if (u.includes("/preview")) { naverCalls++; if (!naver) throw new Error("naver down"); return naver(); }
      throw new Error(`unexpected url ${u}`);
    }) as typeof fetch;
    return () => naverCalls;
  };
  const kbo204 = () => new Response(null, { status: 200 }); // body 없음 → json() throw = 신호 못 얻음(실측 204 등가)
  const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
  try {
    // KBO 열화 + Naver 완전 라인업 → true(확정 근거)
    mock(kbo204, () => json(previewJson(sideJson("네일"), sideJson("페덱"))));
    ok("KBO 열화 + Naver 완전 → true", (await fetchLineupConfirmed("20260730HTSS0", { timeoutMs: 2000 })) === true);
    // KBO 열화 + Naver 부분(8타자) → null(fail-close, 오발송 방지)
    mock(kbo204, () => json(previewJson(sideJson("네일", 8), sideJson("페덱"))));
    ok("KBO 열화 + Naver 부분 → null", (await fetchLineupConfirmed("20260730HTSS0", { timeoutMs: 2000 })) === null);
    // KBO 열화 + Naver 미확정(빈 배열) → null
    mock(kbo204, () => json(previewJson({ fullLineUp: [] }, { fullLineUp: [] })));
    ok("KBO 열화 + Naver 미확정 → null", (await fetchLineupConfirmed("20260730HTSS0", { timeoutMs: 2000 })) === null);
    // KBO 열화 + Naver 조회 실패 → null
    mock(kbo204, null);
    ok("KBO 열화 + Naver 실패 → null", (await fetchLineupConfirmed("20260730HTSS0", { timeoutMs: 2000 })) === null);
    // KBO 명시적 false → false 그대로(미확정 존중) + Naver 미호출
    const calls = mock(() => json([[{ LINEUP_CK: false }]]), () => json(previewJson(sideJson("네일"), sideJson("페덱"))));
    ok("KBO false → false(Naver 미호출)", (await fetchLineupConfirmed("20260730HTSS0", { timeoutMs: 2000 })) === false && calls() === 0);
    // KBO true → true(Naver 미호출)
    const calls2 = mock(() => json([[{ LINEUP_CK: true }]]), () => json(previewJson(sideJson("네일"), sideJson("페덱"))));
    ok("KBO true → true(Naver 미호출)", (await fetchLineupConfirmed("20260730HTSS0", { timeoutMs: 2000 })) === true && calls2() === 0);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── (삼순 #988 재리뷰 P0) KBO hard-timeout(무응답 hang) 경계 — Naver reserve 가 실제로 호출되는가 ──
// naverConfirmFallback 은 KBO 가 "빠른 빈 body"(json throw)라 hard timeout 경계를 못 잡는다.
// 여기서는 KBO fetch 를 생 fetch 처럼 **응답 없이 hang**(signal.abort 에서만 reject)시켜
// timeoutMs 전체 예산을 KBO 가 삼키려 하는 실타이머 경계를 재현한다.
// AbortSignal.timeout 타이머는 Node 에서 unref 되므로 refed keepAlive 로 루프를 살려 abort 가 실제 발생하게 한다.
async function hardTimeoutNaverReserve() {
  const realFetch = globalThis.fetch;
  const keepAlive = setInterval(() => {}, 5);
  const mock = (naver: (() => Promise<Response> | Response) | null) => {
    let kboCalls = 0;
    let naverCalls = 0;
    globalThis.fetch = ((url: unknown, init?: { signal?: AbortSignal }) => {
      const u = String(url);
      if (u.includes("/preview")) {
        naverCalls++;
        if (!naver) return Promise.reject(new Error("naver down"));
        return Promise.resolve(naver() as Response);
      }
      // KBO GetLineUpAnalysis: 응답 없이 hang — signal.abort 에서만 reject(=무응답 경기)
      kboCalls++;
      return new Promise((_resolve, reject) => {
        const sig = init?.signal;
        if (!sig) return;
        if (sig.aborted) return reject(new Error("aborted"));
        sig.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }) as typeof fetch;
    return () => ({ kboCalls, naverCalls });
  };
  const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
  try {
    // KBO 무응답 hang + Naver 완전 라인업(선발1+타자9 양팀) → true(확정). 핵심: Naver 가 실제 호출됨.
    let c = mock(() => json(previewJson(sideJson("네일"), sideJson("페덱"))));
    const t0 = Date.now();
    const r = await fetchLineupConfirmed("20260730HTSS0", { timeoutMs: 60 });
    const el = Date.now() - t0;
    ok(`KBO hard-hang + Naver 완전 → true(확정, ${el}ms)`, r === true);
    ok(`  └ KBO 1회·Naver reserve 실호출(kbo=${c().kboCalls},naver=${c().naverCalls})`, c().kboCalls === 1 && c().naverCalls === 1);
    // KBO 무응답 hang + Naver 부분(8타자) → null(fail-close)
    c = mock(() => json(previewJson(sideJson("네일", 8), sideJson("페덱"))));
    ok("KBO hard-hang + Naver 부분 → null", (await fetchLineupConfirmed("20260730HTSS0", { timeoutMs: 60 })) === null);
    // KBO 무응답 hang + Naver 조회 실패 → null(양쪽 실패)
    c = mock(null);
    ok("KBO hard-hang + Naver 실패 → null", (await fetchLineupConfirmed("20260730HTSS0", { timeoutMs: 60 })) === null);
  } finally {
    clearInterval(keepAlive);
    globalThis.fetch = realFetch;
  }
}

async function run() {
  await budget();
  await hardTimeoutNaverReserve();
  await naverConfirmFallback();
  console.log(`\nlineup-ck 파서: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}
run();
