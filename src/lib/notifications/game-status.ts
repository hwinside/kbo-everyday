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

export function teamIdByShortName(name: string): number | null {
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
export async function fansOfTeams(teamIds: number[]): Promise<{ ids: string[]; ok: boolean }> {
  if (teamIds.length === 0) return { ids: [], ok: true };
  const { data, error } = await supabase.from("profiles").select("id").in("team_id", teamIds);
  if (error) {
    console.error("[game-status] fans query failed:", error.message);
    return { ids: [], ok: false };
  }
  return { ids: (data ?? []).map((r: { id: string }) => r.id), ok: true };
}

// 종료 알림은 수신자 최애팀 기준으로 승팀/패팀 다른 메시지라 한 게임에서 away/home
// 두 그룹으로 나눠 발송한다. 상태를 game 단위 end_notified 하나로 두면 한 그룹 성공·다른
// 그룹 실패 시 전체 롤백 → 성공 그룹 중복 발송 위험이 있어, 팀 슬롯 단위로 선점한다 (삼순 #210).
type NotifyFlag =
  | "start_notified"
  | "end_notified"
  | "end_away_notified"
  | "end_home_notified";

/**
 * 알림 권한 선점 — 해당 플래그가 false인 행을 true로 바꾸는 데 성공한
 * 호출만 발송 자격을 가짐 (semantic key = game_id + 플래그).
 */
async function claim(gameId: string, flag: NotifyFlag): Promise<boolean> {
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
async function unclaim(gameId: string, flag: NotifyFlag): Promise<void> {
  const { error } = await supabase
    .from("game_notify_state")
    .update({ [flag]: false, updated_at: new Date().toISOString() })
    .eq("game_id", gameId);
  if (error) console.error("[game-status] unclaim failed:", error.message);
}

/**
 * teamId → 연승/연패 { n, dir }. 2 미만이거나 미상이면 미수록.
 * KBO standings의 continuousGameResult("3승"/"1패") 기반 — 종료 직후 갱신 지연이
 * 있으면 직전 streak일 수 있어, 표기는 호출부에서 "이번 경기 결과 방향과 일치할 때만"
 * 노출(fail-closed)한다. fetch 실패 시 빈 맵(스코어만 발송).
 */
async function fetchTeamStreaks(): Promise<Map<number, { n: number; dir: "승" | "패" }>> {
  const out = new Map<number, { n: number; dir: "승" | "패" }>();
  try {
    const standings = await fetchStandings();
    for (const s of standings) {
      const m = (s.continuousGameResult ?? "").match(/^(\d+)(승|패)$/);
      if (!m) continue;
      const n = parseInt(m[1]);
      if (n >= 2 && s.teamId > 0) out.set(s.teamId, { n, dir: m[2] as "승" | "패" });
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
        // 잠금화면 ongoing card 시작 (앱 미진입 자동 표시, C2) — data-only, fire-and-forget.
        // 시작 알림은 이미 성공(started 카운트)이라 카드 실패해도 unclaim 안 함.
        const aScore = parseInt(g.T_SCORE_CN ?? "0") || 0;
        const hScore = parseInt(g.B_SCORE_CN ?? "0") || 0;
        // 위젯(안드로이드)용 구조화 필드 — gameId에서 2자 팀코드 파싱(YYYYMMDD+AWAY+HOME+N).
        const codes = gameId.match(/^\d{8}([A-Z]{2})([A-Z]{2})\d$/);
        await sendFcmToUsers(fans.ids, {
          title: `${away} ${aScore} : ${hScore} ${home}`,
          body: "경기 시작",
          url,
          dataOnly: true,
          data: {
            kind: "game_live",
            ...(codes ? { w_away: codes[1], w_home: codes[2] } : {}),
            w_as: String(aScore),
            w_hs: String(hScore),
            w_status: "LIVE",
            w_stadium: g.S_NM ?? "",
          },
        }, "game_start");
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
      if (state.end_notified) continue; // 양 슬롯 종료 발송 완료 — 재평가 불필요

      const awayScore = parseInt(g.T_SCORE_CN ?? "0") || 0;
      const homeScore = parseInt(g.B_SCORE_CN ?? "0") || 0;
      const tie = awayScore === homeScore;
      const awayWon = awayScore > homeScore;
      const scoreLine = `${away} ${awayScore} : ${homeScore} ${home}`;

      // streak은 이번 경기 결과 방향과 일치할 때만 노출 — standings 갱신 지연 시
      // "승리! · 3연패 중" 같은 모순을 fail-closed로 차단 (삼순 #210 재리뷰)
      const streaks = await fetchTeamStreaks();
      const streakSuffix = (id: number | null, expected: "승" | "패"): string => {
        const s = id !== null ? streaks.get(id) : undefined;
        if (!s || s.dir !== expected) return "";
        return ` · ${s.n}연${s.dir} 중`;
      };

      // away/home 슬롯을 독립 선점·발송 — 한 슬롯 실패가 다른 슬롯을 중복/누락시키지 않음.
      // 한 유저는 team_id 하나라 두 슬롯 수신자는 서로소.
      const slots: Array<{ teamId: number | null; flag: NotifyFlag; isAway: boolean }> = [
        { teamId: teamIdByShortName(away), flag: "end_away_notified", isAway: true },
        { teamId: teamIdByShortName(home), flag: "end_home_notified", isAway: false },
      ];

      for (const slot of slots) {
        if (slot.teamId === null) {
          // 팀 미상 — 보낼 수신자 없음. 슬롯만 마킹해 end_notified 도달 가능하게.
          await supabase.from("game_notify_state")
            .update({ [slot.flag]: true, updated_at: new Date().toISOString() })
            .eq("game_id", gameId);
          continue;
        }
        if (!(await claim(gameId, slot.flag))) continue; // 이미 발송됨

        const fans = await fansOfTeams([slot.teamId]);
        if (!fans.ok) { await unclaim(gameId, slot.flag); continue; }

        let res;
        if (tie) {
          res = await sendFcmToUsers(fans.ids, { title: "🏁 경기 종료", body: scoreLine, url }, "game_end");
        } else {
          const won = slot.isAway ? awayWon : !awayWon;
          const name = slot.isAway ? away : home;
          res = won
            ? await sendFcmToUsers(fans.ids, { title: `🎉 ${name} 승리!`, body: `${scoreLine}${streakSuffix(slot.teamId, "승")}`, url }, "game_end")
            : await sendFcmToUsers(fans.ids, { title: `🥲 ${name} 아쉬운 패배`, body: `${scoreLine}${streakSuffix(slot.teamId, "패")}`, url }, "game_end");
        }
        if (!res.ok) { await unclaim(gameId, slot.flag); continue; }
        ended += res.sent;
      }

      // 잠금화면 ongoing card 제거 (C2) — data-only, 양팀 팬 모두에게.
      // ⚠️ end_notified=true 마킹보다 *먼저* 보내고, clear가 ok일 때만 마킹으로 넘어간다.
      // 먼저 마킹하면 clear 조회/FCM 실패 시 다음 cron이 end_notified에서 skip → 카드가
      // 잠금화면/위젯에 stale로 stuck. clear는 멱등이라 재시도 안전 (삼순 C2 필수수정).
      const endFans = await fansOfTeams(teamIds);
      let clearOk = endFans.ok;
      if (endFans.ok && endFans.ids.length > 0) {
        const clearRes = await sendFcmToUsers(endFans.ids, {
          title: "",
          body: "",
          dataOnly: true,
          data: { kind: "game_end" },
        });
        clearOk = clearRes.ok;
      }

      // 두 슬롯 다 발송 + clear ok면 end_notified=true (다음 cron부터 조기 skip).
      // clear 실패 시 미마킹 → 다음 cron이 end 브랜치 재진입해 clear 재시도(슬롯은 이미
      // 선점돼 알림 재발송은 없음).
      if (clearOk) {
        await supabase.from("game_notify_state")
          .update({ end_notified: true, updated_at: new Date().toISOString() })
          .eq("game_id", gameId)
          .eq("end_away_notified", true)
          .eq("end_home_notified", true);
      }
    }
  }

  return { started, ended };
}
