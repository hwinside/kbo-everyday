import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { isAdminRequest } from "@/lib/admin/pin";
import {
  activeChannelKeySet,
  isLiveChannelSubscription,
  type ActiveChannelRef,
} from "@/lib/notifications/live-activity-channel-policy";
import type { KboRawGame } from "@/types/api";

// 어드민 — Live Activity 토큰/카드 종합 현황.
// 발급된 push-to-start 토큰 수, 떠있는 잠금화면(started_users), update 토큰·현재
// active broadcast 채널 구독 수, 갱신 불가 카드를 경기별로 집계한다.

const KBO_MAIN = "https://www.koreabaseball.com/ws/Main.asmx";

function getKSTDateStr(): string {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10).replace(/-/g, "");
}

function gameStatus(g: KboRawGame): "live" | "final" | "scheduled" | "cancelled" | "other" {
  if (g.CANCEL_SC_ID !== "0") return "cancelled";
  if (g.GAME_STATE_SC === "3") return "final";
  if (g.GAME_STATE_SC === "2") return "live";
  if (g.GAME_STATE_SC === "1") return "scheduled";
  return "other";
}

// ok=false는 fetch 자체가 실패(네트워크/non-200/파싱 오류)했음을 뜻한다 — 이때는
// 오늘 경기 상태를 KBO에서 확인할 수 없으므로 호출부가 "미상" 폴백을 적용해야 한다.
async function fetchTodayGames(): Promise<{ games: KboRawGame[]; ok: boolean }> {
  // 2026-05-20: KBO가 Referer가 koreabaseball.com이 아닌 요청을 IE 에러 페이지로 막음.
  const res = await fetch(`${KBO_MAIN}/GetKboGameList`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0 (compatible; KboEveryday/1.0)",
      "Referer": "https://www.koreabaseball.com/Schedule/ScoreBoard.aspx",
    },
    body: `leId=1&srId=0,1,3,4,5,7,8,9&date=${getKSTDateStr()}`,
    cache: "no-store",
  }).then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (res === null) return { games: [], ok: false };
  return { games: (res.game ?? []) as KboRawGame[], ok: true };
}

interface CardRow {
  game_id: string;
  user_id: string;
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
// 최신이 먼저 옴)으로 정렬해서, 상한에 걸려도 과거 잔존행부터 잘리고 오늘 활성
// 경기 행은 항상 먼저 채워지도록 보장한다. 상한 도달 시 truncated=true로 알린다.
async function fetchAllRows(table: string): Promise<{ rows: CardRow[]; truncated: boolean }> {
  const PAGE = 1000;
  const MAX_PAGES = 30; // 현재 실측 ~1,900행 대비 15배 여유(3만 행)
  const rows: CardRow[] = [];
  let truncated = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await supabase
      .from(table)
      .select("game_id, user_id")
      .order("game_id", { ascending: false })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
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
  if (!isAdminRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const [p2sTotal, p2sFresh24h, p2sFresh7d, startedResult, tokenResult, subResult, channels, gamesResult] = await Promise.all([
      supabase.from("live_activity_start_tokens").select("*", { count: "exact", head: true }),
      supabase.from("live_activity_start_tokens").select("*", { count: "exact", head: true }).gte("updated_at", since24h),
      supabase.from("live_activity_start_tokens").select("*", { count: "exact", head: true }).gte("updated_at", since7d),
      fetchAllRows("live_activity_started_users"),
      fetchAllRows("live_activity_tokens"),
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
    const byGame = new Map<string, { started: Set<string>; tokens: Set<string>; channelUsers: Set<string>; channelDevices: Set<string> }>();
    const entry = (gameId: string) => {
      let e = byGame.get(gameId);
      if (!e) {
        e = { started: new Set(), tokens: new Set(), channelUsers: new Set(), channelDevices: new Set() };
        byGame.set(gameId, e);
      }
      return e;
    };
    for (const r of startedRows) entry(r.game_id).started.add(r.user_id);
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
        const updatable = [...e.started].filter(u => e.tokens.has(u) || e.channelUsers.has(u)).length;
        const gap = started - updatable;
        return {
          gameId,
          label: meta?.label ?? gameId,
          // 오늘 KBO 목록에 없는 과거 game_id 잔존 행 = end 정리 미수신 좀비 후보.
          status: meta?.status ?? (isStale ? "stale" : "unknown"),
          started,
          tokens,
          channelSubs,
          updatable,
          gap,
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
