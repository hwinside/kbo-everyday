import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { resolveCurrentPlayers } from "@/lib/kbo-player-mapping";
import {
  apnsConfigured,
  getProviderTokenSafe,
  sendLiveActivityPush,
} from "@/lib/notifications/apns";
import { teamIdByShortName, fansOfTeams } from "@/lib/notifications/game-status";
import type { KboRawGame } from "@/types/api";

// Live Activity W3a — 백그라운드 실시간 갱신.
// warmup cron(매분)이 라이브 게임 상태를 들고 있으므로, 그 상태로 등록된 Live Activity
// 토큰에 APNs liveactivity 업데이트를 직접 보낸다. 잠금화면(앱 백그라운드)도 갱신됨.
// 종료된 경기는 end 푸시 + 토큰 정리. (APNs 미설정 시 전체 no-op)

/** ContentState — KBOGameAttributes.ContentState(Swift Codable) 키와 정확히 일치. */
function buildContentState(g: KboRawGame, status: "live" | "final" | "scheduled"): Record<string, unknown> {
  // 경기 전(scheduled) — 스코어/이닝/BSO/주자는 아직 없음. 예정 시각만 표시.
  if (status === "scheduled") {
    return {
      awayScore: 0, homeScore: 0, inning: 1, isTopInning: true,
      balls: 0, strikes: 0, outs: 0,
      onFirst: false, onSecond: false, onThird: false,
      pitcherName: "", batterName: "", stadium: g.S_NM ?? "",
      status: "scheduled",
      startTime: g.G_TM ? `${g.G_TM} 경기 예정` : "경기 예정",
    };
  }
  const players = resolveCurrentPlayers({
    tPlayerName: g.T_P_NM,
    bPlayerName: g.B_P_NM,
    gameTbSc: g.GAME_TB_SC,
  });
  return {
    awayScore: parseInt(g.T_SCORE_CN) || 0,
    homeScore: parseInt(g.B_SCORE_CN) || 0,
    inning: g.GAME_INN_NO && g.GAME_INN_NO > 0 ? g.GAME_INN_NO : 1,
    isTopInning: g.GAME_TB_SC === "T",
    balls: g.BALL_CN ?? 0,
    strikes: g.STRIKE_CN ?? 0,
    outs: g.OUT_CN ?? 0,
    onFirst: (g.B1_BAT_ORDER_NO ?? 0) > 0,
    onSecond: (g.B2_BAT_ORDER_NO ?? 0) > 0,
    onThird: (g.B3_BAT_ORDER_NO ?? 0) > 0,
    pitcherName: players.currentPitcher ?? "",
    batterName: players.currentBatter ?? "",
    stadium: g.S_NM ?? "",
    status,
  };
}

function gameStatus(g: KboRawGame): "live" | "final" | "scheduled" | "other" {
  if (g.CANCEL_SC_ID !== "0") return "other";
  if (g.GAME_STATE_SC === "3") return "final";
  if (g.GAME_STATE_SC === "2") return "live";
  if (g.GAME_STATE_SC === "1") return "scheduled";
  return "other";
}

// ⚠️ staleDate는 의도적으로 보내지 않는다(하린아빠 요구: "어떤 경우에도 스피너 금지").
// iOS는 stale-date를 지난 Live Activity에 시스템 스피너("outdated" 인디케이터)를 얹는데,
// update가 1분 cron·apns-expiration:0(못 꽂히면 폐기)이라 기기가 잠깐 unreachable이면 몇 틱
// 유실 → staleDate 초과 → 스피너. stale-date를 아예 안 실으면 iOS가 stale 판정할 근거가
// 없어 스피너가 원천 차단된다(네이버 라이브 액티비티와 동일 정책). 트레이드오프 = 서버 갱신이
// 완전히 죽으면 카드가 스피너 없이 옛 값으로 남음. 단 정상 종료는 별도 end 푸시로 처리됨.

interface TokenRow {
  user_id: string;
  game_id: string;
  push_token: string;
}

