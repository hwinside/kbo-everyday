import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { NextRequest, NextResponse } from "next/server";
import { isAdminAuthedRequest } from "@/lib/admin/pin";
import { BASEBALL_GENIUS_USER_ID } from "@/lib/constants/baseball-genius";
import {
  mapQuestionJobsByMessageId,
  takeDetailPage,
} from "@/lib/admin/baseball-genius-monitor";

// 어드민 야잘알봇 대화 모니터링 — **읽기 전용** (알림·배지·읽음 처리·답장 없음).
// 운영팀 쪽지함(/api/admin/messages)과 같은 인증(isAdminAuthedRequest) +
// keyset pagination(admin_dm_inbox_page RPC, PR #784) 패턴을 재사용하되,
// 시스템 계정만 야잘알봇(BASEBALL_GENIUS_USER_ID)으로 바꾼다.

const INBOX_PAGE_SIZE = 50;
const DETAIL_MESSAGE_PAGE_SIZE = 200;

type InboxRow = {
  id: string;
  other_user_id: string | null;
  other_nickname: string;
  other_team_id: number | null;
  last_message: string | null;
  last_message_at: string;
  unread_count: number | string;
  user_msg_count: number | string;
  sys_msg_count: number | string;
  origin: string;
};

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

function parseDetailCursor(request: NextRequest) {
  const messageAt = request.nextUrl.searchParams.get("messageAt");
  const messageId = request.nextUrl.searchParams.get("messageId");
  if (!messageAt && !messageId) return { messageAt: null, messageId: null };
  if (!messageAt || !messageId) return null;
  if (!Number.isFinite(Date.parse(messageAt)) || !/^[1-9]\d*$/.test(messageId)) return null;
  return { messageAt: new Date(messageAt).toISOString(), messageId };
}

