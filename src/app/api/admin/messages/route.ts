import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { NextRequest, NextResponse } from "next/server";
import { isAdminAuthedRequest } from "@/lib/admin/pin";

async function checkPin(request: NextRequest): Promise<boolean> {
  return isAdminAuthedRequest(request);
}

// PostgREST caps a single response at 1000 rows and rejects oversized `.in()`
// id lists. The 운영팀 계정 누적 대화가 3,000개를 넘어가면서 (1) 대화목록이 1,000개에서
// 잘리고 (2) 1,000개 id를 한 번에 넣은 카운트 쿼리가 Bad Request로 실패 → 카운트가 전부
// 0 → 수신함이 빈 채로 표시됐다. 아래 헬퍼들로 select는 페이지네이션, id 필터는 청크 분할한다.
const PAGE_SIZE = 1000;
const IN_CHUNK = 150;

type SupabaseAdmin = ReturnType<typeof getSupabaseAdmin>;

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

// 1,000행 상한을 넘겨 운영팀의 모든 대화를 가져온다.
async function fetchAllSystemConversations(admin: SupabaseAdmin, systemUserId: string) {
  const all: Record<string, unknown>[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await admin
      .from("dm_conversations")
      .select("*")
      .or(`user1_id.eq.${systemUserId},user2_id.eq.${systemUserId}`)
      .order("last_message_at", { ascending: false })
      .range(from, from + PAGE_SIZE - 1);
    if (error || !data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE_SIZE) break;
  }
  return all;
}

// conversation_id별 메시지 수를 id 청크 + 페이지네이션으로 집계한다.
// kind: "user"=운영팀 외 sender, "sys"=운영팀 sender, "unread"=운영팀 외 + 안읽음
async function countMessagesByConversation(
  admin: SupabaseAdmin,
  convIds: string[],
  systemUserId: string,
  kind: "user" | "sys" | "unread"
) {
  const map = new Map<string, number>();
  for (let i = 0; i < convIds.length; i += IN_CHUNK) {
    const slice = convIds.slice(i, i + IN_CHUNK);
    for (let from = 0; ; from += PAGE_SIZE) {
      let q = admin.from("dm_messages").select("conversation_id").in("conversation_id", slice);
      if (kind === "sys") {
        q = q.eq("sender_id", systemUserId);
      } else {
        q = q.neq("sender_id", systemUserId);
        if (kind === "unread") q = q.eq("is_read", false);
      }
      const { data, error } = await q.range(from, from + PAGE_SIZE - 1);
      if (error || !data || data.length === 0) break;
      (data as { conversation_id: string }[]).forEach((r) => {
        map.set(r.conversation_id, (map.get(r.conversation_id) ?? 0) + 1);
      });
      if (data.length < PAGE_SIZE) break;
    }
  }
  return map;
}

// 안읽은 메시지(운영팀 외 sender + is_read=false) 총합을 id 청크별 head 카운트로 가볍게 집계한다.
// 좌측 메뉴 배지용 — 대화별 분해 없이 합계만 필요하므로 row를 가져오지 않는다.
async function countUnreadTotal(admin: SupabaseAdmin, convIds: string[], systemUserId: string) {
  let total = 0;
  for (let i = 0; i < convIds.length; i += IN_CHUNK) {
    const slice = convIds.slice(i, i + IN_CHUNK);
    const { count } = await admin
      .from("dm_messages")
      .select("*", { count: "exact", head: true })
      .in("conversation_id", slice)
      .neq("sender_id", systemUserId)
      .eq("is_read", false);
    total += count ?? 0;
  }
  return total;
}