/**
 * 라이브 게임 → 등록된 Live Activity 토큰에 update 푸시.
 * 종료 게임 → end 푸시 + 토큰 삭제(잔상 15분 후 제거).
 */
export async function pushLiveActivityUpdates(
  games: KboRawGame[],
): Promise<{ pushed: number; ended: number; cleaned: number } | { error: string }> {
  if (!apnsConfigured()) return { pushed: 0, ended: 0, cleaned: 0 };

  // 푸시 대상 = 라이브 + 종료 경기. 종료는 토큰 있을 때만 end(반복 방지).
  const stateByGame = new Map<string, "live" | "final">();
  for (const g of games) {
    const s = gameStatus(g);
    if (s === "live" || s === "final") stateByGame.set(g.G_ID, s);
  }
  if (stateByGame.size === 0) return { pushed: 0, ended: 0, cleaned: 0 };

  const gameIds = [...stateByGame.keys()];
  const { data: tokens, error } = await supabase
    .from("live_activity_tokens")
    .select("user_id, game_id, push_token")
    .in("game_id", gameIds);
  if (error) return { error: error.message };
  if (!tokens || tokens.length === 0) return { pushed: 0, ended: 0, cleaned: 0 };

  // W3c 토글: "잠금화면 실시간 중계"를 끈 유저는 update 푸시에서 제외(row 없음/null = 디폴트 on).
  // end 푸시는 허용해 기존 카드/토큰을 정리한다. .in()은 URL 한도 회피 위해 200개 청크.
  const userIds = [...new Set((tokens as TokenRow[]).map((t) => t.user_id))];
  const optedOut = new Set<string>();
  for (let i = 0; i < userIds.length; i += 200) {
    const { data: prefRows } = await supabase
      .from("notification_prefs")
      .select("user_id, live_activity")
      .in("user_id", userIds.slice(i, i + 200));
    for (const r of (prefRows ?? []) as { user_id: string; live_activity: boolean | null }[]) {
      if (r.live_activity === false) optedOut.add(r.user_id);
    }
  }

  const jwt = await getProviderTokenSafe();
  if (!jwt) return { error: "apns provider token failed" };

  const gameById = new Map(games.map((g) => [g.G_ID, g]));
  const nowSec = Math.floor(Date.now() / 1000);

  let pushed = 0;
  let ended = 0;
  const invalidTokenIds: { user_id: string; game_id: string }[] = [];
  const endedTokenIds: { user_id: string; game_id: string }[] = [];

  await Promise.all(
    (tokens as TokenRow[]).map(async (t) => {
      const g = gameById.get(t.game_id);
      const status = stateByGame.get(t.game_id);
      if (!g || !status) return;
      const isEnd = status === "final";
      // 토글 off 유저: 실시간 update는 건너뛰고, end(카드/토큰 정리)만 진행.
      if (optedOut.has(t.user_id) && !isEnd) return;
      const res = await sendLiveActivityPush(
        {
          pushToken: t.push_token,
          event: isEnd ? "end" : "update",
          contentState: buildContentState(g, status),
          dismissalDate: isEnd ? nowSec + 15 * 60 : undefined,
          // staleDate 미전송 — 위 주석 참조(스피너 원천 차단).
          // collapse-id = 경기 id: update는 최신 1건만 보관(store-and-forward)되고, end가
          // 대기 중 update를 대체(종료 후 stale update 재생 방지).
          collapseId: t.game_id,
        },
        jwt,
      );
      if (res.ok) {
        if (isEnd) {
          ended += 1;
          endedTokenIds.push({ user_id: t.user_id, game_id: t.game_id });
        } else {
          pushed += 1;
        }
      } else if (res.invalidToken) {
        invalidTokenIds.push({ user_id: t.user_id, game_id: t.game_id });
      }
    }),
  );

  // 무효 토큰 + 종료 경기 토큰 정리.
  const toDelete = [...invalidTokenIds, ...endedTokenIds];
  let cleaned = 0;
  for (const d of toDelete) {
    const { error: delErr } = await supabase
      .from("live_activity_tokens")
      .delete()
      .eq("user_id", d.user_id)
      .eq("game_id", d.game_id);
    if (!delErr) cleaned += 1;
  }

  return { pushed, ended, cleaned };
}

