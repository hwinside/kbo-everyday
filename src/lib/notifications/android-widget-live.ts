import { resolveCurrentPlayers } from "@/lib/kbo-player-mapping";
import { sendFcmToUsers } from "@/lib/notifications/fcm";
import { fansOfTeams, teamIdByShortName } from "@/lib/notifications/game-status";
import type { KboRawGame } from "@/types/api";

function safeInt(v: unknown): number {
  const n = parseInt(String(v ?? "0"), 10);
  return Number.isFinite(n) ? n : 0;
}

function clampOuts(v: unknown): string {
  return String(Math.min(Math.max(safeInt(v), 0), 2));
}

function parseTeamCodes(gameId: string): { away: string; home: string } | null {
  const m = gameId.match(/^\d{8}([A-Z]{2})([A-Z]{2})\d$/);
  return m ? { away: m[1], home: m[2] } : null;
}

function inningLabel(g: KboRawGame): string {
  const inning = safeInt(g.GAME_INN_NO);
  if (!inning) return "LIVE";
  return `LIVE ${inning}회${g.GAME_TB_SC === "T" ? "초" : "말"}`;
}

function diamond(g: KboRawGame): string {
  return `${safeInt(g.B1_BAT_ORDER_NO) > 0 ? 1 : 0}${safeInt(g.B2_BAT_ORDER_NO) > 0 ? 1 : 0}${safeInt(g.B3_BAT_ORDER_NO) > 0 ? 1 : 0}`;
}

/**
 * Android 홈 위젯/잠금 알림 카드 신선화.
 * warmup cron은 경기 중 매분 KBO 원천 데이터를 읽으므로, 득점 이벤트가 없어도
 * 이닝/아웃/주자/투수·타자/스코어를 data-only FCM으로 밀어 위젯 stale 시간을 줄인다.
 */
export async function pushAndroidWidgetLiveUpdates(games: KboRawGame[]): Promise<{
  games: number;
  sent: number;
  failed: number;
  cleaned: number;
  skipped: number;
}> {
  let liveGames = 0;
  let sent = 0;
  let failed = 0;
  let cleaned = 0;
  let skipped = 0;

  for (const g of games) {
    if (g.CANCEL_SC_ID !== "0" || g.GAME_STATE_SC !== "2" || !g.G_ID) continue;
    const codes = parseTeamCodes(g.G_ID);
    if (!codes) continue;
    liveGames += 1;

    const away = g.AWAY_NM ?? "";
    const home = g.HOME_NM ?? "";
    const teamIds = [teamIdByShortName(away), teamIdByShortName(home)]
      .filter((v): v is number => v !== null);
    const fans = await fansOfTeams(teamIds);
    if (!fans.ok) {
      failed += 1;
      continue;
    }

    const awayScore = safeInt(g.T_SCORE_CN);
    const homeScore = safeInt(g.B_SCORE_CN);
    const status = inningLabel(g);
    // 경기장(예: 잠실) 표기 — 홈 effect와 동일 포맷으로 맞춰 위젯 status flicker 방지
    const venue = g.S_NM ? ` · ${g.S_NM}` : "";
    const isTop = g.GAME_TB_SC === "T";
    const { currentBatter, currentPitcher } = resolveCurrentPlayers({
      tPlayerName: g.T_P_NM,
      bPlayerName: g.B_P_NM,
      gameTbSc: g.GAME_TB_SC,
    });

    const res = await sendFcmToUsers(fans.ids, {
      title: `${away} ${awayScore} : ${homeScore} ${home}`,
      body: status.replace(/^LIVE\s*/, "") || "경기 진행 중",
      url: `/games/${g.G_ID}`,
      dataOnly: true,
      data: {
        kind: "game_live",
        w_away: codes.away,
        w_home: codes.home,
        w_as: String(awayScore),
        w_hs: String(homeScore),
        w_status: `${status}${venue}`,
        w_pitcher: currentPitcher ?? "",
        w_pteam: currentPitcher ? (isTop ? codes.home : codes.away) : "",
        w_batter: currentBatter ?? "",
        w_bteam: currentBatter ? (isTop ? codes.away : codes.home) : "",
        w_outs: clampOuts(g.OUT_CN),
        w_diamond: diamond(g),
      },
    }, "game_start");

    sent += res.sent;
    failed += res.failed;
    cleaned += res.cleaned;
    skipped += res.skipped;
  }

  return { games: liveGames, sent, failed, cleaned, skipped };
}