// 프로필을 id 청크로 나눠 batch fetch 한다.
async function fetchProfilesByIds(admin: SupabaseAdmin, ids: string[]) {
  const map = new Map<string, { id: string; nickname: string; team_id: number | null }>();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += IN_CHUNK) {
    const slice = unique.slice(i, i + IN_CHUNK);
    const { data } = await admin.from("profiles").select("id, nickname, team_id").in("id", slice);
    (data ?? []).forEach((p: { id: string; nickname: string; team_id: number | null }) => map.set(p.id, p));
  }
  return map;
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
    const convs = await fetchAllSystemConversations(admin, systemUserId);
    const convIds = convs.map((c) => c.id as string);
    const unreadTotal = convIds.length === 0 ? 0 : await countUnreadTotal(admin, convIds, systemUserId);
    return NextResponse.json({ unreadTotal });
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

  // 대화 목록 조회 (1,000행 상한을 넘겨 전체 페이지네이션)
  const convs = await fetchAllSystemConversations(admin, systemUserId);

  if (convs.length === 0) {
    return NextResponse.json({ conversations: [] });
  }

  const convIds = convs.map((c) => c.id as string);

  // 각 대화의 유저 메시지 수 (운영팀이 아닌 sender) — id 청크 분할 집계
  const userMsgCountMap = await countMessagesByConversation(admin, convIds, systemUserId, "user");

  // 각 대화의 운영팀 메시지 수
  const sysMsgCountMap = await countMessagesByConversation(admin, convIds, systemUserId, "sys");

  // unread counts (유저가 보낸 안읽음 메시지)
  const unreadMap = await countMessagesByConversation(admin, convIds, systemUserId, "unread");

  // 상대방 profiles batch fetch — id 청크 분할
  const otherIds = convs.map((c) =>
    c.user1_id === systemUserId ? (c.user2_id as string) : (c.user1_id as string)
  );
  const profileMap = await fetchProfilesByIds(admin, otherIds);

  const allMapped = convs.map((raw) => {
    const c = raw as {
      id: string;
      user1_id: string;
      user2_id: string;
      last_message: string | null;
      last_message_at: string;
    };
    const otherId = c.user1_id === systemUserId ? c.user2_id : c.user1_id;
    const prof = profileMap.get(otherId);
    return {
      id: c.id,
      other_user_id: otherId,
      other_nickname: prof?.nickname ?? "알 수 없음",
      other_team_id: prof?.team_id ?? null,
      last_message: c.last_message,
      last_message_at: c.last_message_at,
      unread_count: unreadMap.get(c.id) ?? 0,
      user_msg_count: userMsgCountMap.get(c.id) ?? 0,
      sys_msg_count: sysMsgCountMap.get(c.id) ?? 0,
    };
  });

  // 탭별 필터링
  let filtered = allMapped;
  if (tab === "inbox") {
    // 수신함: 유저가 보낸 메시지가 1개 이상인 대화만
    filtered = allMapped.filter((c: { user_msg_count: number }) => c.user_msg_count > 0);
  } else if (tab === "sent") {
    // 발송함: 운영팀 메시지가 있고, 자동 환영 메시지만 있는 대화는 제외
    // → 운영팀 메시지 있음 AND (유저 답장이 있거나 운영팀 메시지가 2개 이상 = 수동 발송이 있음)
    filtered = allMapped.filter((c: { sys_msg_count: number; user_msg_count: number }) =>
      c.sys_msg_count > 0 && (c.user_msg_count > 0 || c.sys_msg_count > 1)
    );
  }

  return NextResponse.json({ conversations: filtered });
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
    const { userId } = body as { userId?: string };
    const content = normalizeContent(body.content);
    const imageUrls = normalizeImageUrls(body.imageUrls);
    if (!userId || (!content.trim() && imageUrls.length === 0)) {
      return NextResponse.json({ error: "missing_params" }, { status: 400 });
    }
    const preview = lastMessagePreview(content, imageUrls);

    // 기존 conversation 찾기
    const [u1, u2] = [systemUserId, userId].sort();
    const { data: existingConv } = await admin
      .from("dm_conversations")
      .select("id")
      .eq("user1_id", u1)
      .eq("user2_id", u2)
      .maybeSingle();

    let conversationId: string;

    if (existingConv) {
      conversationId = existingConv.id;
    } else {
      const { data: newConv, error: convError } = await admin
        .from("dm_conversations")
        .insert({ user1_id: u1, user2_id: u2 })
        .select("id")
        .single();

      if (convError || !newConv) {
        return NextResponse.json({ error: "conv_create_failed" }, { status: 500 });
      }
      conversationId = newConv.id;
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
