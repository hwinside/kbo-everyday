import { resolveCurrentPlayers } from "@/lib/kbo-player-mapping";
import { sendFcmToUsers, type PushPayload } from "@/lib/notifications/fcm";
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

/** G_DT("20260611") + G_TM("18:30", KST) → epoch ms. 파싱 실패 시 null. game-status.ts와 동일 로직. */
function scheduledStartMs(gDt: string | undefined, gTm: string | undefined): number | null {
  if (!gDt || !gTm || gDt.length !== 8 || !/^\d{2}:\d{2}$/.test(gTm)) return null;
  const y = +gDt.slice(0, 4), mo = +gDt.slice(4, 6), d = +gDt.slice(6, 8);
  const [hh, mm] = gTm.split(":").map(Number);
  return Date.UTC(y, mo - 1, d, hh - 9, mm); // KST(UTC+9) wall-clock → UTC epoch
}

// 경기 시작 30분 전부터 잠금화면/홈위젯에 '경기 예정' 카드를 미리 띄운다.
// iOS Live Activity push-to-start(PREGAME_LEAD_MS 동일 30분)와 리드타임을 맞춘 것.
const PREGAME_LEAD_MS = 30 * 60 * 1000;
// 지연 경기(우천 등으로 KBO feed가 예정 상태로 남아 시작시각이 지난 경우) 커버 — iOS
// pushLiveActivityStarts와 동일하게 시작 후 90분까지 예정 카드를 계속 밀어 parity 유지.
const START_WINDOW_MS = 90 * 60 * 1000;
// 취소 카드 유지 창 — 예정시각 이후 이 시간까지 '경기 취소'를 밀어 저녁 내내 위젯을 갱신한다
// (그 후엔 네이티브 readEff의 익일 06:00 롤오버가 다음 경기로 전환). 지연 후 늦은 취소도 커버.
const CANCEL_WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * Android 홈 위젯/잠금 알림 카드 신선화 + 경기 전 미리 표시.
 * warmup cron은 경기 시간대 매분 KBO 원천 데이터를 읽으므로:
 *  - 라이브(GAME_STATE_SC="2"): 이닝/아웃/주자/투수·타자/스코어를 data-only FCM으로 밀어 stale 최소화.
 *  - 예정(GAME_STATE_SC="1")이고 시작 30분 전 이내: '경기 예정' 매치업 카드를 미리 띄운다(iOS 패리티).
 * 네이티브 알림은 setOnlyAlertOnce라 같은 카드를 매분 갱신해도 재알림 없이 조용히 갱신된다.
 */
