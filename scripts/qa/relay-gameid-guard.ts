/**
 * relay/detail gameId canonical 가드 회귀 게이트.
 *
 * WHY (2026-08-11 인시던트): 네이버식 긴 gameId(연도 suffix 포함)를 라우트에
 * 넘기면 toNaverGameId가 연도를 한 번 더 붙여 자기유발 404 → "네이버가 Vercel을
 * 차단" 오판(PR #1150 폐기)으로 이어졌다. 이 게이트는:
 *   1) isCanonicalKboGameId 단위 판정 (수용/거부 케이스)
 *   2) /api/game-relay GET: 긴 ID → 400, 업스트림 fetch 0회 (fail-close 실측)
 *   3) /api/game-relay GET: canonical ID → 검증 통과, 업스트림 URL이 정확히
 *      단일 연도 suffix (…LGWO02026) — 과차단/이중변환 양쪽 회귀 검출
 *   4) /api/game-detail GET: 긴 ID → 400
 *   5) single-flight: 동일 key 동시 요청 → 업스트림 inning=1 fetch 정확히 1회
 *   6) 실패 후 재시도: 실패 promise가 맵에 박제되지 않고 다음 요청은 새 업스트림 시도
 *   7) 복구 알림 게이트: degraded 200에서는 복구 미발송(삼순 Blocker 1),
 *      완전 정상에서 1회만 발송(중복 금지)
 *
 * 실행: npm run qa:relay-gameid-guard  (network 불필요 — fetch는 스텁, prebuild 결속)
 */

// 라우트 import 전에 supabase client 생성용 env 주입 (스모크 공통 패턴)
process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://stub.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "stub-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "stub-service-key";

