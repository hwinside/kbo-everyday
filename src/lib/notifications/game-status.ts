import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { sendFcmToUsers } from "@/lib/notifications/fcm";
import { TEAMS } from "@/lib/constants/teams";
import type { KboRawGame } from "@/types/api";

// 경기 시작/종료 알림 (push-notifications-v1 S4).
// warmup cron(경기 시간대 매분)이 호출. 중복 발화 방지 = game_notify_state
// 조건부 UPDATE 선점 — 다중 인스턴스가 동시에 돌아도 발송은 1회.

function teamIdByShortName(name: string): number | null {
  const t = TEAMS.find((t) => t.shortName === name);
  return t?.id ?? null;
}

/** 양팀을 최애팀으로 둔 유저 id 목록 */
async function fansOfTeams(teamIds: number[]): Promise<string[]> {
  if (teamIds.length === 0) return [];
  const { data, error } = await supabase.from("profiles").select("id").in("team_id", teamIds);
  if (error) {
    console.error("[game-status] fans query failed:", error.message);
    return [];
  }
  return (data ?? []).map((r: { id: string }) => r.id);
}

/**
 * 알림 권한 선점 — 해당 플래그가 false인 행을 true로 바꾸는 데 성공한
 * 호출만 발송 자격을 가짐 (semantic key = game_id + 플래그).
 */
async function claim(gameId: string, flag: "start_notified" | "end_notified"): Promise<boolean> {
  // 행 보장 (이미 있으면 no-op)
  const { error: insertErr } = await supabase
    .from("game_notify_state")
    .upsert({ game_id: gameId }, { onConflict: "game_id", ignoreDuplicates: true });
  if (insertErr) {
    console.error("[game-status] state upsert failed:", insertErr.message);
    return false;
  }
  const { data, error } = await supabase
    .from("game_notify_state")
    .update({ [flag]: true, updated_at: new Date().toISOString() })
    .eq("game_id", gameId)
    .eq(flag, false)
    .select("game_id");
  if (error) {
    console.error("[game-status] claim failed:", error.message);
    return false;
  }
  return (data ?? []).length > 0; // 0행 = 이미 다른 호출이 발송함
}

/** 도입 직후/과거 경기 보호 — 발송 없이 플래그만 마킹 */
async function markOnly(gameId: string, flags: { start?: boolean; end?: boolean }): Promise<void> {
  await supabase.from("game_notify_state").upsert({
    game_id: gameId,
    ...(flags.start ? { start_notified: true } : {}),
    ...(flags.end ? { end_notified: true } : {}),
    updated_at: new Date().toISOString(),
  }, { onConflict: "game_id" });
}

/**
 * 게임 목록을 보고 시작/종료 알림 발송.
 * - live && start 미발송 → 시작 알림
 * - final && end 미발송 → (start도 미발송이면 cron이 경기 중 못 본 것 — 종료만 발송)
 * - 처음 보는 게임이 이미 final이고 start/end 둘 다 미발송 → 발송 없이 마킹
 *   (배포/도입 직후 과거 경기에 뒷북 알림 방지)
 * - cancelled → 알림 없음
 */
export async function notifyGameStatusTransitions(games: KboRawGame[]): Promise<{ started: number; ended: number }> {
  let started = 0;
  let ended = 0;

  for (const g of games) {
    const gameId = g.G_ID;
    if (!gameId) continue;
    if (g.CANCEL_SC_ID !== "0") continue;

    const away = g.AWAY_NM ?? "";
    const home = g.HOME_NM ?? "";
    const teamIds = [teamIdByShortName(away), teamIdByShortName(home)].filter((v): v is number => v !== null);
    const url = `/games/${gameId}`;

    if (g.GAME_STATE_SC === "2") {
      // 진행 중 — 시작 알림
      if (await claim(gameId, "start_notified")) {
        const fans = await fansOfTeams(teamIds);
        const res = await sendFcmToUsers(fans, {
          title: "⚾ 경기 시작!",
          body: `${away} vs ${home} 경기가 시작됐어요`,
          url,
        }, "game_start");
        started += res.sent;
      }
    } else if (g.GAME_STATE_SC === "3") {
      // 종료 — 한 번도 안 본 게임(시작 미발송)이면 뒷북 방지로 마킹만
      const { data: state } = await supabase
        .from("game_notify_state")
        .select("start_notified, end_notified")
        .eq("game_id", gameId)
        .maybeSingle();
      if (!state || !state.start_notified) {
        await markOnly(gameId, { start: true, end: true });
        continue;
      }
      if (await claim(gameId, "end_notified")) {
        const awayScore = parseInt(g.T_SCORE_CN ?? "0") || 0;
        const homeScore = parseInt(g.B_SCORE_CN ?? "0") || 0;
        const fans = await fansOfTeams(teamIds);
        const res = await sendFcmToUsers(fans, {
          title: "🏁 경기 종료",
          body: `${away} ${awayScore} : ${homeScore} ${home}`,
          url,
        }, "game_end");
        ended += res.sent;
      }
    }
  }

  return { started, ended };
}
