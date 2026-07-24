import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { NextRequest, NextResponse } from "next/server";
import { isAdminAuthedRequest } from "@/lib/admin/pin";

async function checkPin(request: NextRequest): Promise<boolean> {
  return isAdminAuthedRequest(request);
}

const INBOX_PAGE_SIZE = 50;

type InboxRow = {
  id: string;
  other_user_id: string;
  other_nickname: string;
  other_team_id: number | null;
  last_message: string | null;
  last_message_at: string;
  unread_count: number | string;
  user_msg_count: number | string;
  sys_msg_count: number | string;
  origin: string;
};

function normalizeContent(content: unknown) {
  return typeof content === "string" ? content.replace(/\r\n/g, "\n").trimEnd() : "";
}

function normalizeImageUrls(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((url): url is string => typeof url === "string" && /^https?:\/\//.test(url))
    .slice(0, 3);
}

function lastMessagePreview(content: string, imageUrls: string[]) {
  const text = content.trim();
  if (text) return text.replace(/\s+/g, " ").substring(0, 100);
  return imageUrls.length > 0 ? "사진을 보냈습니다" : "";
}

function parseCursor(request: NextRequest) {
  const cursorAt = request.nextUrl.searchParams.get("cursorAt");
  const cursorId = request.nextUrl.searchParams.get("cursorId");
  if (!cursorAt && !cursorId) return { cursorAt: null, cursorId: null };
  if (!cursorAt || !cursorId) return null;
  if (!Number.isFinite(Date.parse(cursorAt))) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(cursorId)) {
    return null;
  }
  return { cursorAt: new Date(cursorAt).toISOString(), cursorId };
}

async function fetchUnreadTotal(admin: ReturnType<typeof getSupabaseAdmin>, systemUserId: string) {
  // query-guard: bounded -- scalar RPC always returns exactly one BIGINT.
  const { data, error } = await admin.rpc("admin_dm_unread_total", {
    p_system_user_id: systemUserId,
  });
  if (error || data === null) throw new Error(error?.message ?? "missing unread total");
  const total = Number(data);
  if (!Number.isSafeInteger(total) || total < 0) throw new Error("invalid unread total");
  return total;
}

