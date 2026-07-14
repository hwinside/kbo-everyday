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
import {
  resolveInboxFromInput,
  resolveInboxTeamOnly,
} from "@/lib/gif-collector/inbox-resolver";
import { publishQueueItem } from "@/lib/gif-collector/publisher";

export const runtime = "nodejs";
// 미디어 상한 5개(MAX_MEDIA_ITEMS)로 확대 → 순차 다운로드/업로드 시간 여유 확보 위해 60s로 상향.
export const maxDuration = 60;

const SIGNING_SECRET = process.env.SLACK_GIF_COLLECTOR_SIGNING_SECRET;
const BOT_TOKEN = process.env.SLACK_GIF_COLLECTOR_BOT_TOKEN;
const INBOX_CHANNEL_ID = process.env.GIF_COLLECTOR_INBOX_CHANNEL_ID;
const AUTHORIZED_USER_IDS = (process.env.GIF_COLLECTOR_AUTHORIZED_USER_IDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

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

  // playerName === ""  → 팀 사진 게시판 (board_type='team', board_id=teamSlug)
  // playerName 존재    → 선수 사진 게시판 (board_type='player', board_id=kboId)
  let matchedKboId: string | null;
  let matchedBoardType: "player" | "team";
  let matchedBoardId: string;
  let displayName: string; // 슬랙 reply에 표시될 라벨 (선수 canonical or 팀 short name)
  let titleFallback: string;
  let teamIdForLog: number;
  if (playerName === "") {
    const resolvedTeam = resolveInboxTeamOnly(teamName);
    if (!resolvedTeam.ok) {
      await reactAndReply(evt.channel, evt.ts, "x", resolvedTeam.error);
      return;
    }
    const v = resolvedTeam.value;
    matchedKboId = null;
    matchedBoardType = "team";
    matchedBoardId = v.teamSlug;
    displayName = `${v.teamShortName} 팀 사진 게시판`;
    titleFallback = `${v.teamShortName} 사진`;
    teamIdForLog = v.teamId;
  } else {
    const resolved = resolveInboxFromInput(teamName, playerName);
    if (!resolved.ok) {
      await reactAndReply(evt.channel, evt.ts, "x", resolved.error);
      return;
    }
    const v = resolved.value;
    matchedKboId = v.kboId;
    matchedBoardType = "player";
    matchedBoardId = v.kboId;
    displayName = v.playerCanonicalName;
    titleFallback = `${teamName} ${playerName}`;
    teamIdForLog = v.teamId;
  }

  const { data: inserted, error } = await supabaseAdmin
    .from("gif_collector_queue")
    .insert({
      source_type: "slack_inbox",
      external_post_id: evt.ts,
      source_url: url,
      source_author: evt.user ?? null,
      source_title: (body.split("\n").find((l) => l.trim().length > 0) ?? "") || titleFallback,
      source_content: body,
      source_tags: [teamName],
      original_media_urls: [],
      matched_kbo_id: matchedKboId,
      matched_board_type: matchedBoardType,
      matched_board_id: matchedBoardId,
      match_confidence: 1.0,
      match_status: "pending",
    })
    .select("id")
    .single<{ id: number }>();

  if (error || !inserted) {
    if (error?.code === "23505") {
      // Slack retries the same event.ts after slow webhook handling. The first
      // attempt already registered/published it, so keep retries invisible.
      return;
    }
    console.error("[gif-collector] queue insert failed:", error);
    await reactAndReply(evt.channel, evt.ts, "x", `큐 저장 실패: ${error?.message ?? "no row"}`);
    return;
  }

  // 발행 즉시 진행 (옵션 A, 2026-05-25 확정).
  const pub = await publishQueueItem(inserted.id);
  // best-effort 부분실패 안내: attempted > succeeded면 "N개 중 M개 발행" 추가.
  const partialMediaNote =
    pub.attempted && pub.succeeded && pub.attempted > pub.succeeded
      ? ` (${pub.attempted}개 중 ${pub.succeeded}개 발행)`
      : "";
  const mediaErrorsNote =
    pub.mediaErrors && pub.mediaErrors.length > 0
      ? `\n부분실패: ${pub.mediaErrors.join("; ")}`
      : "";

  const matchLabel =
    matchedBoardType === "player"
      ? `kboId=${matchedKboId}, teamId=${teamIdForLog}`
      : `board=team:${matchedBoardId}, teamId=${teamIdForLog}`;

  if (pub.ok) {
    const kindLabel =
      pub.kind === "photo"
        ? `🖼 사진글(짤콜렉터) ${pub.succeeded ?? 0}장`
        : `🎞 영상(움짤콜렉터) ${pub.succeeded ?? 0}개`;
    await reactAndReply(
      evt.channel,
      evt.ts,
      partialMediaNote ? "warning" : "white_check_mark",
      `게시 완료 — ${kindLabel} · *${displayName}* (${matchLabel})${partialMediaNote}. posts.id=${pub.postId}${mediaErrorsNote}`,
    );
    return;
  }

  // partial: post는 생성됐지만 queue update 실패. false success 방지.
  if (pub.partial) {
    await reactAndReply(
      evt.channel,
      evt.ts,
      "warning",
      `posts.id=${pub.postId}은 생성됐지만 큐 상태 동기화 실패. *${displayName}*${partialMediaNote} / 큐 id=${inserted.id}. 운영자가 gif_collector_queue.match_status를 직접 'auto_posted'로 정리해야 합니다.\n에러: ${pub.error}${mediaErrorsNote}`,
    );
    return;
  }

  await reactAndReply(
    evt.channel,
    evt.ts,
    "x",
    `발행 실패: ${pub.error}\n*${displayName}* (${matchLabel}). 큐 id=${inserted.id} (status=rejected).`,
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
    // Fail-closed: 인박스 채널 id가 설정 안 되어 있으면 모든 메시지 거부.
    if (!INBOX_CHANNEL_ID) {
      console.error("[gif-collector] GIF_COLLECTOR_INBOX_CHANNEL_ID not set");
      return NextResponse.json({ error: "inbox channel not configured" }, { status: 503 });
    }

    const evt = (payload as SlackEventCallback).event;
    if (evt?.type !== "message") {
      return NextResponse.json({ ok: true });
    }
    // 다른 채널 메시지 무시
    if (evt.channel !== INBOX_CHANNEL_ID) {
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
    // 운영자 whitelist: 설정돼 있으면 그 안의 user_id만 허용.
    if (AUTHORIZED_USER_IDS.length > 0 && !AUTHORIZED_USER_IDS.includes(evt.user)) {
      await reactAndReply(
        evt.channel,
        evt.ts,
        "no_entry",
        "이 채널은 운영자 전용입니다. 권한이 없는 계정이라 큐 등록을 건너뜁니다.",
      );
      return NextResponse.json({ ok: true });
    }

    // 처리. Slack은 3초 내 응답을 기대하지만 maxDuration 30s 내 처리 가능.
    // unique constraint로 retry 자동 dedupe.
    await processMessage(evt);
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: true });
}
