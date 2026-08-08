import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { TEAMS } from "@/lib/constants/teams";
import { NEWS_CLIPPER_BY_TEAM, NEWS_CLIPPER_IDS } from "@/lib/constants/news-clippers";
import { buildTeamClipping, kstDateString } from "@/lib/news-clipping";
import type { RawCandidateSink } from "@/lib/news-clipping";
import { toNewsArticleRows } from "@/lib/baseball-qa/rag/news-articles";
import { ingestNewsArticles, type TeamCollection } from "@/lib/baseball-qa/rag/news-ingest";
import { mapWithConcurrency } from "@/lib/naver-news";
import { fetchStandings } from "@/lib/crawler/kbo-api";
import { formatStandingsTable } from "@/lib/ai/standings-guard";
import type { NewsClippingPayload } from "@/types/news-clipping";

// 팀별 뉴스클리핑 발송 cron — 매일 09:00 KST(UTC 0시, vercel.json).
// 어제 팀 기사 상위 5개(중복 제외 + Gemini 3줄 요약)를 최애팀 팬 전원에게 쪽지로.
// - 발신자는 팀별 전용 계정 "{팀} 뉴스클리퍼"(NEWS_CLIPPER_BY_TEAM) — 운영팀 쪽지함/CS
//   릴레이와 완전 분리해 클리핑 답장이 CS 인입함을 오염시키지 않게 한다
// - 수신 토글(notification_prefs.news_clipping, 기본 ON) OFF 유저는 쪽지 생성 자체를 스킵
// - (clip_date, user_id) 선점(news_clipping_sends)으로 재실행에도 유저당 1일 1회 보장
// - 기사 0개(휴식일 등) 또는 요약 가능 기사 0개인 팀은 미발송 (빈 클리핑 금지)
// - 푸시는 dm_messages INSERT 트리거 → 디스패처가 클리퍼 발신+payload.type 보고 전용 문구 발송

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

/** 오늘 이전에 클리핑을 받아본 적 있는 유저 집합 (없으면 = 최초 수신 → 인트로 대상) */
async function fetchPriorRecipients(admin: Admin, userIds: string[], clipDate: string): Promise<Set<string>> {
  const prior = new Set<string>();
  for (let i = 0; i < userIds.length; i += IN_CHUNK) {
    const slice = userIds.slice(i, i + IN_CHUNK);
    // 유저당 이력 row가 누적되므로 1000행 캡 회피 페이지네이션
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await admin
        .from("news_clipping_sends")
        .select("user_id")
        .in("user_id", slice)
        .lt("clip_date", clipDate)
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw new Error(`prior sends query failed: ${error.message}`);
      if (!data || data.length === 0) break;
      for (const r of data) prior.add((r as { user_id: string }).user_id);
      if (data.length < PAGE_SIZE) break;
    }
  }
  return prior;
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

