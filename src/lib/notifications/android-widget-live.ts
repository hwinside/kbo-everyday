import { resolveCurrentPlayers } from "@/lib/kbo-player-mapping";
import { isKboGameCancelled } from "@/lib/crawler/kbo-status";
import { sendFcmToUsers, WIDGET_STREAM, type PushPayload } from "@/lib/notifications/fcm";
import { fansOfTeams, teamIdByShortName } from "@/lib/notifications/game-status";
import { latestRelayLine } from "@/lib/notifications/relay-line";
import { isWidgetScoreRetreat } from "@/lib/notifications/ios-widget-policy";
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
// 지연 경기(KBO feed가 예정 상태로 남아 시작시각이 지난 경우) 커버 — iOS
// pushLiveActivityStarts와 동일하게 시작 후 90분까지 예정 카드를 계속 밀어 parity 유지.
const START_WINDOW_MS = 90 * 60 * 1000;
// 취소 카드 유지 창 — 예정시각 이후 이 시간까지 '경기 취소'를 밀어 저녁 내내 위젯을 갱신한다
// (그 후 앱 오픈/캐시 기기는 네이티브 readEff의 익일 06:00 롤오버로 다음 경기 전환,
//  push-only 기기는 다음 pregame push로 복구). 지연 후 늦은 취소도 커버.
const CANCEL_WINDOW_MS = 6 * 60 * 60 * 1000;

// fast-refresh(warmup 함수 내부 루프)용 변화 감지 — 라이브 위젯을 sub-minute로
// 갱신할 때 상태가 안 바뀌 경기는 추가 푸시를 건너뛰어 배터리/쿼터 부담을 막는다.
// 모듈 레벨 in-memory 캐시라 같은 서버리스 인스턴스의 사이클 간(그리고 warm 재사용
// 시 분 간)만 유효 — cold start면 비어서 무조건 발사(현행 동작 보존). 직전 payload.data 시그니처와 비교.
const lastWidgetSig = new Map<string, string>();
// 되감기 가드(#1311 삼순 B② 3축)용 — 경기별 마지막 발송 점수 "away|home".
const lastWidgetScore = new Map<string, string>();

/** 테스트 전용 — fast-refresh dedupe 캐시 초기화(프로덕션 미사용). */
export function __resetWidgetSigCacheForTest(): void {
  lastWidgetSig.clear();
  lastWidgetScore.clear();
}

/** 주입 가능 의존성 — QA 스모크가 supabase/FCM/network 없이 분기를 검증(삼순 #718 테스트 요구). */
export interface AndroidWidgetPushDeps {
  fansOfTeamsImpl?: typeof fansOfTeams;
  sendFcmImpl?: typeof sendFcmToUsers;
  fetchImpl?: typeof fetch;
}

/** dedupe 판정(순수) — dedupe=true이고 직전 시그니처와 동일하면 skip. cycle 0(dedupe=false)은 항상 발사. */
export function shouldSkipWidgetPush(prevSig: string | undefined, currentSig: string, dedupe: boolean): boolean {
  return dedupe === true && prevSig !== undefined && prevSig === currentSig;
}

// dedupe에 포함하면 안 되는 순서/시간 메타 — 매 사이클 값이 바뀌면 무변화 skip이 깨진다(삼순).
const WIDGET_SIG_OMIT = new Set(["w_source_at", "w_fetched_at"]);

/**
 * canonical 상태 시그니처 — 순서 메타(w_source_at)를 제외한 경기 필드만으로 계산.
 * 워치 push bridge out-of-order 방어용 w_source_at를 payload에 싣으되, dedupe는 이 canonical로
 * 판정해야 매 사이클 무변화 skip이 유지된다(JSON.stringify 전체를 쓰면 sourceAt로 깨짐).
 */
export function widgetStateSignature(data: Record<string, unknown>): string {
  const canonical: Record<string, unknown> = {};
  for (const k of Object.keys(data).sort()) {
    if (!WIDGET_SIG_OMIT.has(k)) canonical[k] = data[k];
  }
  return JSON.stringify(canonical);
}

