import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { TEAMS } from "@/lib/constants/teams";
import { buildTeamClipping, kstDateString } from "@/lib/news-clipping";
import { mapWithConcurrency } from "@/lib/naver-news";
import type { NewsClippingPayload } from "@/types/news-clipping";

// 팀별 뉴스클리핑 발송 cron — 매일 07:00 KST(UTC 22시, vercel.json).
// 어제 팀 기사 상위 5개(중복 제외 + Gemini 3줄 요약)를 최애팀 팬 전원에게 쪽지로.
// - 수신 토글(notification_prefs.news_clipping, 기본 ON) OFF 유저는 쪽지 생성 자체를 스킵
// - (clip_date, user_id) 선점(news_clipping_sends)으로 재실행에도 유저당 1일 1회 보장
// - 기사 0개(휴식일 등) 또는 요약 가능 기사 0개인 팀은 미발송 (빈 클리핑 금지)
// - 푸시는 dm_messages INSERT 트리거 → 디스패처가 payload.type 보고 전용 문구로 발송

export const maxDuration = 300; // 팀 10개 × (네이버 2p + Gemini + OG 5) + 쪽지 bulk insert

const CRON_SECRET = process.env.CRON_SECRET || "";

const PAGE_SIZE = 1000;
const IN_CHUNK = 150;
const INSERT_CHUNK = 400;
const BUILD_CONCURRENCY = 3;

type Admin = ReturnType<typeof getSupabaseAdmin>;

function authorized(req: NextRequest): boolean {
  // fail-closed — env 미설정이면 전부 거부
  return Boolean(CRON_SECRET) && req.headers.get("authorization") === `Bearer ${CRON_SECRET}`;
}

function clippingContent(teamName: string): string {
  return `📰 오늘의 ${teamName} 뉴스클리핑`;
}

