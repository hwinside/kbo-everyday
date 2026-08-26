import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { supabaseErrorResponse } from "@/lib/supabase/error";
import { isAdminAuthedRequest, requireAdmin } from "@/lib/admin/pin";

async function verifyPin(req: NextRequest): Promise<boolean> {
  return isAdminAuthedRequest(req);
}

export async function GET(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const type = req.nextUrl.searchParams.get("type");
  const status = req.nextUrl.searchParams.get("status");

  let query = supabase
    .from("feedback")
    .select("*")
    .order("created_at", { ascending: false });

  if (type) query = query.eq("type", type);
  if (status) query = query.eq("status", status);

  const { data, error } = await query;

  if (error) return supabaseErrorResponse(error);

  // Fetch user nicknames
  const userIds = [...new Set((data ?? []).map((d: { user_id: string }) => d.user_id))];
  const { data: profiles } = userIds.length > 0
    ? await supabase.from("profiles").select("id, nickname").in("id", userIds)
    : { data: [] };

  const nicknameMap = new Map(
    (profiles ?? []).map((p: { id: string; nickname: string }) => [p.id, p.nickname])
  );

  const enriched = (data ?? []).map((d: { user_id: string; [key: string]: unknown }) => ({
    ...d,
    user_nickname: nicknameMap.get(d.user_id) ?? null,
  }));

  return NextResponse.json({ data: enriched });
}

export async function PATCH(req: NextRequest) {
  if (!(await verifyPin(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { id, status, admin_note } = body as {
    id: number;
    status?: string;
    admin_note?: string;
  };

  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const updates: Record<string, string> = {};
  if (status !== undefined) updates.status = status;
  if (admin_note !== undefined) updates.admin_note = admin_note;

  const { data, error } = await supabase
    .from("feedback")
    .update(updates)
    .eq("id", id)
    .select()
    .single();

  if (error) return supabaseErrorResponse(error);

  return NextResponse.json({ data });
}
