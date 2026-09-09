import { NextRequest, NextResponse } from "next/server";
import { runClippingDelivery, CLIPPING_BATCH_SIZE, CLIPPING_RPC_TIMEOUT_MS, type ClippingProgress } from "@/lib/news-clipping-delivery";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { TEAMS } from "@/lib/constants/teams";
import { NEWS_CLIPPER_BY_TEAM, NEWS_CLIPPER_IDS } from "@/lib/constants/news-clippers";
import { buildTeamClipping, kstDateString, toRefClippingPayload } from "@/lib/news-clipping";
import { fetchStandings } from "@/lib/crawler/kbo-api";
import { formatStandingsTable } from "@/lib/ai/standings-guard";
import type {
  NewsClippingLegacyPayload,
  NewsClippingPayload,
  NewsClippingRefPayload,
} from "@/types/news-clipping";

// 구단별 독립 cron — 09:00~09:09 KST 분산, 10분 간격으로 3회 멱등 재시도.
// 어제 팀 기사 상위 5개(중복 제외 + Gemini 3줄 요약)를 최애팀 팬 전원에게 쪽지로.
// - 발신자는 팀별 전용 계정 "{팀} 뉴스클리퍼"(NEWS_CLIPPER_BY_TEAM) — 운영팀 쪽지함/CS
//   릴레이와 완전 분리해 클리핑 답장이 CS 인입함을 오염시키지 않게 한다
// - 수신 토글(notification_prefs.news_clipping, 기본 ON) OFF 유저는 쪽지 생성 자체를 스킵
// - 선점·쪽지·대화 갱신은 한 RPC 트랜잭션. (clip_date,user_id)당 하루 한 번 보장
// - 기사 0개(휴식일 등) 또는 요약 가능 기사 0개인 팀은 미발송 (빈 클리핑 금지)
// - 푸시는 dm_messages INSERT 트리거 → 디스패처가 클리퍼 발신+payload.type 보고 전용 문구 발송

export const maxDuration = 300; // 한 구단당 독립 예산, 240초부터 다음 예약 재시도로 이월

const CRON_SECRET = process.env.CRON_SECRET || "";

const IN_CHUNK = 150;
const INSERT_CHUNK = 400;

type Admin = ReturnType<typeof getSupabaseAdmin>;

function authorized(req: NextRequest): boolean {
  // fail-closed — env 미설정이면 전부 거부
  return Boolean(CRON_SECRET) && req.headers.get("authorization") === `Bearer ${CRON_SECRET}`;
}

function clippingContent(teamName: string): string {
  return `📰 오늘의 ${teamName} 뉴스클리핑`;
}

/**
 * 공식 순위표를 1회 조회해 AI 프롬프트용 텍스트로 반환 (팀별 반복 조회 방지).
 * 순위 조회 실패는 클리핑 발송을 막지 않는다 — null이면 그 회차만 순위 근거 없이 진행.
 */
async function loadStandingsText(): Promise<string | null> {
  try {
    const standings = await fetchStandings();
    return standings.length > 0 ? formatStandingsTable(standings) : null;
  } catch (e) {
    console.error("[news-clipping] standings fetch failed:", (e as Error).message);
    return null;
  }
}

/** 유저별 최초 수신 클리핑 인트로 (삼순 다듬은 문구 — 하린아빠 채택. 오늘 첫 발송 전원 + 이후 신규 가입 유저 커버) */
function firstIntro(teamName: string, nickname: string): string {
  return `아침에 갑작스러운 쪽지로 놀라시진 않으셨나요?
크보팬은 회원님이 등록해주신 최애팀을 기준으로, 하루에 한 번 아침 9시에 뉴스클리핑을 보내드려요.
앞으로 ${teamName}의 소식을 ${nickname}님께 매일 전해드릴게요.

혹시 수신을 원치 않으시면 마이페이지에서 뉴스클리핑 설정을 OFF로 바꾸실 수 있습니다.
팀과 관련된 중요한 소식을 놓치지 않으시도록, 매일 정성껏 모으고 요약해서 보내드릴게요.`;
}

/** 닉네임 batch fetch (인트로 치환용) */
async function fetchNicknames(admin: Admin, userIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (let i = 0; i < userIds.length; i += IN_CHUNK) {
    const slice = userIds.slice(i, i + IN_CHUNK);
    const { data, error } = await admin.from("profiles").select("id, nickname").in("id", slice);
    if (error) throw new Error(`nickname query failed: ${error.message}`);
    for (const r of data ?? []) map.set((r as { id: string }).id, (r as { nickname: string }).nickname);
  }
  return map;
}

