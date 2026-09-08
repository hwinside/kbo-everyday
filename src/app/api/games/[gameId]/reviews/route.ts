import { NextRequest } from "next/server";
import { getVerifiedUserFromRequest } from "@/lib/auth/verified-user";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { normalizeForFloodKey } from "@/lib/utils/normalize-message";
import { COMMENT_LIMIT, validateText } from "@/lib/game-reviews/domain";
import { GAME_REVIEWS_ENABLED } from "@/lib/game-reviews/feature";
import { REVIEW_POLICY } from "@/lib/game-reviews/policy";
import { withAuthorAvatars } from "@/lib/game-reviews/author-avatars";
import { ReviewError, databaseError, fail, loadReviewContext, positiveId, reviewJson } from "@/lib/game-reviews/server";

type Params = { params: Promise<{ gameId: string }> };
export async function GET(req: NextRequest, { params }: Params) {
  if (!GAME_REVIEWS_ENABLED) return reviewJson({ error: "Not found" }, 404);
  try {
    const { gameId } = await params;
    const verified = await getVerifiedUserFromRequest(req);
    if (req.headers.has("authorization") && !verified) throw new ReviewError("다시 로그인해 주세요", 401);
    const context = await loadReviewContext(gameId);
    if (!context.final) return reviewJson({ context, feed: null, viewerId: verified?.user.id ?? null });
    const cursor = req.nextUrl.searchParams.get("before"), parent = req.nextUrl.searchParams.get("review");
    const filter = req.nextUrl.searchParams.get("team");
    const filterTeam = filter === null ? null : positiveId(filter);
    if (filterTeam !== null && ![context.awayTeamId, context.homeTeamId].includes(filterTeam)) throw new ReviewError("이 경기의 팀을 선택해 주세요");
    const { data, error } = await supabaseAdmin.rpc("gr_feed", { g: gameId, a: verified?.user.id ?? null,
      before_id: cursor === null ? null : positiveId(cursor), rid: parent === null ? null : positiveId(parent), filter_team: filterTeam,
      p_best_min_likes: REVIEW_POLICY.bestMinLikes });
    if (error) databaseError(error);
    const feed = await withAuthorAvatars(data);
    return reviewJson({ context, feed: { ...feed, policy: REVIEW_POLICY }, viewerId: verified?.user.id ?? null });
  } catch (error) { return fail(error); }
}
export async function POST(req: NextRequest, { params }: Params) {
  if (!GAME_REVIEWS_ENABLED) return reviewJson({ error: "Not found" }, 404);
  try {
    const verified = await getVerifiedUserFromRequest(req);
    if (!verified) throw new ReviewError("로그인이 필요해요", 401);
    const raw = await req.text();
    if (raw.length > 32_000) throw new ReviewError("입력값이 너무 길어요", 413);
    let input: Record<string, unknown>;
    try { input = JSON.parse(raw); } catch { throw new ReviewError("입력값을 확인해 주세요"); }
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new ReviewError("입력값을 확인해 주세요");
    const op = input.op;
    if (typeof op !== "string" || !["create", "edit", "delete", "like", "comment", "comment_edit", "comment_delete"].includes(op)) throw new ReviewError("지원하지 않는 요청이에요");
    const { gameId } = await params;
    const context = await loadReviewContext(gameId);
    if (!context.final) throw new ReviewError("종료가 확정된 경기에만 참여할 수 있어요", 409);
    let body: string | null = null;
    if (["create", "edit", "comment", "comment_edit"].includes(op)) {
      try { body = validateText(input.content, op.startsWith("comment") ? COMMENT_LIMIT : undefined); }
      catch (e) { throw new ReviewError((e as Error).message); }
    }
    let player: { key: string; name: string } | null = null;
    if ((op === "create" || op === "edit") && input.playerKey != null && input.playerKey !== "") {
      if (REVIEW_POLICY.nominationMode === "disabled") throw new ReviewError("현재 수훈선수 지정은 사용하지 않아요");
      player = context.players.find(p => p.key === input.playerKey) ?? null;
      if (!player) throw new ReviewError("승리팀 출전 선수 중에서 선택해 주세요");
    }
    if (op === "like" && typeof input.liked !== "boolean") throw new ReviewError("좋아요 상태를 확인해 주세요");
    const { data, error } = await supabaseAdmin.rpc("gr_mutate", {
      a: verified.user.id, g: gameId, op, rid: op === "create" ? null : positiveId(input.reviewId),
      cid: op === "comment_edit" || op === "comment_delete" ? positiveId(input.commentId) : null,
      body, body_key: body ? normalizeForFloodKey(body) : null, desired: op === "like" ? input.liked : null,
      away: context.awayTeamId, home: context.homeTeamId, winner: context.winnerTeamId,
      pkey: player?.key ?? null, pname: player?.name ?? null,
      p_allow_recreate: REVIEW_POLICY.allowRecreateAfterDelete, p_nomination_mode: REVIEW_POLICY.nominationMode,
    });
    if (error) databaseError(error);
    return reviewJson(data);
  } catch (error) { return fail(error); }
}