// GET: 운영팀 계정의 대화 목록 + 메시지
export async function GET(request: NextRequest) {
  if (!(await checkPin(request))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const systemUserId = process.env.SYSTEM_USER_ID;
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !systemUserId) {
    return NextResponse.json({ error: "missing_config" }, { status: 500 });
  }

  const admin = getSupabaseAdmin();
  const conversationId = request.nextUrl.searchParams.get("conversationId");
  const tab = request.nextUrl.searchParams.get("tab") || "inbox";

  // 안읽은 쪽지 총 갯수 (어드민 좌측 메뉴 배지용)
  if (request.nextUrl.searchParams.get("count") === "unread") {
    try {
      return NextResponse.json({ unreadTotal: await fetchUnreadTotal(admin, systemUserId) });
    } catch (error) {
      console.error("[admin/messages] unread total failed:", error);
      return NextResponse.json({ error: "fetch_unread_total_failed" }, { status: 500 });
    }
  }

  // 발송 로그 조회 (발송함 탭)
  if (tab === "sent") {
    const [{ data: jobs, error }, { data: legacyLogs, error: legacyError }] = await Promise.all([
      admin
        .from("admin_delivery_jobs")
        .select("id, content, target_label, expected_count, selected_count, sent_count, failed_count, status, created_at")
        .eq("kind", "broadcast_dm")
        .order("created_at", { ascending: false })
        .limit(50),
      admin
        .from("admin_broadcast_logs")
        .select("id, content, target_label, total_count, success_count, fail_count, created_at")
        .order("created_at", { ascending: false })
        .limit(50),
    ]);

    if (error) {
      return NextResponse.json({ error: "fetch_broadcast_jobs_failed" }, { status: 500 });
    }
    if (legacyError) {
      console.warn("[admin/messages] legacy broadcast logs unavailable:", legacyError.message);
    }

    return NextResponse.json({
      broadcastLogs: [
        ...(jobs ?? []).map((job) => ({
          id: job.id,
          content: job.content,
          target_label: job.target_label,
          total_count: job.selected_count,
          expected_count: job.expected_count,
          selected_count: job.selected_count,
          success_count: job.sent_count,
          fail_count: job.failed_count,
          status: job.status,
          created_at: job.created_at,
        })),
        ...(legacyLogs ?? []).map((log) => ({
          ...log,
          id: `legacy-${log.id}`,
          expected_count: log.total_count,
          selected_count: log.total_count,
          status: log.fail_count > 0 ? "completed_with_failures" : "completed",
        })),
      ]
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, 50),
    });
  }

  // 개별 대화 메시지 조회
  if (conversationId) {
    // 운영팀 대화인지 검증
    const { data: conv } = await admin
      .from("dm_conversations")
      .select("id, user1_id, user2_id")
      .eq("id", conversationId)
      .or(`user1_id.eq.${systemUserId},user2_id.eq.${systemUserId}`)
      .maybeSingle();

    if (!conv) {
      return NextResponse.json({ error: "not_found_or_unauthorized" }, { status: 403 });
    }

    const { error: markReadError } = await admin
      .from("dm_messages")
      .update({ is_read: true })
      .eq("conversation_id", conversationId)
      .neq("sender_id", systemUserId)
      .eq("is_read", false);

    if (markReadError) {
      console.warn("[admin/messages] mark read failed:", markReadError.message);
    }

    const { data: messages } = await admin
      .from("dm_messages")
      .select("*")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true })
      .limit(200);

    // sender profiles batch fetch
    const senderIds = [...new Set((messages ?? []).map((m: { sender_id: string }) => m.sender_id))];
    const { data: profiles } = await admin
      .from("profiles")
      .select("id, nickname, team_id")
      .in("id", senderIds);

    const profileMap = new Map(
      (profiles ?? []).map((p: { id: string; nickname: string; team_id: number | null }) => [p.id, p])
    );

    const enriched = (messages ?? []).map((m: { sender_id: string; [key: string]: unknown }) => ({
      ...m,
      sender_nickname: profileMap.get(m.sender_id)?.nickname ?? "알 수 없음",
      is_system: m.sender_id === systemUserId,
    }));

    return NextResponse.json({ messages: enriched });
  }

  const cursor = parseCursor(request);
  if (!cursor) {
    return NextResponse.json({ error: "invalid_cursor" }, { status: 400 });
  }

  try {
    // 수신 자격(유저 발신 1건+)을 SQL 내부에서 먼저 적용한 뒤 50건을 자른다.
    // unreadTotal은 페이지와 독립적인 전역 집계이며, 둘 중 하나라도 실패하면 0으로 숨기지 않는다.
    const [{ data, error }, unreadTotal] = await Promise.all([
      // query-guard: bounded -- SQL RPC clamps p_limit to 101 rows.
      admin.rpc("admin_dm_inbox_page", {
        p_system_user_id: systemUserId,
        p_cursor_at: cursor.cursorAt,
        p_cursor_id: cursor.cursorId,
        p_limit: INBOX_PAGE_SIZE + 1,
      }),
      fetchUnreadTotal(admin, systemUserId),
    ]);
    if (error || !data) throw new Error(error?.message ?? "missing inbox page");

    const rows = data as InboxRow[];
    const hasMore = rows.length > INBOX_PAGE_SIZE;
    const page = rows.slice(0, INBOX_PAGE_SIZE).map((row) => ({
      ...row,
      unread_count: Number(row.unread_count),
      user_msg_count: Number(row.user_msg_count),
      sys_msg_count: Number(row.sys_msg_count),
    }));
    const tail = page.at(-1);

    return NextResponse.json({
      conversations: page,
      unreadTotal,
      nextCursor: hasMore && tail
        ? { lastMessageAt: tail.last_message_at, conversationId: tail.id }
        : null,
    });
  } catch (error) {
    console.error("[admin/messages] inbox page failed:", error);
    return NextResponse.json({ error: "fetch_inbox_failed" }, { status: 500 });
  }
}