/** 대화가 없는 유저에게 발신 계정과의 대화 생성 (bulk) — 맵에 추가 */
async function ensureConversations(
  admin: Admin,
  senderId: string,
  convMap: Map<string, string>,
  userIds: string[],
  preview: string,
): Promise<void> {
  const missing = userIds.filter((id) => !convMap.has(id));
  const nowIso = new Date().toISOString();
  for (let i = 0; i < missing.length; i += INSERT_CHUNK) {
    const slice = missing.slice(i, i + INSERT_CHUNK);
    const rows = slice.map((userId) => {
      const [u1, u2] = [senderId, userId].sort();
      return { user1_id: u1, user2_id: u2, last_message: preview, last_message_at: nowIso };
    });
    const { data, error } = await admin
      .from("dm_conversations")
      .insert(rows)
      .select("id, user1_id, user2_id");
    if (error) throw new Error(`conv create failed: ${error.message}`);
    for (const c of data ?? []) {
      const other = c.user1_id === senderId ? c.user2_id : c.user1_id;
      convMap.set(other as string, c.id as string);
    }
  }
}

interface TeamSendResult extends ClippingProgress { team: string; articles: number }

/** Retries reuse the immutable digest rather than paying for Gemini again. */
async function cachedClipping(admin: Admin, teamId: number): Promise<NewsClippingLegacyPayload | null> {
  const { data, error } = await admin.from("news_clipping_digests")
    .select("team_id, team_name, clip_date, overview, articles")
    .eq("team_id", teamId).eq("clip_date", kstDateString(-1))
    .abortSignal(AbortSignal.timeout(15_000)).maybeSingle();
  if (error) throw new Error(`digest read failed: ${error.message}`);
  if (!data) return null;
  if (!Array.isArray(data.articles) || data.articles.length === 0) throw new Error("invalid stored clipping digest");
  return { type: "news_clipping", team_id: data.team_id, team_name: data.team_name,
    date: data.clip_date, overview: data.overview,
    articles: data.articles as NewsClippingLegacyPayload["articles"] };
}

async function sendTeamClipping(
  admin: Admin, senderId: string, systemUserId: string, clipDate: string,
  teamId: number, teamShort: string, payload: NewsClippingLegacyPayload,
  refPayload: NewsClippingRefPayload | null, deadline: number,
): Promise<TeamSendResult> {
  const progress = await runClippingDelivery(async () => {
    const { data, error } = await admin.rpc("deliver_news_clipping_batch", {
      p_clip_date: clipDate, p_team_id: teamId, p_sender_id: senderId,
      p_system_user_id: systemUserId, p_excluded_user_ids: [...NEWS_CLIPPER_IDS],
      p_content: clippingContent(payload.team_name), p_payload: refPayload ?? payload,
      p_first_intro: firstIntro(payload.team_name, "{{nickname}}"), p_limit: CLIPPING_BATCH_SIZE,
    }).abortSignal(AbortSignal.timeout(CLIPPING_RPC_TIMEOUT_MS));
    if (error) throw new Error(`atomic delivery failed (${teamShort}): ${error.message}`);
    return data;
  }, deadline);
  return { team: teamShort, articles: payload.articles.length, ...progress };
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const systemUserId = process.env.SYSTEM_USER_ID;
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !systemUserId) {
    return NextResponse.json({ error: "missing_config" }, { status: 500 });
  }
  // Every team has its own runtime budget. No unbounded all-team send route.
  const rawTeam = req.nextUrl.searchParams.get("teamId");
  const team = /^\d+$/.test(rawTeam ?? "") ? TEAMS.find((t) => t.id === Number(rawTeam)) : undefined;
  if (!team) return NextResponse.json({ error: "valid teamId required" }, { status: 400 });
  const senderId = NEWS_CLIPPER_BY_TEAM[team.id];
  if (!senderId) return NextResponse.json({ error: "clipper account missing" }, { status: 500 });
  const admin = getSupabaseAdmin();
  const clipDate = kstDateString(0);
  const deadline = Date.now() + 240_000;
  try {
    const payload = await cachedClipping(admin, team.id)
      ?? await buildTeamClipping(team.id, team.shortName, team.name, await loadStandingsText());
    if (!payload) return NextResponse.json({ ok: true, clipDate, teamId: team.id, noArticles: true, results: [] });
    const ref = await toRefClippingPayload(admin, payload);
    const result = await sendTeamClipping(admin, senderId, systemUserId, clipDate,
      team.id, team.shortName, payload, ref?.ref ?? null, deadline);
    const ok = result.remaining === 0;
    return NextResponse.json({ ok, clipDate, teamId: team.id, results: [result] }, { status: ok ? 200 : 503 });
  } catch (error) {
    console.error(`[news-clipping] team ${team.id} failed:`, error instanceof Error ? error.message : "delivery_failed");
    return NextResponse.json({ ok: false, clipDate, teamId: team.id, error: "delivery_failed_retryable" }, { status: 503 });
  }
}

