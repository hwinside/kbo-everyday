import { NextRequest, NextResponse } from "next/server";
import type { KboRawGame } from "@/types/api";
import type { GameEvent } from "@/types/game-events";
import { notifyGameStatusTransitions } from "@/lib/notifications/game-status";
import { notifyTeamRankChanges } from "@/lib/notifications/team-rank";
import { notifyScoreEvents, notifyInningSummaries } from "@/lib/notifications/game-score";
import { notifyPlayerHighlights } from "@/lib/notifications/player-highlight";
import { pushLiveActivityUpdates, pushLiveActivityStarts, pushLiveActivitySilentWakes } from "@/lib/notifications/live-activity";
import { ensureLiveActivityChannels, pushLiveActivityChannelBroadcasts } from "@/lib/notifications/live-activity-channels";
import { pushAndroidWidgetLiveUpdates } from "@/lib/notifications/android-widget-live";

/**
 * Warm up the in-memory prevState cache of /api/game-events for every
 * currently-live KBO game. Without this, the cache is only populated when
 * a client opens a game page, so any plays that happen between the actual
 * first pitch and the first client visit are emitted as `game_start` only —
 * the BoxScore stat lines accrued in that window never become events.
 *
 * Self-fetches the same game-events route used by clients so the warm-up
 * traverses the exact diff path; no parallel logic to keep in sync.
 */

const CRON_SECRET = process.env.CRON_SECRET || "";
const KBO_MAIN = "https://www.koreabaseball.com/ws/Main.asmx";

function getKSTDateStr(): string {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10).replace(/-/g, "");
}

