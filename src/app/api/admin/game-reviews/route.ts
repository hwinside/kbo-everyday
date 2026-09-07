import { NextRequest } from "next/server";
import { isAdminAuthedRequest } from "@/lib/admin/pin";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { databaseError, fail, positiveId, ReviewError, reviewJson } from "@/lib/game-reviews/server";

export async function POST(req: NextRequest) {
  try {
    if (!(await isAdminAuthedRequest(req))) throw new ReviewError("Unauthorized", 401);
    const input = await req.json().catch(() => null);
    if (!input || !["game_review", "game_review_comment"].includes(input.targetType) || typeof input.hidden !== "boolean") throw new ReviewError("입력값을 확인해 주세요");
    const { error } = await supabaseAdmin.rpc("gr_moderate", { kind: input.targetType, target: positiveId(input.targetId), hidden: input.hidden });
    if (error) databaseError(error);
    return reviewJson({ ok: true });
  } catch (error) { return fail(error); }
}
