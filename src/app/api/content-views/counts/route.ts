import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
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
 *
 * 콘텐츠 조회수 배치 조회 → { counts: { "<type>:<id>": n } }.
 * 집계값 자체는 민감정보가 아니고(게시글 조회수와 동일 판단) 표시 게이트는
 * 클라(ADMIN_EMAILS)가 담당한다. 미집계 콘텐츠는 0으로 응답.
 */
export async function POST(request: NextRequest) {
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
    const { data, error } = await supabase
      .from("content_views")
      .select("content_id, view_count")
      .eq("content_type", type)
      .in("content_id", ids);
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
