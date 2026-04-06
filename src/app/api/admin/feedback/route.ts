import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseErrorResponse } from "@/lib/supabase/error";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

function verifyPin(req: NextRequest): boolean {
  const pin = req.headers.get("x-admin-pin");
  return pin === process.env.ADMIN_PIN;
}

export async function GET(req: NextRequest) {
  if (!verifyPin(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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

  return NextResponse.json({ data });
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
