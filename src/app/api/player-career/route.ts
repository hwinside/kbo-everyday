import { NextRequest, NextResponse } from "next/server";
import { getPlayerCareerResult, type PlayerCareerPayload } from "@/lib/services/player-career";

export type { PlayerCareerPayload };

/**
 * 선수 페이지 "통산" 뷰 데이터. KBO 공식 통산행 + 연도별 행 + 소속 이력을 정규화해 반환한다.
 *
 * 대상 선수 identity 는 서버 roster SSOT 로 정한다(클라 입력 미신뢰) — `id`(=KBO playerId)만
 * 받는다. 값이 없으면 `payload: null`(기록 없음), roster 로 못 정하면 404 — 지어내지 않는다.
 */
export async function GET(req: NextRequest) {
  const result = await getPlayerCareerResult(
    req.nextUrl.searchParams.get("id"),
    req.nextUrl.searchParams.get("pos") || "타자",
  );
  return NextResponse.json(result.body, {
    status: result.status,
    headers: result.headers,
  });
}
