import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { sendFcmToUsers, type PushPayload } from "@/lib/notifications/fcm";
import type { PrefKey } from "@/lib/notifications/prefs";

// 푸시 알림 디스패처 (push-notifications-v1 S3).
// DB 트리거(pg_net)가 INSERT 이벤트를 POST — 대상 결정 → prefs 필터 → FCM 발송.
// 인증: x-webhook-secret 헤더 (NOTIFICATIONS_WEBHOOK_SECRET env = DB GUC와 동일 값)

interface WebhookBody {
  table: string;
  record: Record<string, unknown>;
}

interface Dispatch {
  userIds: string[];
  payload: PushPayload;
  prefKey: PrefKey;
}

async function nickname(userId: string): Promise<string> {
  const { data } = await supabase.from("profiles").select("nickname").eq("id", userId).maybeSingle();
  return (data?.nickname as string) || "누군가";
}

function truncate(s: string, n = 60): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/** 댓글/답글 — 글 작성자(댓글) + 부모 댓글 작성자(답글), 본인 제외 */
async function handleComment(record: Record<string, unknown>): Promise<Dispatch[]> {
  const postId = record.post_id as number;
  const authorId = record.author_id as string;
  const parentId = record.parent_id as number | null;
  const content = (record.content as string) || "";
  if (!postId || !authorId) return [];

  const writer = await nickname(authorId);
  const url = `/community/free/${postId}`;
  const out: Dispatch[] = [];

  // 부모 댓글 작성자 → "답글"
  let parentAuthor: string | null = null;
  if (parentId) {
    const { data: parent } = await supabase.from("comments").select("author_id").eq("id", parentId).maybeSingle();
    parentAuthor = (parent?.author_id as string) ?? null;
    if (parentAuthor && parentAuthor !== authorId) {
      out.push({
        userIds: [parentAuthor],
        payload: { title: `💬 ${writer}님의 답글`, body: truncate(content), url },
        prefKey: "comment_reply",
      });
    }
  }

  // 글 작성자 → "댓글" (부모 댓글 작성자와 중복이면 답글 알림만)
  const { data: post } = await supabase.from("posts").select("author_id").eq("id", postId).maybeSingle();
  const postAuthor = (post?.author_id as string) ?? null;
  if (postAuthor && postAuthor !== authorId && postAuthor !== parentAuthor) {
    out.push({
      userIds: [postAuthor],
      payload: { title: `💬 ${writer}님이 댓글을 남겼어요`, body: truncate(content), url },
      prefKey: "comment_reply",
    });
  }
  return out;
}

/** 쪽지 — 대화 상대(수신자). 운영팀 공지 포함(스펙 확정) */
async function handleDm(record: Record<string, unknown>): Promise<Dispatch[]> {
  const conversationId = record.conversation_id as string;
  const senderId = record.sender_id as string;
  const content = (record.content as string) || "";
  const imageUrls = (record.image_urls as string[] | null) ?? [];
  if (!conversationId || !senderId) return [];

  const { data: conv } = await supabase
    .from("dm_conversations")
    .select("user1_id, user2_id")
    .eq("id", conversationId)
    .maybeSingle();
  if (!conv) return [];

  const receiver = conv.user1_id === senderId ? conv.user2_id : conv.user1_id;
  if (!receiver || receiver === senderId) return [];

  const sender = await nickname(senderId);
  return [{
    userIds: [receiver as string],
    payload: {
      title: `✉️ ${sender}님의 쪽지`,
      body: content.trim() ? truncate(content) : imageUrls.length > 0 ? "사진을 보냈습니다" : "",
      url: `/messages/${conversationId}`,
    },
    prefKey: "dm",
  }];
}

/** 최애선수 관련 글 — player_tags("kboId:이름")에 매칭되는 최애선수 보유 유저 */
async function handlePost(record: Record<string, unknown>): Promise<Dispatch[]> {
  if (record.is_hidden === true) return []; // 브리지 포스트(새소식 등) 제외
  const postId = record.id as number;
  const authorId = record.author_id as string;
  const tags = (record.player_tags as string[] | null) ?? [];
  if (!postId || tags.length === 0) return [];

  const out: Dispatch[] = [];
  const notified = new Set<string>([authorId]); // 본인 제외 + 다중 태그 중복 발송 방지
  for (const tag of tags.slice(0, 5)) {
    const [kboId, playerName] = tag.split(":");
    if (!kboId) continue;
    // favorite_players: [{playerId: "53123", ...}]
    const { data: fans, error } = await supabase
      .from("profiles")
      .select("id")
      .contains("favorite_players", JSON.stringify([{ playerId: kboId }]));
    if (error) {
      console.error("[dispatch] fans query failed:", error.message);
      continue;
    }
    const targets = (fans ?? []).map((f: { id: string }) => f.id).filter((id) => !notified.has(id));
    targets.forEach((id) => notified.add(id));
    if (targets.length === 0) continue;
    out.push({
      userIds: targets,
      payload: {
        title: `⭐ ${playerName || "최애선수"} 관련 글이 올라왔어요`,
        body: truncate((record.content as string) || (record.title as string) || ""),
        url: `/community/free/${postId}`,
      },
      prefKey: "fav_player_post",
    });
  }
  return out;
}

export async function POST(req: NextRequest) {
  const secret = process.env.NOTIFICATIONS_WEBHOOK_SECRET;
  if (!secret || req.headers.get("x-webhook-secret") !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: WebhookBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  if (!body?.table || !body?.record) {
    return NextResponse.json({ error: "table and record required" }, { status: 400 });
  }

  let dispatches: Dispatch[] = [];
  try {
    if (body.table === "comments") dispatches = await handleComment(body.record);
    else if (body.table === "dm_messages") dispatches = await handleDm(body.record);
    else if (body.table === "posts") dispatches = await handlePost(body.record);
    else return NextResponse.json({ ok: true, ignored: body.table });
  } catch (e) {
    console.error("[dispatch] handler failed:", (e as Error).message);
    return NextResponse.json({ error: "handler failed" }, { status: 500 });
  }

  let sent = 0;
  for (const d of dispatches) {
    const res = await sendFcmToUsers(d.userIds, d.payload, d.prefKey);
    sent += res.sent;
  }
  return NextResponse.json({ ok: true, dispatches: dispatches.length, sent });
}