// GET: 야잘알봇 대화 목록 / 상세 (읽기 전용 — POST 없음)
export async function GET(request: NextRequest) {
  if (!(await isAdminAuthedRequest(request))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: "missing_config" }, { status: 500 });
  }

  const admin = getSupabaseAdmin();
  const conversationId = request.nextUrl.searchParams.get("conversationId");

  // 개별 대화 상세 (질문/답변 타임라인 + match_path 배지)
  if (conversationId) {
    const detailCursor = parseDetailCursor(request);
    if (!detailCursor) {
      return NextResponse.json({ error: "invalid_message_cursor" }, { status: 400 });
    }

    const { data: conv } = await admin
      .from("dm_conversations")
      .select("id, user1_id, user2_id")
      .eq("id", conversationId)
      .or(`user1_id.eq.${BASEBALL_GENIUS_USER_ID},user2_id.eq.${BASEBALL_GENIUS_USER_ID}`)
      .maybeSingle();

    if (!conv) {
      return NextResponse.json({ error: "not_found_or_unauthorized" }, { status: 403 });
    }

    const otherUserId =
      conv.user1_id === BASEBALL_GENIUS_USER_ID ? conv.user2_id : conv.user1_id;

    // query-guard: bounded -- created_at+id keyset으로 201건만 읽고 200건씩 전체 탐색한다.
    let messageQuery = admin
      .from("dm_messages")
      .select("id, conversation_id, sender_id, content, image_urls, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(DETAIL_MESSAGE_PAGE_SIZE + 1);
    if (detailCursor.messageAt && detailCursor.messageId) {
      messageQuery = messageQuery.or(
        `created_at.lt.${detailCursor.messageAt},and(created_at.eq.${detailCursor.messageAt},id.lt.${detailCursor.messageId})`,
      );
    }
    const { data: messageRows, error: messagesError } = await messageQuery;

    if (messagesError) {
      return NextResponse.json({ error: "fetch_messages_failed" }, { status: 500 });
    }

    const { page: descendingPage, nextCursor } = takeDetailPage(
      messageRows ?? [],
      DETAIL_MESSAGE_PAGE_SIZE,
    );
    const timeline = descendingPage.slice().reverse();

    // 상대 유저 닉네임 (탈퇴 시 null)
    const { data: profile } = otherUserId
      ? await admin
          .from("profiles")
          .select("id, nickname, team_id")
          .eq("id", otherUserId)
          .maybeSingle()
      : { data: null };

    // 질문 message_id PK로 처리 job을 exact join한다. 동일 문구 반복/지연에도 오매핑되지 않는다.
    const questionMessageIds = timeline
      .filter((message) => message.sender_id && message.sender_id !== BASEBALL_GENIUS_USER_ID)
      .map((message) => message.id);
    let jobs: {
      message_id: number;
      source: string | null;
      llm_input_tokens: number | null;
      llm_output_tokens: number | null;
    }[] = [];
    if (questionMessageIds.length > 0) {
      // query-guard: bounded -- 현재 상세 페이지의 message_id 최대 200개만 exact 조회.
      const { data: jobRows, error: jobsError } = await admin
        .from("genius_question_jobs")
        .select("message_id, source, llm_input_tokens, llm_output_tokens")
        .in("message_id", questionMessageIds);
      if (jobsError) {
        return NextResponse.json({ error: "fetch_question_jobs_failed" }, { status: 500 });
      }
      jobs = jobRows ?? [];
    }
    const jobByMessageId = mapQuestionJobsByMessageId(jobs);

    const enriched = timeline.map((msg) => {
      const job = jobByMessageId.get(String(msg.id)) ?? null;
      return {
        ...msg,
        is_genius: msg.sender_id === BASEBALL_GENIUS_USER_ID,
        sender_nickname:
          msg.sender_id === BASEBALL_GENIUS_USER_ID
            ? "야잘알봇"
            : msg.sender_id
              ? (profile?.nickname ?? "알 수 없음")
              : "탈퇴한 사용자",
        log: job?.source
          ? {
              match_path: job.source,
              input_tokens: job.llm_input_tokens,
              output_tokens: job.llm_output_tokens,
            }
          : null,
      };
    });

    return NextResponse.json({
      messages: enriched,
      other: {
        user_id: otherUserId,
        nickname: profile?.nickname ?? (otherUserId ? "알 수 없음" : "탈퇴한 사용자"),
        team_id: profile?.team_id ?? null,
      },
      nextCursor,
    });
  }

  // 대화 목록 (keyset pagination — 운영팀 쪽지함과 동일 RPC 재사용)
  const cursor = parseCursor(request);
  if (!cursor) {
    return NextResponse.json({ error: "invalid_cursor" }, { status: 400 });
  }

  try {
    // query-guard: bounded -- SQL RPC clamps p_limit to 101 rows.
    const { data, error } = await admin.rpc("admin_dm_inbox_page", {
      p_system_user_id: BASEBALL_GENIUS_USER_ID,
      p_cursor_at: cursor.cursorAt,
      p_cursor_id: cursor.cursorId,
      p_limit: INBOX_PAGE_SIZE + 1,
    });
    if (error || !data) throw new Error(error?.message ?? "missing inbox page");

    const rows = data as InboxRow[];
    const hasMore = rows.length > INBOX_PAGE_SIZE;
    const page = rows.slice(0, INBOX_PAGE_SIZE).map((row) => ({
      id: row.id,
      other_user_id: row.other_user_id,
      other_nickname: row.other_nickname,
      other_team_id: row.other_team_id,
      last_message: row.last_message,
      last_message_at: row.last_message_at,
      user_msg_count: Number(row.user_msg_count),
      sys_msg_count: Number(row.sys_msg_count),
    }));
    const tail = page.at(-1);

    return NextResponse.json({
      conversations: page,
      nextCursor: hasMore && tail
        ? { lastMessageAt: tail.last_message_at, conversationId: tail.id }
        : null,
    });
  } catch (error) {
    console.error("[admin/baseball-genius] inbox page failed:", error);
    return NextResponse.json({ error: "fetch_inbox_failed" }, { status: 500 });
  }
}