// 샘플 발송 — 특정 유저 1명에게만 클리핑 쪽지를 보낸다 (idempotency 선점/토글 필터 없음).
// 실발송 전 포맷 검수용. body: { userId: string, teamId?: number }
export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
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
  const senderId = NEWS_CLIPPER_BY_TEAM[team.id];
  if (!senderId) {
    return NextResponse.json({ error: "clipper account missing" }, { status: 500 });
  }

  const standingsText = await loadStandingsText();
  const payload = await buildTeamClipping(team.id, team.shortName, team.name, standingsText);
  if (!payload) {
    return NextResponse.json({ error: "no articles for yesterday" }, { status: 404 });
  }

  // 샘플은 항상 인트로 포함 (최초 수신 쪽지 포맷 검수용)
  const nicknames = await fetchNicknames(admin, [userId]);
  payload.intro = firstIntro(payload.team_name, nicknames.get(userId) ?? "팬");

  // ⚠️ 삼순 blocker 4 (2026-08-20): 샘플 발송이 legacy 를 저장하면 **신규 참조형 경로를
  //    E2E 로 검증할 수가 없다** — 포맷 검수용인데 정작 실제 발송과 다른 형태를 보게 된다.
  //    cron 과 동일하게 digest 로 올리고 참조형을 저장한다(실패 시 legacy 폴백도 동일).
  const sampleResult = await toRefClippingPayload(admin, payload);
  const samplePayload: NewsClippingPayload = sampleResult
    ? { ...sampleResult.ref, intro: payload.intro }
    : payload;
  // ⚠️ 삼순 blocker (4차): 응답은 **실제로 전송된 내용**이어야 한다.
  //    digest 가 이미 있으면(cron 재실행·샘플 선점) 수신자가 보는 건 저장된 A 인데,
  //    방금 만든 B 의 overview/titles 를 보고하면 검수자가 화면과 다른 목록을 보고
  //    "맞다"고 판정하게 된다. RPC 가 돌려준 canonical 을 기준으로 삼는다.
  const canonical = sampleResult?.canonical ?? {
    overview: payload.overview,
    articles: payload.articles,
  };

  const content = clippingContent(payload.team_name);
  const convMap = new Map<string, string>();
  const { data: existing } = await admin
    .from("dm_conversations")
    .select("id, user1_id, user2_id")
    .or(
      `and(user1_id.eq.${senderId},user2_id.eq.${userId}),and(user1_id.eq.${userId},user2_id.eq.${senderId})`,
    )
    .maybeSingle();
  if (existing) convMap.set(userId, existing.id as string);
  await ensureConversations(admin, senderId, convMap, [userId], content);

  const convId = convMap.get(userId);
  if (!convId) {
    return NextResponse.json({ error: "conv_create_failed" }, { status: 500 });
  }
  const { error: msgError } = await admin.from("dm_messages").insert({
    conversation_id: convId,
    sender_id: senderId,
    content,
    payload: samplePayload,
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
    sender: `${team.shortName} 뉴스클리퍼`,
    team: team.shortName,
    articles: canonical.articles.length,
    overview: canonical.overview,
    titles: canonical.articles.map((a) => a.title),
    // 이 응답이 방금 만든 것인지, 이미 저장돼 있던 것인지 검수자가 알 수 있게 한다.
    // ⚠️ overview 비교로 추정하지 않는다(같은 overview 재실행·articles 만 바뀐 충돌을 놓친다).
    //    DB 가 돌려준 was_inserted 사실만 쓴다.
    digestReused: sampleResult?.reused ?? false,
  });
}
