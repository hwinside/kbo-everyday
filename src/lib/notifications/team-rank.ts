import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { sendFcmToUsers } from "@/lib/notifications/fcm";
import { fansOfTeams } from "@/lib/notifications/game-status";
import { fetchStandings, type TeamStanding } from "@/lib/crawler/kbo-api";
import { TEAMS } from "@/lib/constants/teams";
import { buildRankChangeMessage } from "@/lib/notifications/team-rank-message";

/**
 * 순위 산정 — 4/11 공동순위 핫픽스(001bf82c)와 동일 기준:
 *  - 네이버 API 원본 `ranking`(공동순위 반영)이 있으면 그대로 사용.
 *  - 없으면(KBO HTML 폴백 등) 승률 내림차순 competition ranking — 동률은 같은 순위(1,2,2,4…).
 * winRate-sort+index+1 단순 방식은 공동순위를 깨므로 쓰지 않는다(삼순 #406 NO-GO).
 */
function rankStandings(standings: TeamStanding[]) {
  const hasRanking = standings.some((s) => s.ranking != null && s.ranking > 0);
  if (hasRanking) {
    return standings
      .filter((s) => s.teamId)
      .map((s) => ({ teamId: s.teamId, teamName: s.teamName, rank: s.ranking as number }));
  }
  const sorted = [...standings].sort((a, b) => b.winRate - a.winRate);
  let currentRank = 1;
  return sorted.map((s, i) => {
    if (i > 0 && s.winRate !== sorted[i - 1].winRate) currentRank = i + 1;
    return { teamId: s.teamId, teamName: s.teamName, rank: currentRank };
  });
}

/**
 * 팀 순위 변동 알림 (옵션 A — 순위가 바뀐 순간 즉시 발화, 하린아빠 확정).
 * KBO 순위는 경기가 final 될 때만 바뀌므로(라이브 중엔 불변), warmup cron이 매분 standings를
 * 보고 직전 발송 순위와 다르면 즉시 발송한다. "확정된 순간" = 경기 종료로 순위가 실제 바뀐 시점.
 * 저녁 내내 게임이 하나씩 끝나며 같은 팀이 두 번 바뀌면 두 번 발송될 수 있으나(되돌림), 시즌
 * 중후반 변동 빈도가 낮아 허용(하린아빠: 유입 drive 목적이라 A가 낫다).
 *
 * dedup/seed:
 *  - team_rank_notify_state(team_id, rank) = team별 마지막 *발송* 순위.
 *  - 현재 순위 == 마지막 발송 순위면 무발송(변동 없음).
 *  - 첫 기록 팀은 발송 없이 baseline만 seed(배포 직후 일괄 발송 차단).
 *  - 발송 성공 시에만 baseline 전진 — 인프라 실패는 다음 run 재시도(중복 < 누락).
 */
export async function notifyTeamRankChanges(): Promise<{ changed: number } | { skipped: string }> {
  const standings = await fetchStandings();
  if (standings.length === 0) return { skipped: "순위 조회 실패" };
  const ranked = rankStandings(standings);

  const { data: stateRows, error: stateErr } = await supabase
    .from("team_rank_notify_state")
    .select("team_id, rank");
  if (stateErr) {
    console.error("[team-rank] state read failed:", stateErr.message);
    return { skipped: "state 조회 실패" };
  }
  const prevByTeam = new Map<number, number>();
  for (const r of stateRows ?? []) prevByTeam.set(r.team_id as number, r.rank as number);

  let changed = 0;
  const now = new Date().toISOString();
  const advance: { team_id: number; rank: number; updated_at: string }[] = [];

  for (const { teamId, teamName, rank } of ranked) {
    if (!teamId) continue;
    const prevRank = prevByTeam.get(teamId);
    if (prevRank === rank) continue; // 변동 없음

    if (prevRank == null) {
      advance.push({ team_id: teamId, rank, updated_at: now }); // 첫 기록 → seed만 (발송 없음)
      continue;
    }
    const msg = buildRankChangeMessage(TEAMS.find((t) => t.id === teamId)?.shortName ?? teamName, prevRank, rank);
    if (!msg) continue;

    const fans = await fansOfTeams([teamId]);
    if (!fans.ok) continue; // 조회 실패 → baseline 유지, 다음 run 재시도
    if (fans.ids.length === 0) {
      advance.push({ team_id: teamId, rank, updated_at: now }); // 수신자 없음 → baseline만 전진
      continue;
    }
    const res = await sendFcmToUsers(fans.ids, { ...msg, url: "/standings" }, "team_rank_change");
    if (!res.ok) continue; // 인프라 실패 → baseline 유지, 다음 run 재시도
    changed += res.sent;
    advance.push({ team_id: teamId, rank, updated_at: now });
  }

  if (advance.length > 0) {
    const { error: upErr } = await supabase
      .from("team_rank_notify_state")
      .upsert(advance, { onConflict: "team_id" });
    if (upErr) console.error("[team-rank] state upsert failed:", upErr.message);
  }

  return { changed };
}
