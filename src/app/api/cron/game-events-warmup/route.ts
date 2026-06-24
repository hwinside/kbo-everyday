import { NextRequest, NextResponse } from "next/server";
import type { KboRawGame } from "@/types/api";
import type { GameEvent } from "@/types/game-events";
import { notifyGameStatusTransitions } from "@/lib/notifications/game-status";
import { notifyTeamRankChanges } from "@/lib/notifications/team-rank";
import { notifyScoreEvents, notifyInningSummaries } from "@/lib/notifications/game-score";
import { notifyPlayerHighlights } from "@/lib/notifications/player-highlight";
import { pushLiveActivityUpdates, pushLiveActivityStarts } from "@/lib/notifications/live-activity";
import { pushAndroidWidgetLiveUpdates } from "@/lib/notifications/android-widget-live";
import { captureMatchups, type CaptureResult } from "@/lib/matchup/capture";

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
  let scoreNotify: { scored: number } | { error: string } = { scored: 0 };
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
    androidWidget = await pushAndroidWidgetLiveUpdates(games);
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

  // 잠금화면 Live Activity 백그라운드 갱신 (W3a) — 같은 게임 목록 재사용.
  // APNs 직접 푸시. 미설정(APNS env 없음) 시 no-op. 실패해도 warmup 본연에 영향 없음.
  let liveActivity:
    | { pushed: number; ended: number; cleaned: number }
    | { error: string } = { pushed: 0, ended: 0, cleaned: 0 };
  try {
    liveActivity = await pushLiveActivityUpdates(games);
  } catch (e) {
    liveActivity = { error: (e as Error).message };
    console.error("[warmup] live activity push failed:", (e as Error).message);
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

  // 투타 통산 맞대결 V2 캡처 (Slice 1) — relay 현재 타석 통산값 upsert.
  // 같은 라이브 게임 목록 재사용. 실패해도 warmup 본연(알림)에 영향 없음.
  let matchupCapture: CaptureResult | { error: string } = { polled: 0, captured: 0, skipped: 0, failed: 0 };
  try {
    matchupCapture = await captureMatchups(liveGameIds);
  } catch (e) {
    matchupCapture = { error: (e as Error).message };
    console.error("[warmup] matchup capture failed:", (e as Error).message);
  }

  return NextResponse.json({
    date,
    polled: liveGameIds.length,
    liveGameIds,
    matchupCapture,
    gameNotify,
    rankNotify,
    scoreNotify,
    summaryNotify,
    androidWidget,
    highlightNotify,
    liveActivity,
    liveActivityStart,
    results: results.map(r =>
      r.status === "fulfilled"
        ? { gameId: r.value.gameId, ok: r.value.ok, status: r.value.status, eventCount: r.value.eventCount }
        : { error: String(r.reason) },
    ),
  });
}
