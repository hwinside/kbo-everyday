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
function buildContentState(g: KboRawGame, status: "live" | "final"): Record<string, unknown> {
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

function gameStatus(g: KboRawGame): "live" | "final" | "other" {
  if (g.CANCEL_SC_ID !== "0") return "other";
  if (g.GAME_STATE_SC === "3") return "final";
  if (g.GAME_STATE_SC === "2") return "live";
  return "other";
}

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
          staleDate: nowSec + 5 * 60,
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
  staleDate: number;
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

  let sent = 0;
  let transientFail = false;
  const invalid: string[] = [];
  await Promise.all(
    [...tokenByUser.entries()].map(async ([userId, token]) => {
      if (optedOut.has(userId) || alreadyActive.has(userId)) return;
      const res = await sendLiveActivityPush(
        {
          pushToken: token,
          event: "start",
          attributesType: "KBOGameAttributes",
          attributes: { ...params.attributes, myTeamCode: params.myTeamCode },
          contentState: params.contentState,
          staleDate: params.staleDate,
        },
        params.jwt,
      );
      if (res.ok) sent += 1;
      else if (res.invalidToken) invalid.push(userId);
      else transientFail = true; // 일시 APNs 오류(무효 토큰 아님)
    }),
  );

  // 무효 push-to-start 토큰 정리(디바이스당 1개라 user_id로 삭제).
  for (const u of invalid) {
    await supabase.from("live_activity_start_tokens").delete().eq("user_id", u);
  }
  // 발송이 전부 일시 실패(0건 도달)면 인프라 실패로 보고 재시도. 일부라도 도달했으면
  // 재시도 시 도달분 중복 카드라 failed=false(부분 손실 감수, alreadyActive로 차후 보호).
  return { sent, failed: transientFail && sent === 0 };
}

/**
 * 라이브 경기 → 최애팀 팬의 push-to-start 토큰으로 자동 시작 푸시.
 * 게임 단위 1회 선점(live_activity_started insert)으로 중복 발송 차단.
 */
export async function pushLiveActivityStarts(
  games: KboRawGame[],
): Promise<{ started: number } | { error: string }> {
  if (!apnsConfigured()) return { started: 0 };

  const liveGames = games.filter((g) => gameStatus(g) === "live" && g.G_ID);
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

    // 게임 단위 1회 선점 — insert 성공한 호출만 발송(unique violation = 이미 처리됨).
    const { error: claimErr } = await supabase
      .from("live_activity_started")
      .insert({ game_id: gameId });
    if (claimErr) continue;

    // 윈도우 가드 — 너무 늦은 자동시작은 마킹만(이미 insert)하고 발송 skip.
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
    const contentState = buildContentState(g, "live");
    const staleDate = Math.floor(Date.now() / 1000) + 5 * 60;

    // away/home 슬롯을 각자 그 팀 코드로 강조(myTeamCode) — 수신자별 최애팀 반영.
    const awaySide = await startForTeamSide({
      gameId, teamId: teamIdByShortName(away), myTeamCode: awayCode,
      attributes, contentState, staleDate, jwt,
    });
    const homeSide = await startForTeamSide({
      gameId, teamId: teamIdByShortName(home), myTeamCode: homeCode,
      attributes, contentState, staleDate, jwt,
    });
    started += awaySide.sent + homeSide.sent;

    // 인프라 실패(쿼리/발송 오류)면 선점 해제 → 다음 cron 재시도. 경기당 트리거 윈도우가
    // 한 번뿐이라 일시 장애에 게임을 영구 누락하지 않게 함(삼순 NO-GO ②). 이미 도달한
    // 유저는 다음 cron에서 alreadyActive(update 토큰 등록분)로 자연 제외 → 중복 최소화.
    if (awaySide.failed || homeSide.failed) {
      await supabase.from("live_activity_started").delete().eq("game_id", gameId);
    }
  }

  return { started };
}
