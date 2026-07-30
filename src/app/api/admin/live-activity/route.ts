import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { isAdminAuthedRequest } from "@/lib/admin/pin";
import {
  activeChannelKeySet,
  countUpdatableUsers,
  isLiveBornChannel,
  isLiveChannelSubscription,
  type ActiveChannelRef,
} from "@/lib/notifications/live-activity-channel-policy";
import type { KboRawGame } from "@/types/api";
import { isKboGameCancelled } from "@/lib/crawler/kbo-status";
import { fetchKboLiveGames } from "@/lib/notifications/kbo-live-games";

// 어드민 — Live Activity 토큰/카드 종합 현황.
// 발급된 push-to-start 토큰 수, 떠있는 잠금화면(started_users), update 토큰·현재
// active broadcast 채널 구독 수, 갱신 불가 카드를 경기별로 집계한다.

function getKSTDateStr(): string {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10).replace(/-/g, "");
}

function gameStatus(g: KboRawGame): "live" | "final" | "scheduled" | "cancelled" | "other" {
  if (isKboGameCancelled(g.CANCEL_SC_ID)) return "cancelled";
  if (g.GAME_STATE_SC === "3") return "final";
  if (g.GAME_STATE_SC === "2") return "live";
  if (g.GAME_STATE_SC === "1") return "scheduled";
  return "other";
}

// KBO 1.5s bounded → Naver failover 공용 SSOT(#985 계열, fetchKboLiveGames) 경유.
// 어드민 관제도 KBO 단독 열화 시 Naver 값으로 경기 상태를 보여주고, 두 소스 모두 실패할
// 때만 ok=false(fail-close) — 이때만 호출부가 "미상(unknown)" 폴백을 적용한다. KBO 200+빈
// 배열 soft-empty 는 SSOT 가 Naver 로 교차확인해 authoritative empty 로만 인정하고(검증
// 실패 시 ok=false), 검증 안 된 raw KBO 결과를 라이브로 오인하지 않는다.
// liveGamesImpl 은 결함주입 회귀(admin-live-activity-naver-failover-smoke)용 seam.
export async function fetchTodayGames(
  liveGamesImpl: typeof fetchKboLiveGames = fetchKboLiveGames,
): Promise<{ games: KboRawGame[]; ok: boolean }> {
  const { ok, games } = await liveGamesImpl(getKSTDateStr(), Date.now() + 5_000);
  return { games, ok };
}

interface CardRow {
  game_id: string;
  user_id: string;
}

interface StartedRow extends CardRow {
  // p2s payload에 channelId 내장 발송 성공한 *채널 세대*(서버 기록) — 현재 active
  // 채널과 정확 일치할 때만 broadcast 갱신 수신으로 인정(삼순 라운드2 — 출생 채널이
  // 재생성으로 교체된 카드는 gap 복귀). ⚠️ 마이그레이션 이전 행은 null(backfill 불가).
  channel_born_environment: string | null;
  channel_born_channel_id: string | null;
  // 무음 wake 첫 시도 시각 — 구제 성공률(시도 후 updatable 전환) 집계용.
  wake_attempted_at: string | null;
}

interface SubRow {
  game_id: string;
  user_id: string | null;
  device_key: string;
  environment: string;
  channel_id: string;
}

// Supabase는 요청당 기본 1000행 캡이 있어(무제한 select가 조용히 잘림 — #560 사고)
// 반드시 range 페이지네이션으로 전량을 모은다. game_id 내림차순(오늘 날짜가 접두라
// 최신이 먼저 옴) + 고유키 tie-breaker(페이지 경계 안정 정렬 — 동점 game_id 행이
// 페이지 사이에서 누락/중복되지 않게)로 정렬해서, 상한에 걸려도 과거 잔존행부터
// 잘리고 오늘 활성 경기 행은 항상 먼저 채워지도록 보장한다. 상한 도달 시
// truncated=true로 알린다. 테이블명은 정적 리터럴(query guard가 relation을 분류
// 가능하도록 — 삼순 재리뷰 2026-07-23, dynamic relation 구조적 해소).
const PAGE = 1000;
const MAX_PAGES = 30; // 현재 실측 ~1,900행 대비 15배 여유(3만 행)

