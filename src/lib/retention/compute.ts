import { SupabaseClient } from "@supabase/supabase-js";
import { toKSTDateString } from "@/lib/utils/date-kst";

interface MetricRow {
  date: string;
  metric_type: string;
  cohort_key: string;
  metric_key: string;
  total: number;
  value: number;
  rate: number;
}

/**
 * ISO week string (e.g. '2026-W15') from a YYYY-MM-DD date.
 */
function isoWeek(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00+09:00");
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

/**
 * 코호트 리텐션 집계: 가입 주차별 D1/D7/D14/D30 재방문율.
 * 방문 기준: admin_page_views에 해당 user_id 레코드 존재.
 */
export async function computeCohortRetention(
  supabase: SupabaseClient,
  targetDate: string,
): Promise<MetricRow[]> {
  // 1) 최근 60일 가입자 + 가입일
  const sixtyDaysAgo = new Date(
    new Date(targetDate + "T00:00:00+09:00").getTime() - 60 * 86400000,
  ).toISOString();

  const { data: profiles } = await supabase
    .from("profiles")
    .select("id, created_at")
    .gte("created_at", sixtyDaysAgo);

  if (!profiles?.length) return [];

  // 2) 같은 기간 page_views (user_id not null)
  const { data: views } = await supabase
    .from("admin_page_views")
    .select("user_id, created_at")
    .not("user_id", "is", null)
    .gte("created_at", sixtyDaysAgo);

  // user별 방문일 Set
  const visitDays = new Map<string, Set<string>>();
  for (const v of views ?? []) {
    if (!v.user_id) continue;
    const day = toKSTDateString(v.created_at);
    if (!visitDays.has(v.user_id)) visitDays.set(v.user_id, new Set());
    visitDays.get(v.user_id)!.add(day);
  }

  // 3) 코호트별 D-N 잔존율 계산
  const dayOffsets = [1, 7, 14, 30];
  const cohorts = new Map<string, { users: { id: string; signupDate: string }[] }>();

  for (const p of profiles) {
    const signupDate = toKSTDateString(p.created_at);
    const week = isoWeek(signupDate);
    if (!cohorts.has(week)) cohorts.set(week, { users: [] });
    cohorts.get(week)!.users.push({ id: p.id, signupDate });
  }

  const rows: MetricRow[] = [];
  for (const [cohortKey, { users }] of cohorts) {
    for (const dN of dayOffsets) {
      let returned = 0;
      let eligible = 0;
      for (const u of users) {
        const targetDay = new Date(
          new Date(u.signupDate + "T00:00:00+09:00").getTime() + dN * 86400000,
        ).toISOString().slice(0, 10);
        // 아직 D-N이 지나지 않은 유저는 eligible에서 제외
        if (targetDay > targetDate) continue;
        eligible++;
        if (visitDays.get(u.id)?.has(targetDay)) returned++;
      }
      if (eligible > 0) {
        rows.push({
          date: targetDate,
          metric_type: "cohort",
          cohort_key: cohortKey,
          metric_key: `D${dN}`,
          total: eligible,
          value: returned,
          rate: Math.round((returned / eligible) * 10000) / 10000,
        });
      }
    }
  }
  return rows;
}

/**
 * Activation Funnel 집계: 가입→팀선택→첫예측→첫댓글→첫채팅.
 * 전체 가입자 중 각 단계 도달 비율.
 */
export async function computeActivationFunnel(
  supabase: SupabaseClient,
  targetDate: string,
): Promise<MetricRow[]> {
  // 전체 가입자 수
  const { count: totalSignups } = await supabase
    .from("profiles")
    .select("*", { count: "exact", head: true })
    .lte("created_at", targetDate + "T23:59:59+09:00");

  if (!totalSignups) return [];

  // 팀 선택 완료 (team_id not null)
  const { count: teamSelected } = await supabase
    .from("profiles")
    .select("*", { count: "exact", head: true })
    .lte("created_at", targetDate + "T23:59:59+09:00")
    .not("team_id", "is", null);

  // 첫 예측 (prediction_votes에 레코드 있는 유저 수)
  const { data: predUsers } = await supabase
    .from("prediction_votes")
    .select("user_id")
    .lte("created_at", targetDate + "T23:59:59+09:00");
  const uniquePredUsers = new Set(predUsers?.map((r) => r.user_id)).size;

  // 첫 댓글
  const { data: commentUsers } = await supabase
    .from("comments")
    .select("author_id")
    .lte("created_at", targetDate + "T23:59:59+09:00");
  const uniqueCommentUsers = new Set(commentUsers?.map((r) => r.author_id)).size;

  // 첫 채팅
  const { data: chatUsers } = await supabase
    .from("chat_messages")
    .select("user_id")
    .lte("created_at", targetDate + "T23:59:59+09:00");
  const uniqueChatUsers = new Set(chatUsers?.map((r) => r.user_id)).size;

  const steps = [
    { key: "signup", value: totalSignups },
    { key: "team_select", value: teamSelected ?? 0 },
    { key: "first_prediction", value: uniquePredUsers },
    { key: "first_comment", value: uniqueCommentUsers },
    { key: "first_chat", value: uniqueChatUsers },
  ];

  return steps.map((s) => ({
    date: targetDate,
    metric_type: "funnel",
    cohort_key: "all",
    metric_key: s.key,
    total: totalSignups,
    value: s.value,
    rate: Math.round((s.value / totalSignups) * 10000) / 10000,
  }));
}

/**
 * 게임데이 리텐션: 가입 후 1st/2nd/3rd 경기일 복귀율.
 * KBO API로 경기일 목록을 가져와 유저별 경기일 방문 여부 확인.
 */
export async function computeGamedayRetention(
  supabase: SupabaseClient,
  targetDate: string,
  gameDates: string[], // YYYY-MM-DD 형식의 경기일 목록 (외부에서 주입)
): Promise<MetricRow[]> {
  if (!gameDates.length) return [];

  // 최근 60일 가입자
  const sixtyDaysAgo = new Date(
    new Date(targetDate + "T00:00:00+09:00").getTime() - 60 * 86400000,
  ).toISOString();

  const { data: profiles } = await supabase
    .from("profiles")
    .select("id, created_at")
    .gte("created_at", sixtyDaysAgo);

  if (!profiles?.length) return [];

  // page_views
  const { data: views } = await supabase
    .from("admin_page_views")
    .select("user_id, created_at")
    .not("user_id", "is", null)
    .gte("created_at", sixtyDaysAgo);

  const visitDays = new Map<string, Set<string>>();
  for (const v of views ?? []) {
    if (!v.user_id) continue;
    const day = toKSTDateString(v.created_at);
    if (!visitDays.has(v.user_id)) visitDays.set(v.user_id, new Set());
    visitDays.get(v.user_id)!.add(day);
  }

  // 유저별: 가입일 이후 경기일 목록 (시간순), 그 중 방문한 경기일 체크
  const cohorts = new Map<string, { users: { id: string; signupDate: string }[] }>();

  for (const p of profiles) {
    const signupDate = toKSTDateString(p.created_at);
    const week = isoWeek(signupDate);
    if (!cohorts.has(week)) cohorts.set(week, { users: [] });
    cohorts.get(week)!.users.push({ id: p.id, signupDate });
  }

  const gdKeys = ["gd1", "gd2", "gd3"];
  const rows: MetricRow[] = [];

  for (const [cohortKey, { users }] of cohorts) {
    for (let gi = 0; gi < 3; gi++) {
      let eligible = 0;
      let returned = 0;

      for (const u of users) {
        // 가입일 이후 경기일 목록
        const afterSignup = gameDates
          .filter((gd) => gd > u.signupDate && gd <= targetDate)
          .sort();

        if (afterSignup.length <= gi) continue;
        eligible++;

        const gdDate = afterSignup[gi];
        if (visitDays.get(u.id)?.has(gdDate)) returned++;
      }

      if (eligible > 0) {
        rows.push({
          date: targetDate,
          metric_type: "gameday",
          cohort_key: cohortKey,
          metric_key: gdKeys[gi],
          total: eligible,
          value: returned,
          rate: Math.round((returned / eligible) * 10000) / 10000,
        });
      }
    }
  }

  return rows;
}
