import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { sendFcmToUsers } from "@/lib/notifications/fcm";
import { fansOfTeams } from "@/lib/notifications/game-status";
import { fetchStandings } from "@/lib/crawler/kbo-api";
import { TEAMS } from "@/lib/constants/teams";
import { buildRankChangeMessage } from "@/lib/notifications/team-rank-message";
import type { KboRawGame } from "@/types/api";

/** KST 기준 오늘 날짜 (YYYYMMDD — KBO G_DT와 동일 포맷). */
function kstYmd(): string {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, "");
}

/** YYYYMMDD → YYYY-MM-DD (Postgres DATE). */
function toIsoDate(ymd: string): string {
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

/** winRate 내림차순 위치 = 순위 (team-card route와 동일 산정). */
function rankStandings(standings: { teamId: number; teamName: string; winRate: number }[]) {
  return [...standings]
    .sort((a, b) => b.winRate - a.winRate)
    .map((s, i) => ({ teamId: s.teamId, teamName: s.teamName, rank: i + 1 }));
}

/**
 * 팀 순위 변동 알림 (옵션 B — 그날 경기 전부 종료 후 최종순위 확정 시 전일 대비 1회).
 * warmup cron에서 game 목록과 함께 호출. 다음 조건을 모두 만족할 때만 발화:
 *  - 오늘(KST) 경기가 있고, 전부 종료(GAME_STATE_SC="3") 또는 취소(CANCEL_SC_ID≠"0")
 *  - 오늘 아직 settle 안 함(team_rank_notify_state.settled_date에 오늘 없음 — 중복 방지)
 * 최초 도입/첫 기록 팀은 발송 없이 baseline만 seed(배포 직후 과거 변동 일괄 발송 차단).
 *
 * ⚠️ v1 한계: standings API가 종료 직후 약간 지연되면 settle 순간 직전 순위를 읽을 수 있음
 *   (date dedup으로 재평가 안 함). 발송 실패 팀도 baseline은 전진(드물게 1회 누락 가능).
 */
export async function notifyTeamRankChanges(
  games: KboRawGame[],
): Promise<{ changed: number } | { skipped: string }> {
  const todayYmd = kstYmd();
  const todayIso = toIsoDate(todayYmd);

  const todays = games.filter((g) => g.G_DT === todayYmd);
  if (todays.length === 0) return { skipped: "오늘 경기 없음" };
  const allSettled = todays.every((g) => g.GAME_STATE_SC === "3" || g.CANCEL_SC_ID !== "0");
  if (!allSettled) return { skipped: "경기 진행 중" };

  const { data: stateRows, error: stateErr } = await supabase
    .from("team_rank_notify_state")
    .select("team_id, rank, settled_date");
  if (stateErr) {
    console.error("[team-rank] state read failed:", stateErr.message);
    return { skipped: "state 조회 실패" };
  }
  // 오늘 이미 확정 처리됨 → 재발화 방지
  if ((stateRows ?? []).some((r) => String(r.settled_date) === todayIso)) {
    return { skipped: "오늘 이미 확정 처리됨" };
  }
  const prevByTeam = new Map<number, number>();
  for (const r of stateRows ?? []) prevByTeam.set(r.team_id as number, r.rank as number);

  const standings = await fetchStandings();
  if (standings.length === 0) return { skipped: "순위 조회 실패" };
  const ranked = rankStandings(standings);

  let changed = 0;
  const upserts: { team_id: number; rank: number; settled_date: string; updated_at: string }[] = [];
  const now = new Date().toISOString();

  for (const { teamId, teamName, rank } of ranked) {
    if (!teamId) continue;
    upserts.push({ team_id: teamId, rank, settled_date: todayIso, updated_at: now });

    const prevRank = prevByTeam.get(teamId);
    if (prevRank == null) continue; // 첫 기록 → seed만 (발송 없음)
    const name = TEAMS.find((t) => t.id === teamId)?.shortName ?? teamName;
    const msg = buildRankChangeMessage(name, prevRank, rank);
    if (!msg) continue;

    const fans = await fansOfTeams([teamId]);
    if (!fans.ok || fans.ids.length === 0) continue;
    const res = await sendFcmToUsers(fans.ids, { ...msg, url: "/standings" }, "team_rank_change");
    if (res.ok) changed += res.sent;
  }

  if (upserts.length > 0) {
    const { error: upErr } = await supabase
      .from("team_rank_notify_state")
      .upsert(upserts, { onConflict: "team_id" });
    if (upErr) console.error("[team-rank] state upsert failed:", upErr.message);
  }

  return { changed };
}
