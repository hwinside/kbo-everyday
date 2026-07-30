import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { NextRequest, NextResponse } from "next/server";
import { isAdminAuthedRequest } from "@/lib/admin/pin";
import { BASEBALL_GENIUS_USER_ID } from "@/lib/constants/baseball-genius";

// 어드민 야잘알봇 대화 모니터링 — **읽기 전용** (알림·배지·읽음 처리·답장 없음).
// 운영팀 쪽지함(/api/admin/messages)과 같은 인증(isAdminAuthedRequest) +
// keyset pagination(admin_dm_inbox_page RPC, PR #784) 패턴을 재사용하되,
// 시스템 계정만 야잘알봇(BASEBALL_GENIUS_USER_ID)으로 바꾼다.

const INBOX_PAGE_SIZE = 50;
const DETAIL_MESSAGE_LIMIT = 200;
const DETAIL_LOG_LIMIT = 300;
/** 질문 메시지 ↔ 로그 매칭 허용 시차 (봇 처리 지연 감안, ms) */
const LOG_MATCH_WINDOW_MS = 10 * 60 * 1000;

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

type GeniusLog = {
  id: string;
  question: string;
  match_path: string;
  input_tokens: number | null;
  output_tokens: number | null;
  created_at: string;
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

/**
 * 유저 질문 메시지에 genius_question_logs 의 match_path(dictionary|cache|llm|...)를
 * 붙인다. 로그에는 message_id 가 없으므로 질문 원문 일치 + 시각 근접(10분 창)으로
 * 순서대로 1:1 매칭한다 (모니터링 배지 용도 — 근사 매칭으로 충분).
 */
function matchLogsToMessages(
  messages: { id: number; sender_id: string | null; content: string; created_at: string }[],
  logs: GeniusLog[],
) {
  const consumed = new Set<string>();
  const byMessageId = new Map<number, GeniusLog>();
  for (const msg of messages) {
    if (msg.sender_id === BASEBALL_GENIUS_USER_ID || msg.sender_id === null) continue;
    const msgAt = Date.parse(msg.created_at);
    const question = (msg.content ?? "").trim();
    if (!question) continue;
    let best: GeniusLog | null = null;
    let bestGap = Number.POSITIVE_INFINITY;
    for (const log of logs) {
      if (consumed.has(log.id)) continue;
      if (log.question.trim() !== question) continue;
      const gap = Math.abs(Date.parse(log.created_at) - msgAt);
      if (gap <= LOG_MATCH_WINDOW_MS && gap < bestGap) {
        best = log;
        bestGap = gap;
      }
    }
    if (best) {
      consumed.add(best.id);
      byMessageId.set(msg.id, best);
    }
  }
  return byMessageId;
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

    // query-guard: bounded -- 단일 대화의 최근 메시지 200건으로 고정 제한.
    const { data: messages, error: messagesError } = await admin
      .from("dm_messages")
      .select("id, conversation_id, sender_id, content, image_urls, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(DETAIL_MESSAGE_LIMIT);

    if (messagesError) {
      return NextResponse.json({ error: "fetch_messages_failed" }, { status: 500 });
    }

    const timeline = (messages ?? []).slice().reverse();

    // 상대 유저 닉네임 (탈퇴 시 null)
    const { data: profile } = otherUserId
      ? await admin
          .from("profiles")
          .select("id, nickname, team_id")
          .eq("id", otherUserId)
          .maybeSingle()
      : { data: null };

    // 응답 경로/비용 관측용 로그 — 이 유저의 최근 로그만 bounded 로 가져와 근사 매칭.
    let logs: GeniusLog[] = [];
    if (otherUserId && timeline.length > 0) {
      // query-guard: bounded -- 유저 1명의 최근 질문 로그 300건으로 고정 제한.
      const { data: logRows } = await admin
        .from("genius_question_logs")
        .select("id, question, match_path, input_tokens, output_tokens, created_at")
        .eq("user_id", otherUserId)
        .gte("created_at", timeline[0].created_at)
        .order("created_at", { ascending: false })
        .limit(DETAIL_LOG_LIMIT);
      logs = (logRows ?? []) as GeniusLog[];
    }

    const logByMessageId = matchLogsToMessages(timeline, logs);

    const enriched = timeline.map((msg) => {
      const log = logByMessageId.get(msg.id) ?? null;
      return {
        ...msg,
        is_genius: msg.sender_id === BASEBALL_GENIUS_USER_ID,
        sender_nickname:
          msg.sender_id === BASEBALL_GENIUS_USER_ID
            ? "야잘알봇"
            : msg.sender_id
              ? (profile?.nickname ?? "알 수 없음")
              : "탈퇴한 사용자",
        log: log
          ? {
              match_path: log.match_path,
              input_tokens: log.input_tokens,
              output_tokens: log.output_tokens,
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
