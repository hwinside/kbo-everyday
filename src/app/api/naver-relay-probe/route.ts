import { NextRequest, NextResponse } from "next/server";

/**
 * 2026-08-11 임시 진단 라우트 — 네이버 relay 404 선별차단의 리전 의존성 실측용.
 * icn1(Node 함수) egress는 404, 타 리전/Edge egress는 200인지 확인한다.
 * 실측 종료 후 제거 예정. Edge runtime + preferredRegion 으로 icn1 밖에서 실행.
 */
export const runtime = "edge";
export const preferredRegion = ["hnd1", "sin1"];

const NAVER_API_BASE = "https://api-gw.sports.naver.com/schedule/games";

export async function GET(request: NextRequest) {
  const gameId =
    request.nextUrl.searchParams.get("gameId") ?? "20260811LGWO02026";
  const started = Date.now();
  try {
    const res = await fetch(`${NAVER_API_BASE}/${gameId}/relay?inning=1`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; KboEveryday/1.0)",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    const body = await res.text();
    return NextResponse.json({
      upstreamStatus: res.status,
      ms: Date.now() - started,
      bodyBytes: body.length,
      bodyHead: body.slice(0, 80),
    });
  } catch (e) {
    return NextResponse.json({
      upstreamStatus: null,
      ms: Date.now() - started,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