/** 발신 계정(클리퍼)의 전체 대화를 페이지네이션으로 로드 → 상대 userId → conversationId 맵 */
async function loadConversationMap(admin: Admin, senderId: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await admin
      .from("dm_conversations")
      .select("id, user1_id, user2_id")
      .or(`user1_id.eq.${senderId},user2_id.eq.${senderId}`)
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`conversations load failed: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const c of data) {
      const other = c.user1_id === senderId ? c.user2_id : c.user1_id;
      if (other && other !== senderId) map.set(other as string, c.id as string);
    }
    if (data.length < PAGE_SIZE) break;
  }
  return map;
}

/** 특정 팀 팬 전원 (운영팀·클리퍼 계정 제외, 1000행 캡 회피 페이지네이션) */
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
  // 클리퍼 계정도 team_id를 가진 profiles라 자기 자신(및 타 클리퍼) 제외
  return ids.filter((id) => !NEWS_CLIPPER_IDS.has(id));
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

interface TeamSendResult {
  team: string;
  articles: number;
  targets: number;
  sent: number;
  skippedPref: number;
  alreadySent: number;
  firstIntro?: number;
  error?: string;
}

async function sendTeamClipping(
  admin: Admin,
  senderId: string,
  systemUserId: string,
  clipDate: string,
  teamId: number,
  teamShort: string,
  payload: NewsClippingPayload,
): Promise<TeamSendResult> {
  const content = clippingContent(payload.team_name);

  const fans = await fetchTeamFans(admin, teamId, systemUserId);
  const optedIn = await filterByClippingPref(admin, fans);
  const claimed = await claimUsers(admin, clipDate, teamId, optedIn);

  const convMap = await loadConversationMap(admin, senderId);
  await ensureConversations(admin, senderId, convMap, claimed, content);

  // 최초 수신 유저에게만 인트로 포함 payload (닉네임 치환)
  const prior = await fetchPriorRecipients(admin, claimed, clipDate);
  const firstTimers = claimed.filter((id) => !prior.has(id));
  const nicknames = await fetchNicknames(admin, firstTimers);

  const nowIso = new Date().toISOString();
  let sent = 0;
  const sentConvIds: string[] = [];
  for (let i = 0; i < claimed.length; i += INSERT_CHUNK) {
    const slice = claimed.slice(i, i + INSERT_CHUNK);
    const rows = slice
      .map((userId) => ({ userId, convId: convMap.get(userId) }))
      .filter((r): r is { userId: string; convId: string } => Boolean(r.convId))
      .map(({ userId, convId }) => ({
        conversation_id: convId,
        sender_id: senderId,
        content,
        payload: prior.has(userId)
          ? payload
          : { ...payload, intro: firstIntro(payload.team_name, nicknames.get(userId) ?? "팬") },
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
    firstIntro: firstTimers.length,
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

  // 순위표 1회 조회 → 모든 팀 클리핑 프롬프트에 공통 근거로 주입 (순위 환각 방지)
  const standingsText = await loadStandingsText();

  // 야잘알봇 RAG 근거 적재용 raw 후보 수집기 — 클리핑 필터 **이전** 단계에서 받는다.
  // 네이버 추가 호출 0(이미 긁고 버리던 데이터). 발송 로직에는 영향을 주지 않는다.
  // 수집이 실패한 팀도 행을 남긴다 — 사후에 "그날 기사 0건"과 "수집 실패"를 구분하기 위함.
  const collections = new Map<number, TeamCollection>(
    TEAMS.map((team) => [
      team.id,
      { teamId: team.id, rows: [], truncated: false, pagesFetched: 0, error: "not_collected" },
    ]),
  );
  const collectRaw: RawCandidateSink = (teamId, items, meta) => {
    try {
      collections.set(teamId, {
        teamId,
        rows: toNewsArticleRows(items, teamId),
        truncated: meta.truncated,
        pagesFetched: meta.pagesFetched,
      });
    } catch (e) {
      // 근거 적재는 부가기능이다. 여기서 던지면 그 팀 클리핑 발송까지 막힌다.
      const message = (e as Error).message;
      console.error(`[news-clipping] rag collect failed (team ${teamId}):`, message);
      collections.set(teamId, {
        teamId,
        rows: [],
        truncated: meta.truncated,
        pagesFetched: meta.pagesFetched,
        error: message,
      });
    }
  };

  // 1) 팀별 클리핑 생성 (기사 0개/요약 불가 팀은 null → 미발송)
  const clippings = await mapWithConcurrency(TEAMS, BUILD_CONCURRENCY, async (team) => {
    try {
      return await buildTeamClipping(team.id, team.shortName, team.name, standingsText, collectRaw);
    } catch (e) {
      console.error(`[news-clipping] build failed (${team.shortName}):`, (e as Error).message);
      return null;
    }
  });

  // 2) 발송 — 팀별 전용 클리퍼 계정에서
  const results: TeamSendResult[] = [];
  for (let i = 0; i < TEAMS.length; i++) {
    const payload = clippings[i];
    const team = TEAMS[i];
    if (!payload) {
      results.push({ team: team.shortName, articles: 0, targets: 0, sent: 0, skippedPref: 0, alreadySent: 0 });
      continue;
    }
    const senderId = NEWS_CLIPPER_BY_TEAM[team.id];
    if (!senderId) {
      results.push({
        team: team.shortName, articles: payload.articles.length, targets: 0, sent: 0,
        skippedPref: 0, alreadySent: 0, error: "clipper account missing",
      });
      continue;
    }
    try {
      results.push(
        await sendTeamClipping(admin, senderId, systemUserId, clipDate, team.id, team.shortName, payload),
      );
    } catch (e) {
      console.error(`[news-clipping] send failed (${team.shortName}):`, (e as Error).message);
      results.push({
        team: team.shortName, articles: payload.articles.length, targets: 0, sent: 0,
        skippedPref: 0, alreadySent: 0, error: (e as Error).message,
      });
    }
  }

  // 3) 야잘알봇 근거 적재 — **발송이 끝난 뒤에**, 남은 예산 안에서만 돈다.
  //
  // 왜 순서가 중요한가
  //   적재를 발송 앞에 두면 적재가 느리거나 막힐 때 그만큼 발송이 밀리고, maxDuration 에
  //   걸리면 **쪽지가 아예 안 나간다**. 근거 적재는 부가기능이므로 유저 발송이 끝난 뒤에
  //   돌리고, 그러고도 예산을 넘기면 스스로 멈춘다(ingestNewsArticles 는 throw 하지 않는다).
  const ingested = await ingestNewsArticles(admin, [...collections.values()], clipDate);

  return NextResponse.json({ ok: true, clipDate, results, ragIngest: ingested });
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
    sender: `${team.shortName} 뉴스클리퍼`,
    team: team.shortName,
    articles: payload.articles.length,
    overview: payload.overview,
    titles: payload.articles.map((a) => a.title),
  });
}
