import { NextRequest, NextResponse } from "next/server";
import { getPlayerCareerResult, type PlayerCareerPayload } from "@/lib/services/player-career";

export type { PlayerCareerPayload };

/**
 * 선수 페이지 "통산" 뷰 데이터. KBO 공식 통산행 + 연도별 행 + 소속 이력을 정규화해 반환한다.
 * 값이 없으면 `payload: null`(기록 없음) — 지어내지 않는다.
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
