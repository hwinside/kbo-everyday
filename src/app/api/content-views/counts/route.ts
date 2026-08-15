import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { getVerifiedUserFromRequest } from "@/lib/auth/verified-user";
import { isAdminEmail } from "@/lib/admin/admin-users";
import {
  contentViewKey,
  isContentViewType,
  isValidContentId,
  type ContentViewType,
} from "@/lib/content-views/policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_ITEMS = 40;

/**
 * POST /api/content-views/counts  { items: [{ type, id }] }  (최대 40건)
 * Authorization: Bearer <supabase access token> — 관리자(ADMIN_EMAILS) 전용.
 *
 * 조회수 노출은 관리자 전용 기능이므로 서버에서 인가한다(삼순 blocker2 —
 * 클라 AdminOnly 는 표시 최적화일 뿐 인가가 아니다). 비로그인 401, 비관리자 403.
 * 응답: { counts: { "<type>:<id>": n } } — 미집계 콘텐츠는 0.
 */
export async function POST(request: NextRequest) {
  const verified = await getVerifiedUserFromRequest(request);
  if (!verified) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!isAdminEmail(verified.user.email)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let items: unknown;
  try {
    items = (await request.json())?.items;
  } catch {
    items = undefined;
  }
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ITEMS) {
    return NextResponse.json({ error: `items must be 1..${MAX_ITEMS}` }, { status: 400 });
  }

  const valid: { type: ContentViewType; id: string }[] = [];
  for (const raw of items) {
    const type = (raw as { type?: unknown })?.type;
    const id = (raw as { id?: unknown })?.id;
    if (isContentViewType(type) && isValidContentId(id)) valid.push({ type, id });
  }
  if (valid.length === 0) {
    return NextResponse.json({ counts: {} });
  }

  const supabase = getSupabaseAdmin();
  const counts: Record<string, number> = {};
  for (const item of valid) counts[contentViewKey(item.type, item.id)] = 0;

  // 복합키라 type별로 나눠 조회 (최대 2쿼리).
  const types = [...new Set(valid.map((item) => item.type))];
  for (const type of types) {
    const ids = valid.filter((item) => item.type === type).map((item) => item.id);
    // query-guard: bounded -- ids는 요청당 최대 MAX_ITEMS(40)개, PK(content_type, content_id) 일치 조회
    const { data, error } = await supabase
      .from("content_views")
      .select("content_id, view_count")
      .eq("content_type", type)
      .in("content_id", ids)
      .limit(MAX_ITEMS);
    if (error) {
      console.error("[content-view] counts query failed", { type, error: error.message });
      continue; // 해당 type만 0 유지 — best-effort
    }
    for (const row of data ?? []) {
      counts[contentViewKey(type, row.content_id)] = Number(row.view_count) || 0;
    }
  }

  return NextResponse.json({ counts });
}