/**
 * Android 홈 위젯/잠금 알림 카드 신선화 + 경기 전 미리 표시.
 * warmup cron은 경기 시간대 매분 KBO 원천 데이터를 읽으므로:
 *  - 라이브(GAME_STATE_SC="2"): 이닝/아웃/주자/투수·타자/스코어를 data-only FCM으로 밀어 stale 최소화.
 *  - 예정(GAME_STATE_SC="1")이고 시작 30분 전 이내: '경기 예정' 매치업 카드를 미리 띄운다(iOS 패리티).
 * 네이티브 알림은 setOnlyAlertOnce라 같은 카드를 매분 갱신해도 재알림 없이 조용히 갱신된다.
 */
export async function pushAndroidWidgetLiveUpdates(
  games: KboRawGame[],
  baseUrl: string,
  opts?: {
    dedupeAgainstLast?: boolean;
    deadlineAtMs?: number;
    sourceAtMs?: number;
    fetchedAtMs?: number;
  },
  deps?: AndroidWidgetPushDeps,
): Promise<{
  games: number;
  sent: number;
  failed: number;
  cleaned: number;
  skipped: number;
  retryableFailed: number;
}> {
  const dedupe = opts?.dedupeAgainstLast === true;
  const deadlineAtMs = opts?.deadlineAtMs;
  const fansOf = deps?.fansOfTeamsImpl ?? fansOfTeams;
  const sendFcm = deps?.sendFcmImpl ?? sendFcmToUsers;
  const fetchFn = deps?.fetchImpl ?? fetch;
  const sourceAtMs = opts?.sourceAtMs ?? Date.now();
  const fetchedAtMs = opts?.fetchedAtMs ?? sourceAtMs;
  let pushed = 0;
  let sent = 0;
  let failed = 0;
  let cleaned = 0;
  let skipped = 0;
  let retryableFailed = 0;

  // 라이브 경기 문자중계 최근 플레이 한 줄 — game-relay self-fetch(공개 도메인 baseUrl, 병렬,
  // 실패 격리). iOS 잠금 LA와 동일 소스/문구(relay-line.ts). 실패·누락 시 위젯에 줄만 안 뜸.
  const lastPlayByGame = new Map<string, string>();
  const liveIds = games
    .filter((g) => g.G_ID && g.GAME_STATE_SC === "2")
    .map((g) => g.G_ID as string);
  // deadline(요청 진입 기준 절대값)이 지나면 relay를 시작하지 않고, 진행 시에도 남은
  // 시간만큼 abort timeout을 걸어 완료까지 deadline 안에 묶는다(삼순 blocker①).
  const relayBudgetMs = deadlineAtMs != null ? deadlineAtMs - Date.now() : null;
  if (liveIds.length > 0 && (relayBudgetMs == null || relayBudgetMs > 0)) {
    const relays = await Promise.allSettled(
      liveIds.map(async (gameId) => {
        const r = await fetchFn(`${baseUrl}/api/game-relay?gameId=${gameId}`, {
          cache: "no-store",
          headers: { "User-Agent": "kbo-everyday-widget/1.0" },
          ...(relayBudgetMs != null ? { signal: AbortSignal.timeout(relayBudgetMs) } : {}),
        });
        if (!r.ok) return null;
        const j = await r.json().catch(() => null);
        const line = latestRelayLine(j);
        return line ? { gameId, line } : null;
      }),
    );
    for (const res of relays) {
      if (res.status === "fulfilled" && res.value) {
        lastPlayByGame.set(res.value.gameId, res.value.line);
      }
    }
  }

  for (const g of games) {
    if (!g.G_ID) continue;
    // deadline 도달 — 남은 경기의 FCM 발사를 시작하지 않는다(다음 크론 틱과 겹침 방지).
    if (deadlineAtMs != null && Date.now() >= deadlineAtMs) break;

    const isLive = g.GAME_STATE_SC === "2";
    const isCancelled = isKboGameCancelled(g.CANCEL_SC_ID);
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
    const fans = await fansOf(teamIds, { deadlineAtMs });
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
        // terminal 상태 — 긴 TTL(장시간 오프라인 복귀에도 취소 상태 배달, 삼순 #649 blocker②).
        ...WIDGET_STREAM.terminal,
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
          w_source_at: String(sourceAtMs),
          w_fetched_at: String(fetchedAtMs),
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
        // live tick — 딥슬립 복귀 시 백로그 대신 최신 1건만 배달, 90s 후 자동 폐기(다음 틱이 덮어씀).
        ...WIDGET_STREAM.live,
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
          w_lastplay: lastPlayByGame.get(g.G_ID) ?? "",
          // 워치 push bridge(#719) 순서 기준 — FCM 재정렬에도 강건. dedupe canonical에서는 제외.
          w_source_at: String(sourceAtMs),
          w_fetched_at: String(fetchedAtMs),
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
        // pregame도 매분 반복이라 live tick과 동일 정책(다음 틱/라이브 전환이 곧 덮어씀).
        ...WIDGET_STREAM.live,
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
          w_source_at: String(sourceAtMs),
          w_fetched_at: String(fetchedAtMs),
        },
      };
    }

    // 되감기 가드(#1311 삼순 B② 3축 적용): live 점수가 직전 발송보다 뒤로 가면 skip.
    // Naver→KBO(stale) fallback 틱이 위젯 점수를 8→5로 되감는 걸 막는다(점수는 단조).
    if (isLive) {
      const scoreKey = `${safeInt(g.T_SCORE_CN)}|${safeInt(g.B_SCORE_CN)}`;
      const prevScore = lastWidgetScore.get(g.G_ID as string);
      if (prevScore !== undefined && isWidgetScoreRetreat(prevScore, scoreKey)) {
        skipped += fans.ids.length;
        continue;
      }
    }
    // fast-refresh 추가 사이클 — canonical 상태(w_source_at 제외) 미변경이면 재발사 생략(배터리 보호).
    const sig = widgetStateSignature(payload.data as Record<string, unknown>);
    if (shouldSkipWidgetPush(lastWidgetSig.get(g.G_ID as string), sig, dedupe)) {
      skipped += fans.ids.length;
      continue;
    }
    // 안드 위젯/워치 브릿지 전용 data 푸시라 platform="android"로 iOS 토큰 조회를 제외한다
    // (삼순 blocker④ — iOS는 별도 pushIosWidgetLiveUpdates가 담당, 무관 토큰 발송 제거).
    const res = await sendFcm(
      fans.ids,
      payload,
      "game_start",
      "android",
      { deadlineAtMs },
    );
    // FCM 인프라 성공(res.ok) 확인 후에만 시그니처 기록 — 실패 시 다음 사이클이 동일 상태를
    // 재시도할 수 있게 한다(삼순 blocker③ — 실패 dedupe 오염 방지).
    const transientFailed = res.retryableFailed ?? 0;
    if (res.ok && transientFailed === 0) {
      lastWidgetSig.set(g.G_ID as string, sig);
      if (isLive) {
        lastWidgetScore.set(g.G_ID as string, `${safeInt(g.T_SCORE_CN)}|${safeInt(g.B_SCORE_CN)}`);
      }
    }
    sent += res.sent;
    failed += res.failed;
    cleaned += res.cleaned;
    skipped += res.skipped;
    retryableFailed += transientFailed;
    console.info("[widget-pipeline]", JSON.stringify({
      gameId: g.G_ID,
      sourceAtMs,
      fetchedAtMs,
      sendStartedAtMs: res.sendStartedAtMs ?? null,
      sendCompletedAtMs: res.sendCompletedAtMs ?? null,
      sourceToFetchMs: Math.max(0, fetchedAtMs - sourceAtMs),
      fetchToSendMs: res.sendStartedAtMs == null ? null : Math.max(0, res.sendStartedAtMs - fetchedAtMs),
      sent: res.sent,
      failed: res.failed,
      retryableFailed: transientFailed,
      ok: res.ok,
    }));
  }

  return { games: pushed, sent, failed, cleaned, skipped, retryableFailed };
}