// ── W3b — push-to-start 자동 시작 ──────────────────────────────────────────
// 최애팀 경기가 라이브로 전환되면, 앱을 안 열어도 잠금화면 Live Activity가 뜨도록
// 등록된 push-to-start 토큰으로 APNs event:start 푸시를 보낸다. 이후 갱신은 W3a.

// 시작 윈도우(game-status.ts와 동일 정책) — 한참 뒤 복구된 cron의 뒷북 자동시작 차단.
const START_WINDOW_MS = 90 * 60 * 1000;

/** G_DT("20260611") + G_TM("18:30", KST) → epoch ms. 파싱 실패 시 null (game-status.ts 동일) */
function scheduledStartMs(gDt: string | undefined, gTm: string | undefined): number | null {
  if (!gDt || !gTm || gDt.length !== 8 || !/^\d{2}:\d{2}$/.test(gTm)) return null;
  const y = +gDt.slice(0, 4), mo = +gDt.slice(4, 6), d = +gDt.slice(6, 8);
  const [hh, mm] = gTm.split(":").map(Number);
  return Date.UTC(y, mo - 1, d, hh - 9, mm);
}

/**
 * 한 팀 슬롯(away 또는 home)의 팬들에게 push-to-start. myTeamCode = 그 팀 코드(강조용).
 * 반환 failed=true = 인프라 오류(쿼리 실패 / 발송 전부 일시 실패) → 호출부가 선점 해제·재시도.
 * "수신 대상 0명"(legit zero)은 failed=false (선점 유지 — 재시도해도 의미 없음). 삼순 NO-GO ②.
 */
