import { withCloudflarePublicCache } from "@/lib/http/cloudflare-cache";
import { NextRequest, NextResponse } from "next/server";
import {
  applyRunnerStats,
  assertFullEntryIdentity,
  assertNoRowLoss,
  assertStatsComplete,
  buildBatterStat,
  buildRunnerMap,
  canonicalizeDefenseRows,
  canonicalizeStatsIdentity,
  collapseIdenticalStatRows,
  fetchAllRunnerRows,
  getStatsRouteResult,
  handleStatsGetFailure,
  mergeBasicRows,
  parseTable,
  renumberRanks,
  rowKboId,
  type Basic2Entry,
  type ParsedTableRow,
} from "@/lib/services/stats";

// ⚠️ main 에서 route 가 내보내던 helper 전수를 그대로 재-export 한다.
//   구현은 service 로 이동했지만 기존 게이트(stats-kboid-identity-smoke 등)가 route 경로로
//   이 helper 들을 import 한다 — 문면이 아니라 실제 소비처 계약이라 빠뜨리면 하류가 죽는다.
export {
  applyRunnerStats,
  assertFullEntryIdentity,
  assertNoRowLoss,
  assertStatsComplete,
  buildBatterStat,
  buildRunnerMap,
  canonicalizeDefenseRows,
  canonicalizeStatsIdentity,
  collapseIdenticalStatRows,
  fetchAllRunnerRows,
  getStatsRouteResult,
  handleStatsGetFailure,
  mergeBasicRows,
  parseTable,
  renumberRanks,
  rowKboId,
};
export type { Basic2Entry, ParsedTableRow };

export async function GET(req: NextRequest) {
  const result = await getStatsRouteResult({
    type: req.nextUrl.searchParams.get("type"),
    season: req.nextUrl.searchParams.get("season"),
    full: req.nextUrl.searchParams.get("full") === "1",
  });
  return withCloudflarePublicCache(req, NextResponse.json(result.body, {
    status: result.status,
    headers: result.headers,
  }));
}
