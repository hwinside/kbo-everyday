import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { sendFcmToUsers, WIDGET_STREAM } from "@/lib/notifications/fcm";
import { TEAMS } from "@/lib/constants/teams";
import { fetchStandings, isKboGameCancelled } from "@/lib/crawler/kbo-api";
import { decideEndStreakCount, type StreakDir } from "@/lib/notifications/end-streak-policy";
import { isStartNotificationFresh } from "@/lib/notifications/start-freshness-policy";
import { fetchTeamFanIds } from "@/lib/notifications/audience";
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

/** 현재 KST 날짜 "YYYYMMDD" (G_DT와 같은 포맷, 사전식 비교용). */
function kstDateStr(): string {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, "");
}

/** 현재 KST 날짜 "YYYY-MM-DD" (daily_standings_snapshot.date 포맷). */
function kstDateIso(): string {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** 양팀을 최애팀으로 둔 유저 id 목록. ok=false면 조회 실패(재시도 대상) */
export async function fansOfTeams(
  teamIds: number[],
  opts?: { deadlineAtMs?: number },
): Promise<{ ids: string[]; ok: boolean }> {
  if (teamIds.length === 0) return { ids: [], ok: true };
  try {
    return { ids: await fetchTeamFanIds(teamIds, opts), ok: true };
  } catch (error) {
    console.error("[game-status] fans query failed:", (error as Error).message);
    return { ids: [], ok: false };
  }
}

// 종료 알림은 수신자 최애팀 기준으로 승팀/패팀 다른 메시지라 한 게임에서 away/home
// 두 그룹으로 나눠 발송한다. 상태를 game 단위 end_notified 하나로 두면 한 그룹 성공·다른
// 그룹 실패 시 전체 롤백 → 성공 그룹 중복 발송 위험이 있어, 팀 슬롯 단위로 선점한다 (삼순 #210).
type NotifyFlag =
  | "start_notified"
  | "end_notified"
  | "end_away_notified"
  | "end_home_notified"
  | "cancel_notified";

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

/**
 * 오늘(KST) 날짜 daily_standings_snapshot의 streak 맵 (01:00 cron이 적재한 "어제까지" 누적).
 * 조회 실패 또는 행 0(cron 미실행) → null = 호출부가 라이브 방향일치 로직으로 폴백.
 */
async function fetchSnapshotStreaks(): Promise<Map<number, string | null> | null> {
  const { data, error } = await supabase
    .from("daily_standings_snapshot")
    .select("team_id, streak")
    .eq("date", kstDateIso());
  if (error) {
    console.error("[game-status] snapshot streak fetch failed:", error.message);
    return null;
  }
  if (!data || data.length === 0) return null;
  return new Map(data.map((r: { team_id: number; streak: string | null }) => [r.team_id, r.streak]));
}

/** 도입 직후/과거 경기 보호 — 발송 없이 플래그만 마킹 */
async function markOnly(gameId: string, flags: { start?: boolean; end?: boolean; cancel?: boolean }): Promise<void> {
  await supabase.from("game_notify_state").upsert({
    game_id: gameId,
    ...(flags.start ? { start_notified: true } : {}),
    ...(flags.end ? { end_notified: true } : {}),
    ...(flags.cancel ? { cancel_notified: true } : {}),
    updated_at: new Date().toISOString(),
  }, { onConflict: "game_id" });
}

/**
 * 게임 목록을 보고 시작/종료 알림 발송.
 * - live && start 미발송 → 시작 알림
 * - final && end 미발송 → (start도 미발송이면 cron이 경기 중 못 본 것 — 종료만 발송)
 * - 처음 보는 게임이 이미 final이고 start/end 둘 다 미발송 → 발송 없이 마킹
 *   (배포/도입 직후 과거 경기에 뒷북 알림 방지)
 * - cancelled(isKboGameCancelled) → "경기 취소" 알림 1회(우천 등). 예정시각 +90분 밖이면 마킹만(뒷북 차단).
 */
export async function notifyGameStatusTransitions(games: KboRawGame[]): Promise<{ started: number; ended: number; cancelled: number }> {
  let started = 0;
  let ended = 0;
  let cancelled = 0;

  for (const g of games) {
    const gameId = g.G_ID;
    if (!gameId) continue;

    const away = g.AWAY_NM ?? "";
    const home = g.HOME_NM ?? "";
    const teamIds = [teamIdByShortName(away), teamIdByShortName(home)].filter((v): v is number => v !== null);
    const url = `/games/${gameId}`;

    // 경기 취소 알림 (우천 등). pref는 "game_start"(경기 일정 관심자)에 연계 — 별도 토글 미신설.
    // dedup = cancel_notified 선점. 시작 알림과 달리 +90분 윈도우를 쓰지 않는다 — 우천 지연이
    // 90분을 넘겨 취소되는 "기다리다 취소"가 가장 중요한 알림이라(삼순 #287 블로커1). 대신
    // *과거 날짜*(배포 직후 지난 경기 백필)만 markOnly로 차단하고, 오늘(KST) 이후 경기 취소는 발송.
    if (isKboGameCancelled(g.CANCEL_SC_ID)) {
      const isPastDay = g.G_DT != null && g.G_DT.length === 8 && g.G_DT < kstDateStr();
      if (isPastDay) { await markOnly(gameId, { cancel: true }); continue; }
      if (await claim(gameId, "cancel_notified")) {
        const fans = await fansOfTeams(teamIds);
        if (!fans.ok) { await unclaim(gameId, "cancel_notified"); continue; } // 조회 실패 → 재시도
        const res = await sendFcmToUsers(fans.ids, {
          title: "⚾ 경기 취소",
          body: `${away} vs ${home} 경기가 취소됐어요. 변경된 일정은 크보팬에서 확인해 보세요`,
          url,
        }, "game_start");
        if (!res.ok) { await unclaim(gameId, "cancel_notified"); continue; } // 인프라 실패 → 재시도
        cancelled += res.sent;
        // 30분 전 pregame push(android-widget-live)가 올린 '경기 예정' 카드가 취소 후 잠금화면/
        // 위젯에 잔존하지 않게 clear — data-only game_end로 KboMessagingService가 카드+위젯 제거.
        // cancel_notified 선점 안에서 1회만 발송. 카드 없던 유저에겐 no-op이라 안전. fire-and-forget.
        await sendFcmToUsers(fans.ids, {
          title: "",
          body: "",
          url,
          dataOnly: true,
          // terminal — 위젯 스트림 공통 정책(단일 collapse key + 긴 TTL, 삼순 #649 blocker①).
          ...WIDGET_STREAM.terminal,
          data: { kind: "game_end" },
        }, "game_start");
      }
      continue;
    }

    if (g.GAME_STATE_SC === "2") {
      // 진행 중 — 시작 알림. 시간 윈도우 밖이거나 이미 경기가 진행된 뒤면(1회초 이후)
      // 발송 없이 마킹만(뒷북 차단 — 2026-07-23 하린아빠 지시: 늦은 시작알림 금지 가드)
      const startedAt = scheduledStartMs(g.G_DT, g.G_TM);
      const notFresh = !isStartNotificationFresh({
        inningNo: g.GAME_INN_NO,
        isTop: g.GAME_TB_SC ? g.GAME_TB_SC === "T" : null,
      });
      const tooLate = notFresh || (startedAt !== null && Date.now() - startedAt > START_WINDOW_MS);
      if (tooLate) {
        await markOnly(gameId, { start: true });
        continue;
      }
      if (await claim(gameId, "start_notified")) {
        const fans = await fansOfTeams(teamIds);
        if (!fans.ok) { await unclaim(gameId, "start_notified"); continue; } // 조회 실패 → 재시도
        const res = await sendFcmToUsers(fans.ids, {
          title: "⚾ 경기 시작!",
          body: `${away} vs ${home} 경기가 시작됐어요. 크보팬에서 자세한 경기 내용을 확인해보세요!`,
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
          // live — 위젯 스트림 공통 정책(90s TTL, 다음 warmup tick이 곧 덮어씀, 삼순 #649 blocker①).
          ...WIDGET_STREAM.live,
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

      // streak 표기 — 1순위: 오늘 스냅샷(어제까지 누적) + 이번 결과로 직접 계산 — 순위표
      // 갱신 지연과 무관하게 정확(#cs 2026-07-18 "4연패인데 3연패" fix). 2순위(스냅샷
      // 부재·더블헤더): 라이브 순위표 방향 일치 시에만 노출(기존 fail-closed 유지, 삼순 #210).
      const streaks = await fetchTeamStreaks();
      const snapshotStreaks = await fetchSnapshotStreaks();
      // 오늘 팀별 final 경기 수 — 더블헤더 2차전은 스냅샷이 1차전 결과를 모르므로 폴백 판정용.
      const finalsToday = new Map<number, number>();
      for (const gg of games) {
        if (isKboGameCancelled(gg.CANCEL_SC_ID) || gg.GAME_STATE_SC !== "3") continue;
        for (const nm of [gg.AWAY_NM ?? "", gg.HOME_NM ?? ""]) {
          const id = teamIdByShortName(nm);
          if (id !== null) finalsToday.set(id, (finalsToday.get(id) ?? 0) + 1);
        }
      }
      const streakSuffix = (id: number | null, expected: StreakDir): string => {
        if (id === null) return "";
        const n = decideEndStreakCount({
          snapshotStreak: snapshotStreaks?.get(id),
          hasSnapshot: snapshotStreaks?.has(id) ?? false,
          result: expected,
          finalsToday: finalsToday.get(id) ?? 1,
          liveStreak: streaks.get(id),
        });
        if (n === null) return "";
        return expected === "승" ? ` · ${n}연승!🔥` : ` · ${n}연패 💦`;
      };
      const endCta = "자세한 경기 결과를 크보팬에서 확인해보세요.";

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
          res = await sendFcmToUsers(fans.ids, { title: "🏁 경기 종료", body: `${scoreLine} ${endCta}`, url }, "game_end");
        } else {
          const won = slot.isAway ? awayWon : !awayWon;
          const name = slot.isAway ? away : home;
          res = won
            ? await sendFcmToUsers(fans.ids, { title: `🎉 ${name} 승리!`, body: `${scoreLine}${streakSuffix(slot.teamId, "승")} ${endCta}`, url }, "game_end")
            : await sendFcmToUsers(fans.ids, { title: `🥲 ${name} 아쉬운 패배`, body: `${scoreLine}${streakSuffix(slot.teamId, "패")} ${endCta}`, url }, "game_end");
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
          // iOS 무음 백그라운드 wake(content-available) — iOS 홈위젯은 서버 푸시로 직접
          // 갱신되지 않아(플랫폼 제약) 앱을 닫으면 마지막 LIVE 스냅샷에 얼어붙는다. game_end로
          // 앱을 백그라운드에서 깨워 AppDelegate가 홈위젯을 '경기 종료 + 최종 스코어'로 전환
          // (markFinal)하게 한다. 최종 스코어(w_as/w_hs)+gameId 동봉 — 현재 위젯이 이 경기를
          // 표시 중일 때만 반영(다른/다음 경기 덮어쓰기 방지). Android는 KboMessagingService가
          // game_end로 이미 처리하며 apns 블록·추가 필드는 무영향(kind만 사용).
          apnsBackground: true,
          // terminal — 위젯 스트림 공통 정책(단일 collapse key + 긴 TTL, 삼순 #649 blocker①).
          // android 전용 필드라 iOS apns 무음 wake 동작엔 무영향.
          ...WIDGET_STREAM.terminal,
          data: { kind: "game_end", gameId, w_as: String(awayScore), w_hs: String(homeScore) },
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

  return { started, ended, cancelled };
}
