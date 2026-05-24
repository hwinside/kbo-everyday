/**
 * 움짤콜렉터 슬랙 인박스 webhook (Slack Events API).
 *
 * 채널 #gif-collector-inbox (C0B5YJV02LC)에서 운영자가 멀티라인 메시지를 던지면:
 *   1. 서명 검증 (X-Slack-Signature, X-Slack-Request-Timestamp)
 *   2. URL verification handshake 응답
 *   3. message 이벤트면 파서 → 팀/선수 검증 → gif_collector_queue insert
 *   4. 슬랙 reaction(✅ 성공 / ❌ 실패) + 실패 시 친절한 thread 댓글 (fire-and-forget)
 *
 * Env:
 *   SLACK_GIF_COLLECTOR_SIGNING_SECRET   — Slack App signing secret
 *   SLACK_GIF_COLLECTOR_BOT_TOKEN        — Bot token (chat:write, reactions:write)
 *   GIF_COLLECTOR_INBOX_CHANNEL_ID       — '#gif-collector-inbox' 채널 id
 */

import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { parseInboxMessage } from "@/lib/gif-collector/slack-parser";
import { resolveInboxFromInput } from "@/lib/gif-collector/inbox-resolver";

export const runtime = "nodejs";
export const maxDuration = 30;

const SIGNING_SECRET = process.env.SLACK_GIF_COLLECTOR_SIGNING_SECRET;
const BOT_TOKEN = process.env.SLACK_GIF_COLLECTOR_BOT_TOKEN;
const INBOX_CHANNEL_ID = process.env.GIF_COLLECTOR_INBOX_CHANNEL_ID;

function verifySignature(rawBody: string, timestamp: string, signature: string): boolean {
  if (!SIGNING_SECRET) return false;
  const tsNum = Number(timestamp);
  if (!Number.isFinite(tsNum)) return false;
  // replay 방지: 5분 이상 오래된 요청은 거부
  const fiveMinAgo = Math.floor(Date.now() / 1000) - 5 * 60;
  if (tsNum < fiveMinAgo) return false;

  const baseString = `v0:${timestamp}:${rawBody}`;
  const computed = `v0=${createHmac("sha256", SIGNING_SECRET).update(baseString).digest("hex")}`;
  const a = Buffer.from(computed);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

interface SlackMessageEvent {
  type: "message";
  channel: string;
  user?: string;
  text?: string;
  ts: string;
  subtype?: string;
  bot_id?: string;
  thread_ts?: string;
}

interface SlackEventCallback {
  type: "event_callback";
  event: SlackMessageEvent;
}

interface SlackUrlVerification {
  type: "url_verification";
  challenge: string;
}

type SlackPayload = SlackEventCallback | SlackUrlVerification | { type: string };

async function slackApi(method: string, body: Record<string, unknown>): Promise<void> {
  if (!BOT_TOKEN) return;
  try {
    await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${BOT_TOKEN}`,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.error(`[gif-collector] slack ${method} failed:`, e);
  }
}

async function reactAndReply(
  channel: string,
  ts: string,
  emoji: string,
  replyText?: string,
): Promise<void> {
  await slackApi("reactions.add", { channel, timestamp: ts, name: emoji });
  if (replyText) {
    await slackApi("chat.postMessage", {
      channel,
      thread_ts: ts,
      text: replyText,
    });
  }
}

async function processMessage(evt: SlackMessageEvent): Promise<void> {
  const text = evt.text ?? "";
  const parsed = parseInboxMessage(text);
  if (!parsed.ok) {
    await reactAndReply(
      evt.channel,
      evt.ts,
      "x",
      `입력 형식이 아니에요: ${parsed.error}\n\n*형식*\n\`\`\`\n<URL>\n팀 선수\n본문 (선택, 1줄 이상 자유)\n\`\`\``,
    );
    return;
  }

  const { url, teamName, playerName, body } = parsed.value;
  const resolved = resolveInboxFromInput(teamName, playerName);
  if (!resolved.ok) {
    await reactAndReply(evt.channel, evt.ts, "x", resolved.error);
    return;
  }

  const { teamId, kboId, playerCanonicalName } = resolved.value;

  const { error } = await supabaseAdmin.from("gif_collector_queue").insert({
    source_type: "slack_inbox",
    external_post_id: evt.ts,
    source_url: url,
    source_author: evt.user ?? null,
    source_title: body.split("\n")[0] || `${teamName} ${playerName}`,
    source_content: body,
    source_tags: [teamName],
    original_media_urls: [],
    matched_kbo_id: kboId,
    matched_board_type: "player",
    matched_board_id: kboId,
    match_confidence: 1.0,
    match_status: "pending",
  });

  if (error) {
    // unique constraint (재전송) → 친절히
    if (error.code === "23505") {
      await reactAndReply(evt.channel, evt.ts, "repeat", "이미 큐에 등록된 메시지예요.");
      return;
    }
    console.error("[gif-collector] queue insert failed:", error);
    await reactAndReply(evt.channel, evt.ts, "x", `큐 저장 실패: ${error.message}`);
    return;
  }

  await reactAndReply(
    evt.channel,
    evt.ts,
    "white_check_mark",
    `큐 등록 완료 — *${playerCanonicalName}* (kboId=${kboId}, teamId=${teamId}). PR4 발행 단계에서 미디어 추출 후 게시됩니다.`,
  );
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const rawBody = await req.text();
  const signature = req.headers.get("x-slack-signature") ?? "";
  const timestamp = req.headers.get("x-slack-request-timestamp") ?? "";

  if (!verifySignature(rawBody, timestamp, signature)) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let payload: SlackPayload;
  try {
    payload = JSON.parse(rawBody) as SlackPayload;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (payload.type === "url_verification") {
    return NextResponse.json({ challenge: (payload as SlackUrlVerification).challenge });
  }

  if (payload.type === "event_callback") {
    const evt = (payload as SlackEventCallback).event;
    if (evt?.type !== "message") {
      return NextResponse.json({ ok: true });
    }
    // 다른 채널 메시지 무시
    if (INBOX_CHANNEL_ID && evt.channel !== INBOX_CHANNEL_ID) {
      return NextResponse.json({ ok: true });
    }
    // edit/delete/bot_message 등 subtype 무시
    if (evt.subtype) {
      return NextResponse.json({ ok: true });
    }
    // 봇이 자기 메시지에 반응하지 않도록
    if (evt.bot_id || !evt.user) {
      return NextResponse.json({ ok: true });
    }
    // 스레드 답글 무시 (인박스는 top-level만)
    if (evt.thread_ts && evt.thread_ts !== evt.ts) {
      return NextResponse.json({ ok: true });
    }

    // 처리. Slack은 3초 내 응답을 기대하지만 maxDuration 30s 내 처리 가능.
    // unique constraint로 retry 자동 dedupe.
    await processMessage(evt);
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: true });
}