// 잠금화면 Live Activity "중계 한 줄" 소스 — /api/game-relay 응답에서 최근 플레이 1줄 추출.
// innings는 시간순 오름차순(parseInningRelays), plays도 오름차순 → 마지막 non-empty 이닝의
// 마지막 play = 최신. 예: "안재석 삼진 아웃"(이닝은 상단 LIVE 표기와 중복이라 제외). 실패 시 null(카드 무영향).
type RelayLite = { innings?: { inning: number; half: string; plays?: { batterName: string; result: string }[] }[] };
function latestRelayLine(relay: unknown): string | null {
  const innings = (relay as RelayLite)?.innings;
  if (!Array.isArray(innings)) return null;
  let lastInn: { inning: number; half: string } | null = null;
  let lastPlay: { batterName: string; result: string } | null = null;
  for (const inn of innings) {
    if (inn?.plays && inn.plays.length > 0) {
      lastInn = inn;
      lastPlay = inn.plays[inn.plays.length - 1];
    }
  }
  if (!lastInn || !lastPlay || !lastPlay.batterName || !lastPlay.result) return null;
  // 이닝(N회초/말)은 카드 상단 LIVE 표기와 중복 → 타자 + 결과만 (하린아빠 승인 목업).
  const line = `${lastPlay.batterName} ${lastPlay.result}`;
  return line.length > 40 ? line.slice(0, 39) + "…" : line;
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const date = getKSTDateStr();

  // 2026-05-20: KBO가 Referer가 koreabaseball.com이 아닌 요청을 IE 에러 페이지로 막음.
  const liveRes = await fetch(`${KBO_MAIN}/GetKboGameList`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0 (compatible; KboEveryday/1.0)",
      "Referer": "https://www.koreabaseball.com/Schedule/ScoreBoard.aspx",
    },
    body: `leId=1&srId=0,1,3,4,5,7,8,9&date=${date}`,
    cache: "no-store",
  }).then(r => (r.ok ? r.json() : null)).catch(() => null);

  const games: KboRawGame[] = liveRes?.game || [];
  const liveGameIds = games
    .filter(g => g.GAME_STATE_SC === "2" && g.G_ID)
    .map(g => g.G_ID as string);

  // Self-fetch to traverse the same generateEvents path the client takes.
  // ⚠️ VERCEL_URL은 *배포별 URL*이라 Deployment Protection(인증)이 걸려 self-fetch가
  // 401로 막힐 수 있다(S5 득점/선수활약 알림이 조용히 0건 나던 원인). 따라서 보호가 없는
  // *공개 프로덕션 도메인* VERCEL_PROJECT_PRODUCTION_URL을 먼저 쓴다. (S4/Live Activity는
  // games를 직접 써서 self-fetch 의존이 없어 영향 없었음.)
  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL ??
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : req.nextUrl.origin);
  const results = await Promise.allSettled(
    liveGameIds.map(gameId =>
      fetch(`${baseUrl}/api/game-events?gameId=${gameId}`, {
        cache: "no-store",
        headers: { "User-Agent": "kbo-everyday-warmup/1.0" },
      }).then(async r => {
        const json = r.ok ? await r.json().catch(() => null) : null;
        const events = (json?.events ?? []) as GameEvent[];
        return { gameId, ok: r.ok, status: r.status, events, eventCount: r.ok ? events.length : null };
      }),
    ),
  );

  // self-fetch로 받은 game-events를 gameId별로 모음 (S5 득점 알림용)
  const eventsByGame = new Map<string, GameEvent[]>();
  for (const r of results) {
    if (r.status === "fulfilled" && r.value.ok) {
      eventsByGame.set(r.value.gameId, r.value.events);
    }
  }

  // 경기 시작/종료 푸시 (push-notifications-v1 S4) — 같은 게임 목록을 재사용.
  // 실패해도 warmup 본연의 동작(이벤트 캐시)에 영향 없음.
  let gameNotify: { started: number; ended: number } | { error: string } = { started: 0, ended: 0 };
  try {
    gameNotify = await notifyGameStatusTransitions(games);
  } catch (e) {
    gameNotify = { error: (e as Error).message };
    console.error("[warmup] game status notify failed:", (e as Error).message);
  }

  // 팀 순위 변동 푸시 — 순위가 바뀐 순간(옵션 A) 즉시 발송. 매분 standings를 직전 발송
  // 순위와 비교(별도 cron 불필요). 실패해도 warmup 본연 동작 무영향.
  let rankNotify: { changed: number } | { skipped: string } | { error: string } = { changed: 0 };
  try {
    rankNotify = await notifyTeamRankChanges();
  } catch (e) {
    rankNotify = { error: (e as Error).message };
    console.error("[warmup] team rank notify failed:", (e as Error).message);
  }

  // 내 팀 득점 푸시 (push-notifications-v1 S5a) — game-events의 득점 이벤트 기반.
  let scoreNotify: { scored: number; conceded: number } | { error: string } = { scored: 0, conceded: 0 };
  try {
    scoreNotify = await notifyScoreEvents(games, eventsByGame);
  } catch (e) {
    scoreNotify = { error: (e as Error).message };
    console.error("[warmup] score notify failed:", (e as Error).message);
  }

  // 이닝 득점 요약 푸시 (S5 — my_team_score_inning_summary). 이닝 종료 시 묶음 1건.
  let summaryNotify: { summarized: number } | { error: string } = { summarized: 0 };
  try {
    summaryNotify = await notifyInningSummaries(games, eventsByGame);
  } catch (e) {
    summaryNotify = { error: (e as Error).message };
    console.error("[warmup] inning summary notify failed:", (e as Error).message);
  }

  // Android 홈 위젯/잠금 알림 카드 신선화 — 득점 이벤트가 없어도 warmup cron의
  // 매분 KBO 원천 스냅샷으로 score/inning/out/runner/player 상태를 갱신한다.
  let androidWidget:
    | { games: number; sent: number; failed: number; cleaned: number; skipped: number }
    | { error: string } = { games: 0, sent: 0, failed: 0, cleaned: 0, skipped: 0 };
  try {
    androidWidget = await pushAndroidWidgetLiveUpdates(games, baseUrl);
  } catch (e) {
    androidWidget = { error: (e as Error).message };
    console.error("[warmup] android widget live update failed:", (e as Error).message);
  }

  // 최애선수 활약(타자) 푸시 (push-notifications-v1 S5b) — 장타/홈런 batter 매칭.
  let highlightNotify: { highlighted: number } | { error: string } = { highlighted: 0 };
  try {
    highlightNotify = await notifyPlayerHighlights(games, eventsByGame);
  } catch (e) {
    highlightNotify = { error: (e as Error).message };
    console.error("[warmup] highlight notify failed:", (e as Error).message);
  }

  // 잠금화면 Live Activity "중계 한 줄" 소스 — 라이브 경기의 네이버 문자중계 최근 플레이.
  // game-events self-fetch와 동일 패턴(공개 도메인 baseUrl, 병렬, 실패 격리). game-relay는
  // 서버 캐시가 있어 클라 폴링으로 대체로 warm. 실패/누락 시 그냥 생략 → 카드에 줄만 안 뜸.
  const lastPlayByGame = new Map<string, string>();
  try {
    const relayResults = await Promise.allSettled(
      liveGameIds.map(async (gameId) => {
        const r = await fetch(`${baseUrl}/api/game-relay?gameId=${gameId}`, {
          cache: "no-store",
          headers: { "User-Agent": "kbo-everyday-warmup/1.0" },
        });
        if (!r.ok) return null;
        const j = await r.json().catch(() => null);
        const line = latestRelayLine(j);
        return line ? { gameId, line } : null;
      }),
    );
    for (const r of relayResults) {
      if (r.status === "fulfilled" && r.value) lastPlayByGame.set(r.value.gameId, r.value.line);
    }
  } catch (e) {
    console.error("[warmup] relay lastPlay fetch failed:", (e as Error).message);
  }

  // Broadcast 채널 준비 (스펙 v4 §서버 2) — start 윈도우 경기에 env별 채널 생성(멱등).
  // p2s payload(input-push-channel)·인앱 채널 조회보다 먼저 존재해야 하므로 최우선 실행.
  let laChannels: { created: number } | { error: string } = { created: 0 };
  try {
    laChannels = await ensureLiveActivityChannels(games);
  } catch (e) {
    laChannels = { error: (e as Error).message };
    console.error("[warmup] la channel ensure failed:", (e as Error).message);
  }

  // 잠금화면 Live Activity 백그라운드 갱신 (W3a) — 같은 게임 목록 재사용.
  // APNs 직접 푸시. 미설정(APNS env 없음) 시 no-op. 실패해도 warmup 본연에 영향 없음.
  // 레거시(per-토큰) 갱신 — 채널 구독 확인 기기는 제외되고 아래 broadcast가 담당한다.
  // 이 함수가 채널 행의 지난 틱 상태(priority 판정)를 읽으므로 broadcast보다 먼저 실행.
  let liveActivity:
    | { pushed: number; ended: number; cleaned: number }
    | { error: string } = { pushed: 0, ended: 0, cleaned: 0 };
  try {
    // lastPlay(문자중계 한 줄) 재전달 — 단 payload 반영은 토큰 app_build 게이트(1.0.7+만
    // 풀 카드, 이하 슬림)가 결정한다. 2026-07-07 인시던트 핫픽스(#555)의 버전 게이트 대체.
    liveActivity = await pushLiveActivityUpdates(games, lastPlayByGame);
  } catch (e) {
    liveActivity = { error: (e as Error).message };
    console.error("[warmup] live activity push failed:", (e as Error).message);
  }

  // Broadcast 채널 갱신 (스펙 v4 §서버 5·6) — 라이브 = 경기당 1건 update(10/5/스킵),
  // 종료·취소 = end + backoff 재시도 → 8h 후 채널 DELETE. 구독 기기 전원 커버.
  let laBroadcast:
    | { updates: number; skipped: number; ends: number; deleted: number }
    | { error: string } = { updates: 0, skipped: 0, ends: 0, deleted: 0 };
  try {
    laBroadcast = await pushLiveActivityChannelBroadcasts(games, lastPlayByGame);
  } catch (e) {
    laBroadcast = { error: (e as Error).message };
    console.error("[warmup] la broadcast failed:", (e as Error).message);
  }

  // 잠금화면 Live Activity 자동 시작 (W3b) — 최애팀 경기 라이브 전환 시 push-to-start.
  // 게임 단위 1회 선점이라 매분 호출해도 중복 시작 없음. APNs 미설정 시 no-op.
  let liveActivityStart: { started: number } | { error: string } = { started: 0 };
  try {
    liveActivityStart = await pushLiveActivityStarts(games);
  } catch (e) {
    liveActivityStart = { error: (e as Error).message };
    console.error("[warmup] live activity start failed:", (e as Error).message);
  }

  // 잠금화면 Live Activity 무음 wake (Layer 2) — 카드는 떴는데 update 토큰이 없는 유저의
  // iOS 기기를 무음 푸시로 깨워 토큰 등록 유도(앱 안 열어도 갱신). FCM 무음이라 APNs와 무관.
  let liveActivityWake:
    | { woke: number; failed: number; skipped: number; cleaned: number; ok: boolean }
    | { error: string } = { woke: 0, failed: 0, skipped: 0, cleaned: 0, ok: true };
  try {
    liveActivityWake = await pushLiveActivitySilentWakes(games);
  } catch (e) {
    liveActivityWake = { error: (e as Error).message };
    console.error("[warmup] live activity wake failed:", (e as Error).message);
  }

  return NextResponse.json({
    date,
    polled: liveGameIds.length,
    liveGameIds,
    gameNotify,
    rankNotify,
    scoreNotify,
    summaryNotify,
    androidWidget,
    highlightNotify,
    liveActivity,
    laChannels,
    laBroadcast,
    liveActivityStart,
    liveActivityWake,
    lastPlays: Object.fromEntries(lastPlayByGame),
    results: results.map(r =>
      r.status === "fulfilled"
        ? { gameId: r.value.gameId, ok: r.value.ok, status: r.value.status, eventCount: r.value.eventCount }
        : { error: String(r.reason) },
    ),
  });
}
