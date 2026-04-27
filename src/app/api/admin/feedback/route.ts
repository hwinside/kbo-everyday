import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { supabaseErrorResponse } from "@/lib/supabase/error";
import { isAdminRequest } from "@/lib/admin/pin";

function verifyPin(req: NextRequest): boolean {
  return isAdminRequest(req);
}

export async function GET(req: NextRequest) {
  if (!verifyPin(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const type = req.nextUrl.searchParams.get("type");
  const status = req.nextUrl.searchParams.get("status");

  let query = supabase
    .from("feedback")
    .select("*, feedback_attachments(*)")
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

  // Generate signed URLs for attachments
  const enriched = await Promise.all(
    (data ?? []).map(async (d: { user_id: string; feedback_attachments?: Array<{ storage_path: string; id: string; file_type: string; mime_type: string; file_size: number; duration_sec: number | null; created_at: string }>; [key: string]: unknown }) => {
      let attachment = null;
      const attachments = d.feedback_attachments;

      if (attachments && attachments.length > 0) {
        const att = attachments[0];
        const { data: signedData } = await supabase.storage
          .from("feedback-videos")
          .createSignedUrl(att.storage_path, 3600); // 1 hour TTL

        attachment = {
          id: att.id,
          file_type: att.file_type,
          mime_type: att.mime_type,
          file_size: att.file_size,
          duration_sec: att.duration_sec,
          signed_url: signedData?.signedUrl ?? null,
          created_at: att.created_at,
        };
      }

      const { feedback_attachments: _, ...rest } = d;
      return {
        ...rest,
        user_nickname: nicknameMap.get(d.user_id) ?? null,
        attachment,
      };
    })
  );

  return NextResponse.json({ data: enriched });
}

export async function PATCH(req: NextRequest) {
  if (!verifyPin(req)) {
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
