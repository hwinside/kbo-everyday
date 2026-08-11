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
 *
 * 실행: npm run qa:relay-gameid-guard  (network 불필요 — fetch는 스텁)
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