async function fetchStartedRows(): Promise<{ rows: StartedRow[]; truncated: boolean }> {
  const rows: StartedRow[] = [];
  let truncated = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    // query-guard: bounded-page -- MAX_PAGES×1000행 상한 + (game_id desc, user_id) 안정 정렬 페이지
    const { data, error } = await supabase
      .from("live_activity_started_users")
      .select("game_id, user_id, channel_born_environment, channel_born_channel_id, wake_attempted_at")
      .order("game_id", { ascending: false })
      .order("user_id", { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw new Error(`live_activity_started_users: ${error.message}`);
    rows.push(...((data ?? []) as StartedRow[]));
    if (!data || data.length < PAGE) break;
    if (page === MAX_PAGES - 1) truncated = true;
  }
  return { rows, truncated };
}

async function fetchTokenRows(): Promise<{ rows: CardRow[]; truncated: boolean }> {
  const rows: CardRow[] = [];
  let truncated = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    // query-guard: bounded-page -- MAX_PAGES×1000행 상한 + (game_id desc, id) 안정 정렬 페이지
    const { data, error } = await supabase
      .from("live_activity_tokens")
      .select("game_id, user_id")
      .order("game_id", { ascending: false })
      .order("id", { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw new Error(`live_activity_tokens: ${error.message}`);
    rows.push(...((data ?? []) as CardRow[]));
    if (!data || data.length < PAGE) break;
    if (page === MAX_PAGES - 1) truncated = true;
  }
  return { rows, truncated };
}

// 채널 구독(SSOT: 네이티브 ACK만 기록) — build17+ 채널 카드는 update 토큰 없이
// broadcast로 갱신을 받으므로(#663이 채널 activity의 update 토큰 등록을 스킵)
// 갱신 수신 판정에 합산해야 '갱신 불가'가 과대계상되지 않는다.
async function fetchAllSubRows(): Promise<{ rows: SubRow[]; truncated: boolean }> {
  const PAGE = 1000;
  const MAX_PAGES = 30;
  const rows: SubRow[] = [];
  let truncated = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await supabase
      .from("live_activity_channel_subscriptions")
      .select("game_id, user_id, device_key, environment, channel_id")
      .order("game_id", { ascending: false })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw new Error(`live_activity_channel_subscriptions: ${error.message}`);
    rows.push(...((data ?? []) as SubRow[]));
    if (!data || data.length < PAGE) break;
    if (page === MAX_PAGES - 1) truncated = true;
  }
  return { rows, truncated };
}

// 현재 active broadcast 채널 — 구독 stale ACK 배제용(항상 수십~수백 행만 존재해
// 페이지네이션 불필요). status='active'만 사용(ending/deleted는 더 이상 갱신 안받음).
async function fetchActiveChannels(): Promise<ActiveChannelRef[]> {
  const { data, error } = await supabase
    .from("live_activity_channels")
    .select("game_id, environment, channel_id")
    .eq("status", "active");
  if (error) throw new Error(`live_activity_channels: ${error.message}`);
  return (data ?? []) as ActiveChannelRef[];
}

export async function GET(req: NextRequest) {
  if (!(await isAdminAuthedRequest(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const [p2sTotal, p2sFresh24h, p2sFresh7d, startedResult, tokenResult, subResult, channels, gamesResult] = await Promise.all([
      supabase.from("live_activity_start_tokens").select("*", { count: "exact", head: true }),
      supabase.from("live_activity_start_tokens").select("*", { count: "exact", head: true }).gte("updated_at", since24h),
      supabase.from("live_activity_start_tokens").select("*", { count: "exact", head: true }).gte("updated_at", since7d),
      fetchStartedRows(),
      fetchTokenRows(),
      fetchAllSubRows(),
      fetchActiveChannels(),
      fetchTodayGames(),
    ]);

    const startedRows = startedResult.rows;
    const tokenRows = tokenResult.rows;
    // active 채널 (game_id, environment, channel_id) 정확 일치 구독만 유효(stale ACK 배제).
    const activeKeys = activeChannelKeySet(channels);
    const subRows = subResult.rows.filter(r => isLiveChannelSubscription(r, activeKeys));
    const rowsTruncated = startedResult.truncated || tokenResult.truncated || subResult.truncated;
    const { games, ok: kboStatusAvailable } = gamesResult;

    const gameMeta = new Map<string, { label: string; status: string }>();
    for (const g of games) {
      if (!g.G_ID) continue;
      gameMeta.set(g.G_ID, {
        label: `${g.AWAY_NM ?? "?"} vs ${g.HOME_NM ?? "?"}`,
        status: gameStatus(g),
      });
    }

    // 경기별 집계: started(push-to-start로 뜬 카드) / tokens(update 토큰) /
    // channelUsers(현재 active 채널 ACK) / updatable(started ∩ (tokens ∪ channelUsers)).
    const byGame = new Map<string, { started: Set<string>; tokens: Set<string>; channelUsers: Set<string>; channelDevices: Set<string>; channelBorn: Set<string>; wakeAttempted: Set<string> }>();
    const entry = (gameId: string) => {
      let e = byGame.get(gameId);
      if (!e) {
        e = { started: new Set(), tokens: new Set(), channelUsers: new Set(), channelDevices: new Set(), channelBorn: new Set(), wakeAttempted: new Set() };
        byGame.set(gameId, e);
      }
      return e;
    };
    for (const r of startedRows) {
      const e = entry(r.game_id);
      e.started.add(r.user_id);
      // 채널 내장 출생 카드 — *출생 세대가 현재 active 채널과 정확 일치*할 때만 네이티브
      // ACK 없이도 broadcast 갱신 수신으로 합산(gap 과대계상 교정, 2026-07-23). 출생 채널이
      // 교체된 행은 gap으로 복귀 — wake 제외 판정(selectWakeGapRows)과 동일 기준(이중 기준 금지).
      if (isLiveBornChannel(r, activeKeys)) e.channelBorn.add(r.user_id);
      if (r.wake_attempted_at) e.wakeAttempted.add(r.user_id);
    }
    for (const r of tokenRows) entry(r.game_id).tokens.add(r.user_id);
    for (const r of subRows) {
      const e = entry(r.game_id);
      e.channelDevices.add(r.device_key);
      // user_id는 nullable — null이면 유저 매핑 불가라 갱신 수신 판정에서 제외
      // (보수적 집계 = 과소계상 쪽으로만 오차).
      if (r.user_id) e.channelUsers.add(r.user_id);
    }

    const todayStr = getKSTDateStr();
    const gamesOut = [...byGame.entries()]
      .map(([gameId, e]) => {
        const meta = gameMeta.get(gameId);
        const gameDate = gameId.slice(0, 8);
        const isStale = !meta && gameDate < todayStr;
        const started = e.started.size;
        const tokens = e.tokens.size;
        const channelSubs = e.channelDevices.size;
        const updatable = countUpdatableUsers({
          started: e.started,
          tokenUsers: e.tokens,
          channelAckUsers: e.channelUsers,
          channelBornUsers: e.channelBorn,
        });
        const gap = started - updatable;
        // wake 구제 성공 = 무음 wake 시도 후 update 토큰/채널 ACK가 등록된 유저
        // (유효 채널출생은 애초에 gap이 아니라 wake 대상이 아니므로 성공 판정에서 제외).
        const wakeAttempted = e.wakeAttempted.size;
        const wakeRescued = [...e.wakeAttempted].filter(u => e.tokens.has(u) || e.channelUsers.has(u)).length;
        return {
          gameId,
          label: meta?.label ?? gameId,
          // 오늘 KBO 목록에 없는 과거 game_id 잔존 행 = end 정리 미수신 좀비 후보.
          status: meta?.status ?? (isStale ? "stale" : "unknown"),
          started,
          tokens,
          channelSubs,
          // 채널 내장 출생 카드 수 — 별도 표기(오독 방지: ACK 없이도 updatable에 합산되는 분모).
          channelBorn: e.channelBorn.size,
          updatable,
          gap,
          wakeAttempted,
          wakeRescued,
          isStale,
        };
      })
      .sort((a, b) => b.gameId.localeCompare(a.gameId) || b.started - a.started);

    // 요약은 *활성 경기(진행중/예정)*만 집계한다. 종료 경기는 end 푸시 후 서버가
    // update 토큰을 정상 삭제하므로 gap이 커 보이는 게 당연하고(고장 아님), 과거
    // started_users 행은 삭제 없이 잔존하는 기록 잔재라 섞으면 수치가 오독된다.
    // "unknown"(오늘 날짜 game_id인데 KBO fetch 실패/meta 누락)은 활성으로 간주해
    // fallback 포함한다 — KBO가 흔들릴 때야말로 관제가 필요한데, 이 경우를 제외하면
    // 활성 카드가 있어도 요약이 0으로 보여 정반대로 오독된다.
    const isActiveStatus = (status: string) => status === "live" || status === "scheduled" || status === "unknown";
    const active = gamesOut.filter(g => isActiveStatus(g.status));
    const unknownActive = active.filter(g => g.status === "unknown");
    const cards = active.reduce((s, g) => s + g.started, 0);
    const updatable = active.reduce((s, g) => s + g.updatable, 0);
    const residualGames = gamesOut.filter(g => !isActiveStatus(g.status));
    const wakeAttempted = active.reduce((s, g) => s + g.wakeAttempted, 0);
    const wakeRescued = active.reduce((s, g) => s + g.wakeRescued, 0);

    return NextResponse.json({
      pushToStart: {
        total: p2sTotal.count ?? 0,
        fresh24h: p2sFresh24h.count ?? 0,
        fresh7d: p2sFresh7d.count ?? 0,
      },
      summary: {
        cards,
        updatable,
        gap: cards - updatable,
        updateTokens: active.reduce((s, g) => s + g.tokens, 0),
        channelSubs: active.reduce((s, g) => s + g.channelSubs, 0),
        channelBorn: active.reduce((s, g) => s + g.channelBorn, 0),
        // 무음 wake 계측(③) — attempted=첫 시도 기록된 카드, rescued=시도 후 토큰/ACK 전환.
        wakeAttempted,
        wakeRescued,
        residualRows: residualGames.reduce((s, g) => s + g.started + g.tokens, 0),
        residualGameCount: residualGames.length,
        kboStatusAvailable,
        unknownActiveCount: unknownActive.length,
        rowsTruncated,
      },
      games: gamesOut,
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
