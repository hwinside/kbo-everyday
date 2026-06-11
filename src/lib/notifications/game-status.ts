import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { sendFcmToUsers } from "@/lib/notifications/fcm";
import { TEAMS } from "@/lib/constants/teams";
import { fetchStandings } from "@/lib/crawler/kbo-api";
import type { KboRawGame } from "@/types/api";

// 경기 시작/종료 알림 (push-notifications-v1 S4).
// warmup cron(경기 시간대 매분)이 호출. 중복 발화 방지 = game_notify_state
// 조건부 UPDATE 선점 — 다중 인스턴스가 동시에 돌아도 발송은 1회.

// 시작 알림 허용 윈도우: 경기 예정시각 +90분(우천 지연 여유) 이내일 때만 "시작!" 발송.
// cron/배포 장애가 한참 뒤 복구돼도 뒷북 "경기 시작!"이 안 가게 (삼순 리뷰 #210-2)
const START_WINDOW_MS = 90 * 60 * 1000;

function teamIdByShortName(name: string): number | null {
  const t = TEAMS.find((t) => t.shortName === name);
  return t?.id ?? null;
}

/** G_DT("20260611") + G_TM("18:30", KST) → epoch ms. 파싱 실패 시 null */
function scheduledStartMs(gDt: string | undefined, gTm: string | undefined): number | null {
  if (!gDt || !gTm || gDt.length !== 8 || !/^\d{2}:\d{2}$/.test(gTm)) return null;
  const y = +gDt.slice(0, 4), mo = +gDt.slice(4, 6), d = +gDt.slice(6, 8);
  const [hh, mm] = gTm.split(":").map(Number);
  // KST(UTC+9) wall-clock → UTC epoch
  return Date.UTC(y, mo - 1, d, hh - 9, mm);
}

/** 양팀을 최애팀으로 둔 유저 id 목록. ok=false면 조회 실패(재시도 대상) */
async function fansOfTeams(teamIds: number[]): Promise<{ ids: string[]; ok: boolean }> {
  if (teamIds.length === 0) return { ids: [], ok: true };
  const { data, error } = await supabase.from("profiles").select("id").in("team_id", teamIds);
  if (error) {
    console.error("[game-status] fans query failed:", error.message);
    return { ids: [], ok: false };
  }
  return { ids: (data ?? []).map((r: { id: string }) => r.id), ok: true };
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

/** 발송 인프라 실패 시 선점 플래그를 되돌려 다음 cron이 재시도하게 함 (삼순 #210-1) */
async function unclaim(gameId: string, flag: "start_notified" | "end_notified"): Promise<void> {
  const { error } = await supabase
    .from("game_notify_state")
    .update({ [flag]: false, updated_at: new Date().toISOString() })
    .eq("game_id", gameId);
  if (error) console.error("[game-status] unclaim failed:", error.message);
}

/**
 * teamId → 연승/연패 표시 문자열 ("3연승"/"2연패"). 2 미만이거나 미상이면 null.
 * KBO standings의 continuousGameResult("3승"/"1패") 기반 — 종료 직후 갱신 지연이
 * 있으면 직전 streak일 수 있으나 best-effort. fetch 실패 시 빈 맵(스코어만 발송).
 */
async function fetchTeamStreaks(): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  try {
    const standings = await fetchStandings();
    for (const s of standings) {
      const m = (s.continuousGameResult ?? "").match(/^(\d+)(승|패)$/);
      if (!m) continue;
      const n = parseInt(m[1]);
      if (n >= 2 && s.teamId > 0) out.set(s.teamId, `${n}연${m[2] === "승" ? "승" : "패"}`);
    }
  } catch (e) {
    console.error("[game-status] standings fetch failed:", (e as Error).message);
  }
  return out;
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
      // 진행 중 — 시작 알림. 시간 윈도우 밖이면 발송 없이 마킹만(뒷북 차단)
      const startedAt = scheduledStartMs(g.G_DT, g.G_TM);
      const tooLate = startedAt !== null && Date.now() - startedAt > START_WINDOW_MS;
      if (tooLate) {
        await markOnly(gameId, { start: true });
        continue;
      }
      if (await claim(gameId, "start_notified")) {
        const fans = await fansOfTeams(teamIds);
        if (!fans.ok) { await unclaim(gameId, "start_notified"); continue; } // 조회 실패 → 재시도
        const res = await sendFcmToUsers(fans.ids, {
          title: "⚾ 경기 시작!",
          body: `${away} vs ${home} 경기가 시작됐어요`,
          url,
        }, "game_start");
        if (!res.ok) { await unclaim(gameId, "start_notified"); continue; } // 인프라 실패 → 재시도
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
        const awayId = teamIdByShortName(away);
        const homeId = teamIdByShortName(home);
        const scoreLine = `${away} ${awayScore} : ${homeScore} ${home}`;
        const streaks = await fetchTeamStreaks();
        const withStreak = (id: number | null) => {
          const s = id !== null ? streaks.get(id) : undefined;
          return s ? `${scoreLine} · ${s} 중` : scoreLine;
        };

        if (awayScore === homeScore) {
          // 무승부 — 양팀 중립
          const fans = await fansOfTeams(teamIds);
          if (!fans.ok) { await unclaim(gameId, "end_notified"); continue; }
          const res = await sendFcmToUsers(fans.ids, { title: "🏁 경기 종료", body: scoreLine, url }, "game_end");
          if (!res.ok) { await unclaim(gameId, "end_notified"); continue; }
          ended += res.sent;
        } else {
          // 최애팀 기준 승팀=축하 / 패팀=위로 (수신자별 다른 메시지 → 그룹 분리 발송)
          const awayWon = awayScore > homeScore;
          const winId = awayWon ? awayId : homeId;
          const loseId = awayWon ? homeId : awayId;
          const winName = awayWon ? away : home;
          const loseName = awayWon ? home : away;

          let failed = false;
          if (winId !== null) {
            const f = await fansOfTeams([winId]);
            if (!f.ok) failed = true;
            else {
              const res = await sendFcmToUsers(f.ids, {
                title: `🎉 ${winName} 승리!`,
                body: withStreak(winId),
                url,
              }, "game_end");
              if (!res.ok) failed = true; else ended += res.sent;
            }
          }
          if (!failed && loseId !== null) {
            const f = await fansOfTeams([loseId]);
            if (!f.ok) failed = true;
            else {
              const res = await sendFcmToUsers(f.ids, {
                title: `🥲 ${loseName} 아쉬운 패배`,
                body: withStreak(loseId),
                url,
              }, "game_end");
              if (!res.ok) failed = true; else ended += res.sent;
            }
          }
          if (failed) { await unclaim(gameId, "end_notified"); continue; }
        }
      }
    }
  }

  return { started, ended };
}