import { NextRequest } from "next/server";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    pass++;
    console.log(`  PASS ${name}`);
  } else {
    fail++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  const { isCanonicalKboGameId } = await import("../../src/lib/game/game-id");

  console.log("[1] isCanonicalKboGameId 단위 판정");
  check("canonical 수용", isCanonicalKboGameId("20260811LGWO0"));
  check("더블헤더 1차전 수용", isCanonicalKboGameId("20260811LGWO1"));
  check("더블헤더 2차전 수용", isCanonicalKboGameId("20260811LGWO2"));
  check("올스타 수용", isCanonicalKboGameId("20260711WEEA0"));
  check("네이버식 긴 ID 거부", !isCanonicalKboGameId("20260811LGWO02026"));
  check("이중 연도 suffix 거부", !isCanonicalKboGameId("20260811LGWO020262026"));
  check("소문자 거부", !isCanonicalKboGameId("20260811lgwo0"));
  check("빈 문자열 거부", !isCanonicalKboGameId(""));
  check("날짜 결손 거부", !isCanonicalKboGameId("2026081LGWO0"));

  // 업스트림 fetch 스텁: 호출 URL 기록, 즉시 타임아웃성 실패 (파이프라인 후속 로직 종료용)
  const upstreamCalls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("api-gw.sports.naver.com")) {
      upstreamCalls.push(url);
      const err = new Error("stubbed upstream (qa gate)");
      err.name = "TimeoutError";
      throw err;
    }
    // supabase 등 다른 호출도 전부 차단 (네트워크 0 계약)
    const err = new Error("unexpected network call in qa gate: " + url);
    throw err;
  }) as typeof fetch;

  try {
    const relayRoute = await import("../../src/app/api/game-relay/route");
    const detailRoute = await import("../../src/app/api/game-detail/route");

    console.log("[2] /api/game-relay 긴 ID → 400, 업스트림 0회");
    upstreamCalls.length = 0;
    const r1 = await relayRoute.GET(
      new NextRequest("http://localhost/api/game-relay?gameId=20260811LGWO02026"),
    );
    check("긴 ID 400", r1.status === 400, `got ${r1.status}`);
    const b1 = await r1.json();
    check("에러 본문 명시", b1.error === "invalid gameId format", JSON.stringify(b1));
    check("업스트림 fetch 0회", upstreamCalls.length === 0, `${upstreamCalls.length}회`);

    console.log("[3] /api/game-relay canonical ID → 검증 통과 + 단일 연도 suffix");
    upstreamCalls.length = 0;
    const r2 = await relayRoute.GET(
      new NextRequest("http://localhost/api/game-relay?gameId=20260811LGWO0"),
    );
    check("canonical은 400 아님(검증 통과)", r2.status !== 400, `got ${r2.status}`);
    check("업스트림 도달 1회 이상", upstreamCalls.length >= 1, `${upstreamCalls.length}회`);
    const naverUrl = upstreamCalls[0] ?? "";
    check(
      "네이버 URL이 정확히 단일 연도 suffix",
      naverUrl.includes("/20260811LGWO02026/relay") && !naverUrl.includes("020262026"),
      naverUrl,
    );

    console.log("[4] /api/game-detail 긴 ID → 400");
    const r3 = await detailRoute.GET(
      new NextRequest("http://localhost/api/game-detail?gameId=20260811LGWO02026"),
    );
    check("긴 ID 400", r3.status === 400, `got ${r3.status}`);

    // ===== [5][6][7]은 응답 가능한 업스트림 스텁이 필요 =====
    // 최소 유효 스키마: textRelays 배열(빈 배열 = 정당한 빈 이닝). 이닝별 실패/지연/
    // 텔레그램 인터셉트를 한 스텁에서 제어한다.
    let inning1Calls = 0;
    let telegramCalls = 0;
    let upstreamMode: {
      currentInning: number;
      failInnings: Set<number>;
      failAll?: boolean;
      delayMs?: number;
    } = { currentInning: 1, failInnings: new Set() };
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("api.telegram.org")) {
        telegramCalls++;
        return new Response('{"ok":true}', { status: 200 });
      }
      if (!url.includes("api-gw.sports.naver.com")) {
        throw new Error("unexpected network call in qa gate: " + url);
      }
      if (upstreamMode.delayMs) await new Promise((r) => setTimeout(r, upstreamMode.delayMs));
      if (upstreamMode.failAll) {
        const err = new Error("stubbed total outage");
        err.name = "TimeoutError";
        throw err;
      }
      const m = /[?&]inning=(\d+)/.exec(url);
      const inning = m ? Number(m[1]) : 0;
      if (m && inning === 1) inning1Calls++;
      if (m && upstreamMode.failInnings.has(inning)) {
        return new Response("inning upstream down", { status: 500 });
      }
      return new Response(
        JSON.stringify({
          result: { textRelayData: { inn: upstreamMode.currentInning, textRelays: [] } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const tracker = await import("../../src/lib/monitoring/api-fallback-tracker");
    process.env.TELEGRAM_BOT_TOKEN ||= "stub-telegram-token";

    console.log("[5] single-flight: 동일 key 동시 요청 → 업스트림 1회");
    inning1Calls = 0;
    upstreamMode = { currentInning: 1, failInnings: new Set(), delayMs: 150 };
    const [c1, c2, c3] = await Promise.all([
      relayRoute.GET(new NextRequest("http://localhost/api/game-relay?gameId=20260811SFLT0")),
      relayRoute.GET(new NextRequest("http://localhost/api/game-relay?gameId=20260811SFLT0")),
      relayRoute.GET(new NextRequest("http://localhost/api/game-relay?gameId=20260811SFLT0&since=1")),
    ]);
    check("동시 3요청 모두 200", c1.status === 200 && c2.status === 200 && c3.status === 200,
      `${c1.status}/${c2.status}/${c3.status}`);
    check("업스트림 inning=1 fetch 정확히 1회", inning1Calls === 1, `${inning1Calls}회`);

    console.log("[6] 실패 후 재시도: 실패 promise 박제 없음");
    upstreamMode = { currentInning: 1, failInnings: new Set(), failAll: true };
    const f1 = await relayRoute.GET(
      new NextRequest("http://localhost/api/game-relay?gameId=20260811RTRY0"),
    );
    check("전면 실패 → 503", f1.status === 503, `got ${f1.status}`);
    upstreamMode = { currentInning: 1, failInnings: new Set() };
    const f2 = await relayRoute.GET(
      new NextRequest("http://localhost/api/game-relay?gameId=20260811RTRY0"),
    );
    check("복구 후 재요청 → 200(실패 고정 없음)", f2.status === 200, `got ${f2.status}`);

    console.log("[7] 복구 알림: degraded에서는 미발송, 완전 정상에서 1회만");
    // 사전: 이 인스턴스가 경보를 보낸 상태를 주입
    tracker._setPendingRecoveryForTest("naver-relay", true);
    telegramCalls = 0;
    // last-good 스냅샷 확보: currentInning=3 성공 GET (hint 0)
    upstreamMode = { currentInning: 3, failInnings: new Set() };
    // ⚠️ pending 상태에서 성공 GET이 바로 복구를 쇘버리면 degraded 검사를 못 하므로
    // 먼저 pending을 끄고 스냅샷만 채운다.
    tracker._setPendingRecoveryForTest("naver-relay", false);
    const warm = await relayRoute.GET(
      new NextRequest("http://localhost/api/game-relay?gameId=20260811RCVR0"),
    );
    check("스냅샷 사전 GET 200", warm.status === 200, `got ${warm.status}`);
    // degraded: inning 3 실패(500) + 스냅샷 존재 → last-good 대체 200. 핑 hint를 바꿔 fresh 경로 강제.
    tracker._setPendingRecoveryForTest("naver-relay", true);
    upstreamMode = { currentInning: 3, failInnings: new Set([3]) };
    const degraded = await relayRoute.GET(
      new NextRequest("http://localhost/api/game-relay?gameId=20260811RCVR0&inning=1"),
    );
    check("degraded 응답도 200(last-good 대체)", degraded.status === 200, `got ${degraded.status}`);
    check(
      "degraded 200에서는 복구 미발송(pending 유지)",
      tracker._hasPendingRecoveryForTest("naver-relay") === true && telegramCalls === 0,
      `pending=${tracker._hasPendingRecoveryForTest("naver-relay")}, telegram=${telegramCalls}회`,
    );
    // 완전 정상: 복구 1회 발송
    upstreamMode = { currentInning: 3, failInnings: new Set() };
    const clean1 = await relayRoute.GET(
      new NextRequest("http://localhost/api/game-relay?gameId=20260811RCVR0&inning=2"),
    );
    check("완전 정상 200", clean1.status === 200, `got ${clean1.status}`);
    check(
      "복구 알림 1회 발송 + pending 해제",
      tracker._hasPendingRecoveryForTest("naver-relay") === false && telegramCalls === 1,
      `pending=${tracker._hasPendingRecoveryForTest("naver-relay")}, telegram=${telegramCalls}회`,
    );
    // 재발송 금지: 또 성공해도 추가 발송 없음
    const clean2 = await relayRoute.GET(
      new NextRequest("http://localhost/api/game-relay?gameId=20260811RCVR0&inning=3"),
    );
    check(
      "중복 발송 없음(복구 1회 계약)",
      clean2.status === 200 && telegramCalls === 1,
      `status=${clean2.status}, telegram=${telegramCalls}회`,
    );
  } finally {
    globalThis.fetch = realFetch;
  }

  console.log(`\nrelay-gameid-guard: ${pass} PASS / ${fail} FAIL`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error("relay-gameid-guard crashed:", e);
  process.exit(1);
});
