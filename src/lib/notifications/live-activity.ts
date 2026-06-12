import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { resolveCurrentPlayers } from "@/lib/kbo-player-mapping";
import {
  apnsConfigured,
  getProviderTokenSafe,
  sendLiveActivityPush,
} from "@/lib/notifications/apns";
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