// POST: 운영팀 계정으로 답장 또는 전체발송
export async function POST(request: NextRequest) {
  if (!(await checkPin(request))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const systemUserId = process.env.SYSTEM_USER_ID;
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !systemUserId) {
    return NextResponse.json({ error: "missing_config" }, { status: 500 });
  }

  const body = await request.json();
  const admin = getSupabaseAdmin();

  // 개별 유저에게 쪽지 발송
  if (body.action === "send_to_user") {
    const { userId, source } = body as { userId?: string; source?: string };
    // 건의함(피드백) 페이지에서의 쪽지 회신은 source='feedback' 으로 대화를 마킹해
    // 유저 발신이 없어도 운영팀 수신함(admin_dm_inbox_page)에 노출되게 한다.
    const isFeedback = source === "feedback";
    const content = normalizeContent(body.content);
    const imageUrls = normalizeImageUrls(body.imageUrls);
    if (!userId || (!content.trim() && imageUrls.length === 0)) {
      return NextResponse.json({ error: "missing_params" }, { status: 400 });
    }
    const preview = lastMessagePreview(content, imageUrls);

    // 대화 upsert + 메시지 INSERT + preview/origin 확정을 service_role 전용 RPC 한
    // 트랜잭션으로 묶는다. 실패 시 전부 rollback → 빈/숨은 대화 미발생.
    // query-guard: bounded -- admin_send_ops_message 는 항상 정확히 1행(conversation_id) 반환.
    const { data: sendData, error: sendError } = await admin.rpc("admin_send_ops_message", {
      p_system_user_id: systemUserId,
      p_user_id: userId,
      p_content: content,
      p_image_urls: imageUrls,
      p_preview: preview,
      p_origin: isFeedback ? "feedback" : "dm",
    });

    if (sendError) {
      return NextResponse.json({ error: "send_failed" }, { status: 500 });
    }

    const sendRow = Array.isArray(sendData) ? sendData[0] : sendData;
    const conversationId = sendRow?.conversation_id as string | undefined;
    if (!conversationId) {
      return NextResponse.json({ error: "send_failed" }, { status: 500 });
    }

    return NextResponse.json({ ok: true, conversationId });
  }

  // 전체발송
  if (body.action === "broadcast") {
    const { content, teamIds } = body as { content?: string; teamIds?: number[] };
    if (!content?.trim()) {
      return NextResponse.json({ error: "missing_content" }, { status: 400 });
    }
    if (
      teamIds !== undefined &&
      (!Array.isArray(teamIds) ||
        teamIds.some((id) => !Number.isInteger(id) || id < 1 || id > 10) ||
        new Set(teamIds).size !== teamIds.length)
    ) {
      return NextResponse.json({ error: "invalid_team_ids" }, { status: 400 });
    }

    const targetLabel = (!teamIds || teamIds.length === 0 || teamIds.length >= 10)
      ? "전체"
      : teamIds.map((id: number) => {
          const names: Record<number, string> = {1:"LG",2:"두산",3:"KT",4:"SSG",5:"NC",6:"KIA",7:"롯데",8:"삼성",9:"한화",10:"키움"};
          return names[id] ?? `팀${id}`;
        }).join(", ");

    const { data: created, error: createError } = await admin.rpc("create_admin_broadcast_job", {
      p_sender_id: systemUserId,
      p_content: content.trim(),
      p_target_label: targetLabel,
      p_team_ids: teamIds && teamIds.length > 0 ? teamIds : null,
    });
    const job = Array.isArray(created) ? created[0] : created;
    if (createError || !job) {
      console.error("[admin/messages] create broadcast job failed:", createError?.message);
      return NextResponse.json({ error: "create_broadcast_job_failed" }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      result: {
        jobId: job.job_id,
        expected: job.expected_count,
        selected: job.selected_count,
        total: job.selected_count,
        success: 0,
        fail: 0,
        status: job.selected_count === 0 ? "completed" : "queued",
      },
    });
  }

  // 기존 답장 로직
  const { conversationId } = body;
  const content = normalizeContent(body.content);
  const imageUrls = normalizeImageUrls(body.imageUrls);
  if (!conversationId || (!content.trim() && imageUrls.length === 0)) {
    return NextResponse.json({ error: "missing_params" }, { status: 400 });
  }
  const preview = lastMessagePreview(content, imageUrls);

  // 운영팀 대화인지 검증
  const { data: conv } = await admin
    .from("dm_conversations")
    .select("id")
    .eq("id", conversationId)
    .or(`user1_id.eq.${systemUserId},user2_id.eq.${systemUserId}`)
    .maybeSingle();

  if (!conv) {
    return NextResponse.json({ error: "not_found_or_unauthorized" }, { status: 403 });
  }

  const { error: msgError } = await admin
    .from("dm_messages")
    .insert({
      conversation_id: conversationId,
      sender_id: systemUserId,
      content,
      image_urls: imageUrls,
    });

  if (msgError) {
    return NextResponse.json({ error: "send_failed" }, { status: 500 });
  }

  await admin
    .from("dm_conversations")
    .update({
      last_message: preview,
      last_message_at: new Date().toISOString(),
    })
    .eq("id", conversationId);

  return NextResponse.json({ ok: true });
}