/** 운영팀 계정의 전체 대화를 페이지네이션으로 로드 → 상대 userId → conversationId 맵 */
async function loadConversationMap(admin: Admin, systemUserId: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await admin
      .from("dm_conversations")
      .select("id, user1_id, user2_id")
      .or(`user1_id.eq.${systemUserId},user2_id.eq.${systemUserId}`)
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`conversations load failed: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const c of data) {
      const other = c.user1_id === systemUserId ? c.user2_id : c.user1_id;
      if (other && other !== systemUserId) map.set(other as string, c.id as string);
    }
    if (data.length < PAGE_SIZE) break;
  }
  return map;
}

/** 특정 팀 팬 전원 (운영팀 제외, 1000행 캡 회피 페이지네이션) */
async function fetchTeamFans(admin: Admin, teamId: number, systemUserId: string): Promise<string[]> {
  const ids: string[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await admin
      .from("profiles")
      .select("id")
      .eq("team_id", teamId)
      .neq("id", systemUserId)
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`fans query failed: ${error.message}`);
    if (!data || data.length === 0) break;
    ids.push(...data.map((r: { id: string }) => r.id));
    if (data.length < PAGE_SIZE) break;
  }
  return ids;
}

/** 수신 토글 필터 — row 없음 = 기본 ON, 명시적으로 끈 유저만 제외 */
async function filterByClippingPref(admin: Admin, userIds: string[]): Promise<string[]> {
  const optedOut = new Set<string>();
  for (let i = 0; i < userIds.length; i += IN_CHUNK) {
    const slice = userIds.slice(i, i + IN_CHUNK);
    const { data, error } = await admin
      .from("notification_prefs")
      .select("user_id, news_clipping")
      .in("user_id", slice);
    if (error) throw new Error(`prefs query failed: ${error.message}`);
    for (const r of data ?? []) {
      if ((r as { news_clipping: boolean }).news_clipping === false) {
        optedOut.add((r as { user_id: string }).user_id);
      }
    }
  }
  return userIds.filter((id) => !optedOut.has(id));
}

/** (clip_date, user_id) 선점 — 이미 선점된(=오늘 이미 발송된) 유저는 제외하고 반환 */
async function claimUsers(
  admin: Admin,
  clipDate: string,
  teamId: number,
  userIds: string[],
): Promise<string[]> {
  const claimed: string[] = [];
  for (let i = 0; i < userIds.length; i += INSERT_CHUNK) {
    const slice = userIds.slice(i, i + INSERT_CHUNK);
    const { data, error } = await admin
      .from("news_clipping_sends")
      .upsert(
        slice.map((userId) => ({ clip_date: clipDate, user_id: userId, team_id: teamId })),
        { onConflict: "clip_date,user_id", ignoreDuplicates: true },
      )
      .select("user_id");
    if (error) throw new Error(`claim failed: ${error.message}`);
    claimed.push(...(data ?? []).map((r: { user_id: string }) => r.user_id));
  }
  return claimed;
}

/** 대화가 없는 유저에게 운영팀 대화 생성 (bulk) — 맵에 추가 */
async function ensureConversations(
  admin: Admin,
  systemUserId: string,
  convMap: Map<string, string>,
  userIds: string[],
  preview: string,
): Promise<void> {
  const missing = userIds.filter((id) => !convMap.has(id));
  const nowIso = new Date().toISOString();
  for (let i = 0; i < missing.length; i += INSERT_CHUNK) {
    const slice = missing.slice(i, i + INSERT_CHUNK);
    const rows = slice.map((userId) => {
      const [u1, u2] = [systemUserId, userId].sort();
      return { user1_id: u1, user2_id: u2, last_message: preview, last_message_at: nowIso };
    });
    const { data, error } = await admin
      .from("dm_conversations")
      .insert(rows)
      .select("id, user1_id, user2_id");
    if (error) throw new Error(`conv create failed: ${error.message}`);
    for (const c of data ?? []) {
      const other = c.user1_id === systemUserId ? c.user2_id : c.user1_id;
      convMap.set(other as string, c.id as string);
    }
  }
}

interface TeamSendResult {
  team: string;
  articles: number;
  targets: number;
  sent: number;
  skippedPref: number;
  alreadySent: number;
  error?: string;
}

async function sendTeamClipping(
  admin: Admin,
  systemUserId: string,
  convMap: Map<string, string>,
  clipDate: string,
  teamId: number,
  teamShort: string,
  payload: NewsClippingPayload,
): Promise<TeamSendResult> {
  const content = clippingContent(payload.team_name);

  const fans = await fetchTeamFans(admin, teamId, systemUserId);
  const optedIn = await filterByClippingPref(admin, fans);
  const claimed = await claimUsers(admin, clipDate, teamId, optedIn);

  await ensureConversations(admin, systemUserId, convMap, claimed, content);

  const nowIso = new Date().toISOString();
  let sent = 0;
  const sentConvIds: string[] = [];
  for (let i = 0; i < claimed.length; i += INSERT_CHUNK) {
    const slice = claimed.slice(i, i + INSERT_CHUNK);
    const rows = slice
      .map((userId) => convMap.get(userId))
      .filter((convId): convId is string => Boolean(convId))
      .map((convId) => ({
        conversation_id: convId,
        sender_id: systemUserId,
        content,
        payload,
      }));
    if (rows.length === 0) continue;
    const { error } = await admin.from("dm_messages").insert(rows);
    if (error) {
      console.error(`[news-clipping] dm insert failed (${teamShort}):`, error.message);
      continue;
    }
    sent += rows.length;
    sentConvIds.push(...rows.map((r) => r.conversation_id));
  }

  // 쪽지함 목록 최신화 (last_message desc 정렬 기준)
  for (let i = 0; i < sentConvIds.length; i += IN_CHUNK) {
    const slice = sentConvIds.slice(i, i + IN_CHUNK);
    const { error } = await admin
      .from("dm_conversations")
      .update({ last_message: content, last_message_at: nowIso })
      .in("id", slice);
    if (error) console.error(`[news-clipping] conv update failed (${teamShort}):`, error.message);
  }

  return {
    team: teamShort,
    articles: payload.articles.length,
    targets: fans.length,
    sent,
    skippedPref: fans.length - optedIn.length,
    alreadySent: optedIn.length - claimed.length,
  };
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const systemUserId = process.env.SYSTEM_USER_ID;
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !systemUserId) {
    return NextResponse.json({ error: "missing_config" }, { status: 500 });
  }

  const admin = getSupabaseAdmin();
  const clipDate = kstDateString(0);

  // 1) 팀별 클리핑 생성 (기사 0개/요약 불가 팀은 null → 미발송)
  const clippings = await mapWithConcurrency(TEAMS, BUILD_CONCURRENCY, async (team) => {
    try {
      return await buildTeamClipping(team.id, team.shortName, team.name);
    } catch (e) {
      console.error(`[news-clipping] build failed (${team.shortName}):`, (e as Error).message);
      return null;
    }
  });

  // 2) 발송 — 대화 맵은 1회 로드 후 팀 간 공유
  let convMap: Map<string, string>;
  try {
    convMap = await loadConversationMap(admin, systemUserId);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }

  const results: TeamSendResult[] = [];
  for (let i = 0; i < TEAMS.length; i++) {
    const payload = clippings[i];
    const team = TEAMS[i];
    if (!payload) {
      results.push({ team: team.shortName, articles: 0, targets: 0, sent: 0, skippedPref: 0, alreadySent: 0 });
      continue;
    }
    try {
      results.push(
        await sendTeamClipping(admin, systemUserId, convMap, clipDate, team.id, team.shortName, payload),
      );
    } catch (e) {
      console.error(`[news-clipping] send failed (${team.shortName}):`, (e as Error).message);
      results.push({
        team: team.shortName, articles: payload.articles.length, targets: 0, sent: 0,
        skippedPref: 0, alreadySent: 0, error: (e as Error).message,
      });
    }
  }

  return NextResponse.json({ ok: true, clipDate, results });
}

// 샘플 발송 — 특정 유저 1명에게만 클리핑 쪽지를 보낸다 (idempotency 선점/토글 필터 없음).
// 실발송 전 포맷 검수용. body: { userId: string, teamId?: number }
export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const systemUserId = process.env.SYSTEM_USER_ID;
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !systemUserId) {
    return NextResponse.json({ error: "missing_config" }, { status: 500 });
  }

  let body: { userId?: string; teamId?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  const userId = body.userId;
  if (!userId) {
    return NextResponse.json({ error: "userId required" }, { status: 400 });
  }

  const admin = getSupabaseAdmin();

  let teamId = body.teamId ?? null;
  if (!teamId) {
    const { data: prof } = await admin.from("profiles").select("team_id").eq("id", userId).maybeSingle();
    teamId = (prof?.team_id as number | null) ?? null;
  }
  const team = TEAMS.find((t) => t.id === teamId);
  if (!team) {
    return NextResponse.json({ error: "team not found (최애팀 미설정)" }, { status: 400 });
  }

  const payload = await buildTeamClipping(team.id, team.shortName, team.name);
  if (!payload) {
    return NextResponse.json({ error: "no articles for yesterday" }, { status: 404 });
  }

  const content = clippingContent(payload.team_name);
  const convMap = new Map<string, string>();
  const { data: existing } = await admin
    .from("dm_conversations")
    .select("id, user1_id, user2_id")
    .or(
      `and(user1_id.eq.${systemUserId},user2_id.eq.${userId}),and(user1_id.eq.${userId},user2_id.eq.${systemUserId})`,
    )
    .maybeSingle();
  if (existing) convMap.set(userId, existing.id as string);
  await ensureConversations(admin, systemUserId, convMap, [userId], content);

  const convId = convMap.get(userId);
  if (!convId) {
    return NextResponse.json({ error: "conv_create_failed" }, { status: 500 });
  }
  const { error: msgError } = await admin.from("dm_messages").insert({
    conversation_id: convId,
    sender_id: systemUserId,
    content,
    payload,
  });
  if (msgError) {
    return NextResponse.json({ error: `send_failed: ${msgError.message}` }, { status: 500 });
  }
  await admin
    .from("dm_conversations")
    .update({ last_message: content, last_message_at: new Date().toISOString() })
    .eq("id", convId);

  return NextResponse.json({
    ok: true,
    sample: true,
    conversationId: convId,
    team: team.shortName,
    articles: payload.articles.length,
    overview: payload.overview,
    titles: payload.articles.map((a) => a.title),
  });
}
