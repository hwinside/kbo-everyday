import "server-only";
import { NextResponse } from "next/server";
import { getGameDetailRouteResult } from "@/lib/services/game-detail";
import { gameTeams, reviewContext } from "./context";

export async function loadReviewContext(gameId: string) {
  try { gameTeams(gameId); } catch { throw new ReviewError("올바른 경기 정보가 필요해요"); }
  const detail = await getGameDetailRouteResult({ gameId, seasonId: gameId.slice(0, 4) });
  if ("error" in detail) throw new ReviewError("경기 정보를 확인하지 못했어요. 다시 시도해 주세요", 503);
  return reviewContext(gameId, detail);
}
export class ReviewError extends Error { constructor(message: string, public status = 400) { super(message); } }
export function reviewJson(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "private, no-store", Vary: "Authorization" } });
}
const errors: Record<string, [string, number]> = {
  gr_auth: ["로그인이 필요해요", 401], gr_profile: ["프로필 설정을 완료해 주세요", 403],
  gr_team: ["한 줄 작성은 이 경기 두 팀 팬만 가능해요", 403],
  gr_player: ["수훈선수는 승리팀 팬만 지정할 수 있어요", 403],
  gr_exists: ["경기마다 한 줄만 남길 수 있어요. 삭제 후에도 다시 등록할 수 없어요", 409],
  gr_missing: ["삭제·숨김되었거나 볼 수 없는 글이에요", 404], gr_owner: ["본인 글만 변경할 수 있어요", 403],
  gr_edit_expired: ["수정 가능 시간이나 1회 수정을 모두 사용했어요", 409],
  gr_self: ["본인 글에는 좋아요·신고를 할 수 없어요", 403],
  gr_duplicate: ["이미 접수되었거나 방금 보낸 내용이에요", 409], gr_rate: ["잠시 후 다시 시도해 주세요", 429],
  gr_input: ["입력값을 확인해 주세요", 400],
};
export function databaseError(error: { message: string; code?: string }): never {
  const mapped = errors[error.message] ?? (error.code === "23505" ? errors.gr_exists : null);
  throw new ReviewError(mapped?.[0] ?? "요청을 처리하지 못했어요. 다시 시도해 주세요", mapped?.[1] ?? 503);
}
export function fail(error: unknown) {
  return reviewJson({ error: error instanceof ReviewError ? error.message : "요청을 처리하지 못했어요. 다시 시도해 주세요" }, error instanceof ReviewError ? error.status : 503);
}
export function positiveId(value: unknown): number {
  if ((typeof value !== "string" && typeof value !== "number") || !/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) throw new ReviewError("올바른 글 번호가 필요해요");
  return Number(value);
}
