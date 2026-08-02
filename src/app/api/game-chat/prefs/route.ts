import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { getVerifiedUserFromRequest } from "@/lib/auth/verified-user";
import { supabaseErrorResponse } from "@/lib/supabase/error";

export async function GET(req: NextRequest) {
  const verified = await getVerifiedUserFromRequest(req);
  if (!verified?.user.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await getSupabaseAdmin()
    .from("profiles")
    .select("game_chat_enabled")
    .eq("id", verified.user.id)
    .maybeSingle();
  if (error) return supabaseErrorResponse(error);
  if (!data) return NextResponse.json({ error: "profile not found" }, { status: 404 });

  return NextResponse.json({ visible: data.game_chat_enabled !== false });
}

export async function PUT(req: NextRequest) {
  const verified = await getVerifiedUserFromRequest(req);
  if (!verified?.user.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null) as { visible?: unknown } | null;
  if (typeof body?.visible !== "boolean") {
    return NextResponse.json({ error: "visible must be boolean" }, { status: 400 });
  }

  const { data, error } = await getSupabaseAdmin()
    .from("profiles")
    .update({ game_chat_enabled: body.visible })
    .eq("id", verified.user.id)
    .select("game_chat_enabled")
    .maybeSingle();
  if (error) return supabaseErrorResponse(error);
  if (!data) return NextResponse.json({ error: "profile not found" }, { status: 404 });

  return NextResponse.json({ success: true, visible: data.game_chat_enabled !== false });
}
