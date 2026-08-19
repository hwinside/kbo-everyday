import { NextRequest, NextResponse } from "next/server";
import {
  getStatsRouteResult,
  handleStatsGetFailure,
  parseTable,
  type ParsedTableRow,
} from "@/lib/services/stats";

export { getStatsRouteResult, handleStatsGetFailure, parseTable };
export type { ParsedTableRow };

export async function GET(req: NextRequest) {
  const result = await getStatsRouteResult({
    type: req.nextUrl.searchParams.get("type"),
    season: req.nextUrl.searchParams.get("season"),
    full: req.nextUrl.searchParams.get("full") === "1",
  });
  return NextResponse.json(result.body, {
    status: result.status,
    headers: result.headers,
  });
}