export async function pushAndroidWidgetLiveUpdates(games: KboRawGame[]): Promise<{
  games: number;
  sent: number;
  failed: number;
  cleaned: number;
  skipped: number;
}> {
  let pushed = 0;
  let sent = 0;
  let failed = 0;
  let cleaned = 0;
  let skipped = 0;

  for (const g of games) {
    if (!g.G_ID) continue;

    const isLive = g.GAME_STATE_SC === "2";
    const isCancelled = g.CANCEL_SC_ID !== "0";
    // 취소: 예정시각 −30분 ~ +CANCEL_WINDOW_MS 창이면 '경기 취소' 카드를 밀어 앱 미오픈
    // 상태에서도 안드 위젯을 갱신(iOS 홈위젯은 백그라운드 갱신 불가라 안드 전용 이점). 창 후엔
    // 위젯이 마지막 상태 유지 → 앱 오픈으로 next 캐시된 기기는 익일 06:00 롤오버로 다음 경기
    // 전환, push-only 기기는 다음 경기 pregame push가 덮어써 자연 복구(서버는 양팀 팬 공용
    // 브로드캐스트라 per-기기 next를 실을 수 없음).
    let isCancelWindow = false;
    if (isCancelled) {
      const startMs = scheduledStartMs(g.G_DT, g.G_TM);
      if (startMs !== null) {
        const since = Date.now() - startMs;
        isCancelWindow = since > -PREGAME_LEAD_MS && since <= CANCEL_WINDOW_MS;
      }
    }
    // 예정 경기는 '시작 30분 전 ~ 시작 후 90분(지연 경기)' 윈도우일 때만 미리 표시(그 밖엔 skip).
    // iOS pushLiveActivityStarts와 동일 조건: delta <= PREGAME_LEAD_MS && delta > -START_WINDOW_MS.
    let isPregame = false;
    if (!isLive && !isCancelled && g.GAME_STATE_SC === "1") {
      const startMs = scheduledStartMs(g.G_DT, g.G_TM);
      if (startMs !== null) {
        const untilStart = startMs - Date.now();
        isPregame = untilStart <= PREGAME_LEAD_MS && untilStart > -START_WINDOW_MS;
      }
    }
    if (!isLive && !isPregame && !isCancelWindow) continue;

    const codes = parseTeamCodes(g.G_ID);
    if (!codes) continue;
    pushed += 1;

    const away = g.AWAY_NM ?? "";
    const home = g.HOME_NM ?? "";
    const teamIds = [teamIdByShortName(away), teamIdByShortName(home)]
      .filter((v): v is number => v !== null);
    const fans = await fansOfTeams(teamIds);
    if (!fans.ok) {
      failed += 1;
      continue;
    }

    let payload: PushPayload;
    if (isCancelWindow) {
      // 경기 취소 — kind:"game_cancel"로 보낸다(game_live 아님). 네이티브는 이 kind를 받으면
      // 홈위젯 prefs만 "경기 취소"(CANCELLED)로 갱신하고, 잠금화면 진행중 알림은 post하지
      // 않고 clear한다(정책: 잠금화면은 정리, 홈위젯은 유지 — 삼순 blocker②).
      // writeAndRefresh는 next를 건드리지 않아(같은 gameId) 앱 오픈으로 캐시된 next가 있으면
      // 06:00 롤오버가 유지되고, push-only 기기는 다음 경기 pregame push가 위젯을 덮어써
      // 자연 복구된다(서버 브로드캐스트는 양팀 팬 공용이라 per-기기 next를 실을 수 없음 — 삼순
      // blocker③). dataOnly라 시스템 알림은 안 뜨고 위젯만 조용히 갱신
      // (사용자向 ⚾ 경기 취소 알림은 game-status.ts가 별도 발송).
      payload = {
        title: `⚾ ${away} vs ${home}`,
        body: "오늘 경기가 취소됐어요",
        url: `/games/${g.G_ID}`,
        dataOnly: true,
        data: {
          kind: "game_cancel",
          w_away: codes.away,
          w_home: codes.home,
          w_as: "0",
          w_hs: "0",
          w_status: "CANCELLED",
          w_pitcher: "",
          w_pteam: "",
          w_batter: "",
          w_bteam: "",
          w_outs: "",
          w_diamond: "000",
          w_stadium: g.S_NM ?? "",
        },
      };
    } else if (isLive) {
      const awayScore = safeInt(g.T_SCORE_CN);
      const homeScore = safeInt(g.B_SCORE_CN);
      const status = inningLabel(g);
      const isTop = g.GAME_TB_SC === "T";
      const { currentBatter, currentPitcher } = resolveCurrentPlayers({
        tPlayerName: g.T_P_NM,
        bPlayerName: g.B_P_NM,
        gameTbSc: g.GAME_TB_SC,
      });
      payload = {
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
          w_status: status,
          w_pitcher: currentPitcher ?? "",
          w_pteam: currentPitcher ? (isTop ? codes.home : codes.away) : "",
          w_batter: currentBatter ?? "",
          w_bteam: currentBatter ? (isTop ? codes.away : codes.home) : "",
          w_outs: clampOuts(g.OUT_CN),
          w_diamond: diamond(g),
          w_stadium: g.S_NM ?? "",
        },
      };
    } else {
      // 경기 전 — 점수/이닝/주자/투수·타자 없음. 네이티브 buildCard가 status
      // "SCHEDULED|<시각>|<날짜라벨>"를 받으면 점수를 숨기고 '경기 예정' + 시각 pill을
      // 그린다(당일 경기라 날짜라벨 생략).
      payload = {
        title: `⚾ ${away} vs ${home}`,
        body: "곧 경기 시작! 잠금화면에서 실시간 중계를 확인하세요",
        url: `/games/${g.G_ID}`,
        dataOnly: true,
        data: {
          kind: "game_live",
          w_away: codes.away,
          w_home: codes.home,
          w_as: "0",
          w_hs: "0",
          w_status: `SCHEDULED|${g.G_TM ?? ""}`,
          w_pitcher: "",
          w_pteam: "",
          w_batter: "",
          w_bteam: "",
          w_outs: "",
          w_diamond: "000",
          w_stadium: g.S_NM ?? "",
        },
      };
    }

    const res = await sendFcmToUsers(fans.ids, payload, "game_start");
    sent += res.sent;
    failed += res.failed;
    cleaned += res.cleaned;
    skipped += res.skipped;
  }

  return { games: pushed, sent, failed, cleaned, skipped };
}