async function startForTeamSide(params: {
  gameId: string;
  teamId: number | null;
  myTeamCode: string;
  attributes: Record<string, unknown>;
  contentState: Record<string, unknown>;
  alert?: { title: string; body: string };
  jwt: string;
}): Promise<{ sent: number; failed: boolean }> {
  if (params.teamId === null) return { sent: 0, failed: false };
  const fans = await fansOfTeams([params.teamId]);
  if (!fans.ok) return { sent: 0, failed: true }; // 팬 조회 실패 → 재시도
  if (fans.ids.length === 0) return { sent: 0, failed: false };

  // push-to-start 토큰 보유 유저만. .in()은 URL 한도 회피 위해 200개 청크.
  const tokenByUser = new Map<string, string>();
  for (let i = 0; i < fans.ids.length; i += 200) {
    const { data, error } = await supabase
      .from("live_activity_start_tokens")
      .select("user_id, push_to_start_token")
      .in("user_id", fans.ids.slice(i, i + 200));
    if (error) return { sent: 0, failed: true }; // 토큰 조회 실패 → 재시도
    for (const r of (data ?? []) as { user_id: string; push_to_start_token: string }[]) {
      tokenByUser.set(r.user_id, r.push_to_start_token);
    }
  }
  if (tokenByUser.size === 0) return { sent: 0, failed: false };
  const candidateIds = [...tokenByUser.keys()];

  // W3c off 제외 (row 없음/null = 디폴트 on).
  const optedOut = new Set<string>();
  // 이미 이 경기 활성 토큰 보유(앱에서 직접 start 또는 원격 시작 후 update 토큰 등록) 제외 — 중복 카드 방지.
  const alreadyActive = new Set<string>();
  for (let i = 0; i < candidateIds.length; i += 200) {
    const chunk = candidateIds.slice(i, i + 200);
    const [{ data: prefRows, error: prefErr }, { data: activeRows, error: activeErr }] =
      await Promise.all([
        supabase.from("notification_prefs").select("user_id, live_activity").in("user_id", chunk),
        supabase
          .from("live_activity_tokens")
          .select("user_id")
          .eq("game_id", params.gameId)
          .in("user_id", chunk),
      ]);
    if (prefErr || activeErr) return { sent: 0, failed: true }; // pref/active 조회 실패 → 재시도
    for (const r of (prefRows ?? []) as { user_id: string; live_activity: boolean | null }[]) {
      if (r.live_activity === false) optedOut.add(r.user_id);
    }
    for (const r of (activeRows ?? []) as { user_id: string }[]) alreadyActive.add(r.user_id);
  }

  // 발송 대상 = 토큰 보유 & opt-out 아님 & 이미 활성 카드 없음.
  const eligible = [...tokenByUser.entries()].filter(
    ([userId]) => !optedOut.has(userId) && !alreadyActive.has(userId),
  );
  if (eligible.length === 0) return { sent: 0, failed: false };

  // 유저 단위 1회 선점 — (game_id, user_id) insert(ON CONFLICT DO NOTHING). 이미 발송한
  // 유저는 충돌로 제외되고 *새로 선점된 유저만* 반환된다. 게임 단위 선점과 달리 윈도우
  // 도중 늦게 등록된 토큰도 그 시점 cron이 처음 선점 → 발송된다.
  const claimed: { user_id: string }[] = [];
  for (let i = 0; i < eligible.length; i += 200) {
    const chunk = eligible.slice(i, i + 200);
    const { data, error } = await supabase
      .from("live_activity_started_users")
      .upsert(
        chunk.map(([userId]) => ({ game_id: params.gameId, user_id: userId })),
        { onConflict: "game_id,user_id", ignoreDuplicates: true },
      )
      .select("user_id");
    if (error) return { sent: 0, failed: true }; // 선점 실패 → 재시도
    claimed.push(...((data ?? []) as { user_id: string }[]));
  }
  if (claimed.length === 0) return { sent: 0, failed: false };
  const claimedSet = new Set(claimed.map((r) => r.user_id));
  const toSend = eligible.filter(([userId]) => claimedSet.has(userId));

  let sent = 0;
  let transientFail = false;
  const invalid: string[] = [];
  const releaseRetry: string[] = []; // 일시 실패 → 선점 해제(다음 cron 재시도)
  await Promise.all(
    toSend.map(async ([userId, token]) => {
      const res = await sendLiveActivityPush(
        {
          pushToken: token,
          event: "start",
          attributesType: "KBOGameAttributes",
          attributes: { ...params.attributes, myTeamCode: params.myTeamCode },
          contentState: params.contentState,
          // staleDate 미전송 — 스피너 원천 차단(파일 상단 주석 참조).
          alert: params.alert,
        },
        params.jwt,
      );
      if (res.ok) sent += 1;
      else if (res.invalidToken) invalid.push(userId);
      else {
        transientFail = true; // 일시 APNs 오류(무효 토큰 아님)
        releaseRetry.push(userId);
      }
    }),
  );

  // 무효 push-to-start 토큰 정리(디바이스당 1개라 user_id로 삭제).
  for (const u of invalid) {
    await supabase.from("live_activity_start_tokens").delete().eq("user_id", u);
  }
  // 선점 해제 = 일시 실패분 + 무효 토큰분. 일시 실패분은 다음 cron 재발송(영구 누락 방지).
  // 무효 토큰분도 반드시 해제 — 안 그러면 유저가 새 push-to-start 토큰을 재등록해도
  // (game_id,user_id) PK 충돌로 그 경기 start가 영구 skip된다(삼순 NO-GO). 도달분은 선점
  // 유지 → 다음 cron 충돌 제외 + alreadyActive(update 토큰)로 이중 보호 → 중복 카드 없음.
  for (const u of [...releaseRetry, ...invalid]) {
    await supabase
      .from("live_activity_started_users")
      .delete()
      .eq("game_id", params.gameId)
      .eq("user_id", u);
  }
  return { sent, failed: transientFail && sent === 0 };
}

/**
 * 라이브 경기 → 최애팀 팬의 push-to-start 토큰으로 자동 시작 푸시.
 * 유저 단위 1회 선점(live_activity_started_users)으로 중복 발송 차단 —
 * 윈도우 도중 늦게 등록된 push-to-start 토큰도 그 시점 cron이 픽업한다.
 */
