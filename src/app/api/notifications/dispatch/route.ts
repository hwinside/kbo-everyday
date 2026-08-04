import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { sendFcmToUsers, type PushPayload } from "@/lib/notifications/fcm";
import type { PrefKey } from "@/lib/notifications/prefs";
import { NEWS_CLIPPER_IDS } from "@/lib/constants/news-clippers";
import { BASEBALL_GENIUS_USER_ID } from "@/lib/constants/baseball-genius";
import { URGENT_NOTICE_USER_ID } from "@/lib/constants/urgent-notice";
import { isNoReplySender, noReplyAutoReplyText } from "@/lib/constants/no-reply-senders";
import { fetchFavoritePlayerFanIds } from "@/lib/notifications/audience";

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
  platform?: "ios" | "android"; // 지정 시 해당 OS 토큰에만 발송 (긴급공지 = android 타겟)
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

/** 회신 불가 계정(클리퍼/긴급공지) 답장에 대한 자동응답 — 대화방당 24h 1회, 발신은 그 계정 (계정별 문구) */
async function sendNoReplyAutoReply(conversationId: string, accountId: string): Promise<void> {
  const text = noReplyAutoReplyText(accountId);
  // 계정별 dedup 타입 — 클리퍼 기존 동작 보존("clipper_auto_reply")
  const replyType = accountId === URGENT_NOTICE_USER_ID ? "urgent_notice_auto_reply" : "clipper_auto_reply";
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: recent } = await supabase
      .from("dm_messages")
      .select("id")
      .eq("conversation_id", conversationId)
      .eq("sender_id", accountId)
      .eq("payload->>type", replyType)
      .gte("created_at", since)
      .limit(1);
    if (recent && recent.length > 0) return;

    await supabase.from("dm_messages").insert({
      conversation_id: conversationId,
      sender_id: accountId,
      content: text,
      payload: { type: replyType },
    });
    await supabase
      .from("dm_conversations")
      .update({ last_message: text.slice(0, 100), last_message_at: new Date().toISOString() })
      .eq("id", conversationId);
  } catch (e) {
    console.error("[dispatch] no-reply auto-reply failed:", (e as Error).message);
  }
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

  // 야잘알봇 대화는 양방향 모두 push 대상이 아니다.
  // 유저 질문→봇뿐 아니라 봇 답변·picker→유저도 제외한다.
  if (receiver === BASEBALL_GENIUS_USER_ID || senderId === BASEBALL_GENIUS_USER_ID) return [];

  // 뉴스클리핑 쪽지 — 일반 쪽지 알림과 분리된 전용 문구 + 전용 prefKey (스펙 확정 문구).
  // payload는 클라 insert로도 채울 수 있으므로 클리퍼 계정 발신일 때만 신뢰 — 아니면 일반
  // 쪽지로 처리해 위조 payload가 클리핑 문구/prefKey를 타지 못하게 한다 (PR #619 리뷰 blocker 2).
  const clipping = record.payload as { type?: string; team_name?: string; overview?: string } | null;
  if (NEWS_CLIPPER_IDS.has(senderId)) {
    if (clipping?.type === "news_clipping") {
      return [{
        userIds: [receiver as string],
        payload: {
          title: `📰 오늘의 ${clipping.team_name || "내 팀"} 뉴스클리핑이 쪽지로 도착했습니다`,
          body: truncate(clipping.overview || "어제의 주요 뉴스를 확인해보세요"),
          url: `/messages/${conversationId}`,
        },
        prefKey: "news_clipping",
      }];
    }
    // 클리퍼의 클리핑 외 메시지(자동응답 등)는 푸시 없음 — 알림 루프 방지 (삼순 기준)
    return [];
  }

  // 긴급공지 발송 — 회신 불가 시스템 계정. 공지 쪽지만 📢 전용 푸시로 알린다.
  // ⚠️ 자동응답(urgent_notice_auto_reply)이 다시 이 분기를 타지 않도록 payload.type으로 게이트
  // (삼순 NO-GO #3: 자동응답 insert→webhook 재호출이 '📢 공지' 푸시를 또 만드는 루프 차단).
  // 대상은 android 토큰으로만 발송 (삼순 NO-GO #4: iOS 토큰 누출 차단).
  if (senderId === URGENT_NOTICE_USER_ID) {
    const noticePayload = record.payload as { type?: string } | null;
    if (noticePayload?.type !== "urgent_notice") {
      // 긴급공지 계정의 공지 외 메시지(자동응답 등)는 푸시 없음 — 알림 루프 방지
      return [];
    }
    return [{
      userIds: [receiver as string],
      payload: {
        title: "📢 크보팬 공지",
        body: content.trim() ? truncate(content) : "새로운 공지가 도착했습니다",
        url: `/messages/${conversationId}`,
      },
      prefKey: "dm",
      platform: "android",
    }];
  }

  // 유저 → 회신 불가 계정(클리퍼/긴급공지) 답장: 수신 불가 계정이라 푸시 대신 1회 자동응답만
  // (재답장 스팸 방지 24h 창). CS 릴레이는 운영팀 대화만 폴링하므로 CS 인입함에 안 들어간다.
  if (isNoReplySender(receiver as string)) {
    await sendNoReplyAutoReply(conversationId, receiver as string);
    return [];
  }

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
    const fans = await fetchFavoritePlayerFanIds(kboId);
    const targets = fans.filter((id) => !notified.has(id));
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
    const res = await sendFcmToUsers(d.userIds, d.payload, d.prefKey, d.platform);
    sent += res.sent;
  }
  return NextResponse.json({ ok: true, dispatches: dispatches.length, sent });
}
