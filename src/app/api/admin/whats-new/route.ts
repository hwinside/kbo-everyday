import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { isAdminRequest } from "@/lib/admin/pin";

const SAFE_CTA_PATH = /^\/[A-Za-z0-9/_?=&%#.-]*$/;

type AdminClient = ReturnType<typeof getSupabaseAdmin>;

interface AnnouncementRow {
  id: string;
  title: string;
  summary: string;
  is_active?: boolean | null;
  post_id?: number | null;
}

/**
 * 댓글용 브리지 포스트 보장.
 * 새소식이 활성(발행) 상태이고 아직 연결된 포스트가 없으면
 * board_type='announcement' + is_hidden=true 숨김 포스트를 만들어 연결한다.
 * 이 포스트는 통합 피드(team/player/free + is_hidden<>true)에 노출되지 않는다.
 * 결과로 row.post_id를 채워 응답에 반영한다. (실패해도 새소식 저장 자체는 유지)
 */
async function ensureBridgePost(supabase: AdminClient, row: AnnouncementRow): Promise<void> {
  if (!row.is_active || row.post_id) return;
  const systemUserId = process.env.SYSTEM_USER_ID;
  if (!systemUserId) return; // env 미설정 시 조용히 skip → 댓글만 비활성, 발행은 정상

  const { data: post, error: postErr } = await supabase
    .from("posts")
    .insert({
      author_id: systemUserId,
      board_type: "announcement",
      board_id: "announcement",
      content_type: "general",
      title: row.title,
      content: row.summary || row.title,
      is_hidden: true,
    })
    .select("id")
    .single();

  if (postErr || !post) return;

  const { error: linkErr } = await supabase
    .from("announcements")
    .update({ post_id: post.id })
    .eq("id", row.id);

  if (!linkErr) row.post_id = post.id as number;
}

export async function GET(req: NextRequest) {
  if (!isAdminRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("announcements")
    .select("*")
    .order("published_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  if (!isAdminRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { title, summary, body: content, cta_label, cta_path, display_until, target_platform } = body;

  if (!title || !summary || !content) {
    return NextResponse.json({ error: "title, summary, body are required" }, { status: 400 });
  }

  if (cta_path && !SAFE_CTA_PATH.test(cta_path)) {
    return NextResponse.json({ error: "cta_path must be a safe internal path" }, { status: 400 });
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("announcements")
    .insert({
      title,
      summary,
      body: content,
      cta_label: cta_label || null,
      cta_path: cta_path || null,
      display_until: display_until || null,
      target_platform: target_platform === "android_web" ? "android_web" : "all",
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  await ensureBridgePost(supabase, data as AnnouncementRow);
  revalidatePath("/api/whats-new");
  return NextResponse.json(data, { status: 201 });
}

export async function PUT(req: NextRequest) {
  if (!isAdminRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { id, ...updates } = body;

  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  if (updates.cta_path && !SAFE_CTA_PATH.test(updates.cta_path)) {
    return NextResponse.json({ error: "cta_path must be a safe internal path" }, { status: 400 });
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("announcements")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  await ensureBridgePost(supabase, data as AnnouncementRow); // 발행(활성화) 시 댓글 브리지 보장
  revalidatePath("/api/whats-new");
  return NextResponse.json(data);
}

export async function DELETE(req: NextRequest) {
  if (!isAdminRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await req.json();
  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("announcements").delete().eq("id", id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  revalidatePath("/api/whats-new");
  return NextResponse.json({ ok: true });
}