export async function pushLiveActivityStarts(
  games: KboRawGame[],
): Promise<{ started: number } | { error: string }> {
  if (!apnsConfigured()) return { started: 0 };

  // 시작 대상 = 라이브 경기 + *경기 30분 전~시작* 윈도우의 예정 경기(미리 잠금화면 표시).
  const PREGAME_LEAD_MS = 30 * 60 * 1000;
  const liveGames = games.filter((g) => {
    if (!g.G_ID) return false;
    const st = gameStatus(g);
    if (st === "live") return true;
    if (st === "scheduled") {
      const ms = scheduledStartMs(g.G_DT, g.G_TM);
      if (ms === null) return false;
      const delta = ms - Date.now(); // 시작까지 남은 시간(양수=아직 전)
      return delta <= PREGAME_LEAD_MS && delta > -START_WINDOW_MS;
    }
    return false;
  });
  if (liveGames.length === 0) return { started: 0 };

  // jwt를 선점(insert) 전에 확보 — 토큰 발급 실패가 게임 선점을 소진(미발송으로 마킹)하지
  // 않게. 실패 시 아무 게임도 선점 안 하고 다음 cron에서 재시도.
  const jwt = await getProviderTokenSafe();
  if (!jwt) return { error: "apns provider token failed" };

  let started = 0;

  for (const g of liveGames) {
    const gameId = g.G_ID as string;
    const codes = gameId.match(/^\d{8}([A-Z]{2})([A-Z]{2})\d$/);
    if (!codes) continue;

    // 늦은 자동시작 가드 — 시작 후 START_WINDOW_MS 지난 경기는 발송 skip. 중복 발송
    // 차단은 startForTeamSide의 *유저 단위* 선점(live_activity_started_users)이 담당한다.
    // (게임 단위 선점은 제거 — 윈도우 도중 늦게 등록된 토큰을 영구 누락시켰음.)
    const startedAt = scheduledStartMs(g.G_DT, g.G_TM);
    if (startedAt !== null && Date.now() - startedAt > START_WINDOW_MS) continue;

    const away = g.AWAY_NM ?? "";
    const home = g.HOME_NM ?? "";
    const awayCode = codes[1];
    const homeCode = codes[2];
    const attributes = {
      gameId,
      awayTeam: away,
      homeTeam: home,
      awayTeamCode: awayCode,
      homeTeamCode: homeCode,
    };
    // 라이브면 live 스냅샷, 아직 시작 전이면 scheduled(예정 시각) 카드로 시작.
    const isLiveNow = gameStatus(g) === "live";
    const contentState = buildContentState(g, isLiveNow ? "live" : "scheduled");

    // push-to-start에 alert 동봉 — *무음*(alert 없는) push-to-start는 iOS가 잠금화면 카드를
    // 띄우지 않는다(실기기 확인 2026-06-26: 무음=미표시, alert=표시). 경기 30분 전 예정
    // 카드가 안 뜨던 직접 원인. alert가 표시 트리거 겸 "내 팀 경기 곧 시작" 배너 역할.
    const alert = {
      title: `⚾ ${away} vs ${home}`,
      body: isLiveNow
        ? "실시간 중계가 시작됐어요 — 잠금화면에서 확인하세요"
        : "곧 경기 시작! 잠금화면에서 실시간 중계를 확인하세요",
    };

    // away/home 슬롯을 각자 그 팀 코드로 강조(myTeamCode) — 수신자별 최애팀 반영.
    const awaySide = await startForTeamSide({
      gameId, teamId: teamIdByShortName(away), myTeamCode: awayCode,
      attributes, contentState, alert, jwt,
    });
    const homeSide = await startForTeamSide({
      gameId, teamId: teamIdByShortName(home), myTeamCode: homeCode,
      attributes, contentState, alert, jwt,
    });
    started += awaySide.sent + homeSide.sent;
    // 일시 실패분은 startForTeamSide에서 유저 단위로 선점 해제됨 → 다음 cron 재시도.
    // (이미 도달한 유저는 선점 유지 + alreadyActive로 이중 제외 → 중복 카드 없음.)
  }

  return { started };
}
