import { NextRequest, NextResponse } from "next/server";

/**
 * 네이버 relay/record 전용 edge 프록시.
 *
 * WHY (2026-08-11 P0): 네이버가 relay 엔드포인트(`…/games/{id}/relay`)만
 * Vercel icn1(AWS 서울) egress 대역에 404로 선별 차단했다. 실측:
 * - icn1 Node 함수 → 404 (브라우저 UA+Referer로도 동일 → 헤더 무관, IP 차단)
 * - hnd1 edge 함수 → 200 (x-vercel-id: icn1::hnd1 실측)
 * - 같은 icn1에서 schedule API는 200 → relay 경로만 차단
 * Node 서버리스는 Pro 플랜에서 단일 리전(icn1) 고정이라(preferredRegion 미적용
 * 실측) edge 런타임으로 hnd1/sin1에서 우회한다.
 *
 * 보안: 공개 데이터(네이버 문자중계) 한정. gameId 포맷·kind 허용목록으로
 * 임의 URL 프록시(SSRF)를 차단한다.
 */
export const runtime = "edge";
export const preferredRegion = ["hnd1", "sin1"];

const NAVER_API_BASE = "https://api-gw.sports.naver.com/schedule/games";

// 네이버 gameId: YYYYMMDD + 팀코드/시리즈 영숫자 (예: 20260811LGWO02026)
const GAME_ID_RE = /^[0-9]{8}[A-Z0-9]{4,16}$/;

export async function GET(request: NextRequest) {
  const gameId = request.nextUrl.searchParams.get("gameId") ?? "";
  const kind = request.nextUrl.searchParams.get("kind") ?? "relay";
  const inningRaw = request.nextUrl.searchParams.get("inning") ?? "1";
  const inning = Number.parseInt(inningRaw, 10);

  if (!GAME_ID_RE.test(gameId)) {
    return NextResponse.json({ error: "invalid gameId" }, { status: 400 });
  }
  if (kind !== "relay" && kind !== "record") {
    return NextResponse.json({ error: "invalid kind" }, { status: 400 });
  }
  if (kind === "relay" && (!Number.isInteger(inning) || inning < 1 || inning > 20)) {
    return NextResponse.json({ error: "invalid inning" }, { status: 400 });
  }

  const upstreamUrl =
    kind === "relay"
      ? `${NAVER_API_BASE}/${gameId}/relay?inning=${inning}`
      : `${NAVER_API_BASE}/${gameId}/record`;

  try {
    const res = await fetch(upstreamUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; KboEveryday/1.0)",
      },
      cache: "no-store",
      // 호출측(game-relay Node 함수)의 10s 바운드보다 짧게 끊어
      // 프록시가 타임아웃 원인을 추가하지 않게 한다.
      signal: AbortSignal.timeout(8000),
    });
    const body = await res.text();
    return new NextResponse(body, {
      status: res.status,
      headers: {
        "content-type": res.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    return NextResponse.json(
      {
        error: "naver_proxy_upstream_failure",
        detail: e instanceof Error ? e.message : String(e),
      },
      { status: 504 },
    );
  }
}
