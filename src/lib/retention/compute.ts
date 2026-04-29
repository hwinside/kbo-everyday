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

/** W16 이전 코호트는 집계 제외 (본격 오픈 이전) */
const MIN_COHORT = "2026-W16";
/** 일별 코호트 시작일 */
const MIN_DAILY_COHORT = "2026-04-16";

/**
 * Paginated fetch to bypass Supabase 1000-row default limit.
 * queryFn builds a fresh query each call so .range() doesn't accumulate.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchAllPages<T>(queryFn: () => any): Promise<T[]> {
  const all: T[] = [];
  const batchSize = 1000;
  for (let from = 0; ; from += batchSize) {
    const { data, error } = await queryFn().range(from, from + batchSize - 1);
    if (error || !data || data.length === 0) break;
    all.push(...data);
    if (data.length < batchSize) break;
  }
  return all;
}

/**
 * 유저별 활동일 수집: posts, comments, likes, chat_messages, admin_page_views에서 활동일 추출.
 * broad revisit: 페이지 방문도 활동으로 포함.
 */
async function collectActivityDays(
  supabase: SupabaseClient,
  since: string,
): Promise<Map<string, Set<string>>> {
  const visitDays = new Map<string, Set<string>>();

  function addVisit(userId: string | null | undefined, createdAt: string) {
    if (!userId) return;
    const day = toKSTDateString(createdAt);
    if (!visitDays.has(userId)) visitDays.set(userId, new Set());
    visitDays.get(userId)!.add(day);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const q = (table: string, cols: string, extra?: (q: any) => any) => () => {
    let query = supabase.from(table).select(cols).gte("created_at", since).order("created_at", { ascending: true });
    if (extra) query = extra(query);
    return query;
  };

  const [posts, comments, likes, chats, pageViews] = await Promise.all([
    fetchAllPages<{ author_id: string; created_at: string }>(q("posts", "author_id, created_at")),
    fetchAllPages<{ author_id: string; created_at: string }>(q("comments", "author_id, created_at")),
    fetchAllPages<{ user_id: string; created_at: string }>(q("likes", "user_id, created_at")),
    fetchAllPages<{ user_id: string; created_at: string }>(q("chat_messages", "user_id, created_at")),
    fetchAllPages<{ user_id: string; created_at: string }>(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      q("admin_page_views", "user_id, created_at", (qb: any) => qb.not("user_id", "is", null)),
    ),
  ]);

  for (const r of posts) addVisit(r.author_id, r.created_at);
  for (const r of comments) addVisit(r.author_id, r.created_at);
  for (const r of likes) addVisit(r.user_id, r.created_at);
  for (const r of chats) addVisit(r.user_id, r.created_at);
  for (const r of pageViews) addVisit(r.user_id, r.created_at);

  return visitDays;
}

/**
 * 코호트 리텐션 집계: 가입 주차별 D1/D7/D14/D30 재활동율.
 * 활동 기준: posts/comments/likes/chat_messages에 해당 유저 레코드 존재.
 */
export async function computeCohortRetention(
  supabase: SupabaseClient,
  targetDate: string,
): Promise<MetricRow[]> {
  // 1) 최근 60일 가입자 + 가입일
  const sixtyDaysAgo = new Date(
    new Date(targetDate + "T00:00:00+09:00").getTime() - 60 * 86400000,
  ).toISOString();

  const profiles = await fetchAllPages<{ id: string; created_at: string }>(
    () => supabase.from("profiles").select("id, created_at").gte("created_at", sixtyDaysAgo).order("created_at", { ascending: true }),
  );

  if (!profiles.length) return [];

  // 2) 같은 기간 활동 데이터 수집
  const visitDays = await collectActivityDays(supabase, sixtyDaysAgo);

  // 3) 코호트별 D-N 잔존율 계산
  const dayOffsets = [1, 2, 3, 4, 5, 6, 7, 14, 30];
  const cohorts = new Map<string, { users: { id: string; signupDate: string }[] }>();

  for (const p of profiles) {
    const signupDate = toKSTDateString(p.created_at);
    const week = isoWeek(signupDate);
    if (!cohorts.has(week)) cohorts.set(week, { users: [] });
    cohorts.get(week)!.users.push({ id: p.id, signupDate });
  }

  const rows: MetricRow[] = [];
  for (const [cohortKey, { users }] of cohorts) {
    // W16 이전 코호트는 스킵
    if (cohortKey < MIN_COHORT) continue;

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
 * 일별 코호트 리텐션 집계: 가입일별 D1~D7/D14/D30 재활동율.
 * 주간 코호트와 병렬로 운영, metric_type="daily_cohort".
 */
export async function computeDailyCohortRetention(
  supabase: SupabaseClient,
  targetDate: string,
): Promise<MetricRow[]> {
  const sixtyDaysAgo = new Date(
    new Date(targetDate + "T00:00:00+09:00").getTime() - 60 * 86400000,
  ).toISOString();

  const profiles = await fetchAllPages<{ id: string; created_at: string }>(
    () => supabase.from("profiles").select("id, created_at").gte("created_at", sixtyDaysAgo).order("created_at", { ascending: true }),
  );

  if (!profiles.length) return [];

  const visitDays = await collectActivityDays(supabase, sixtyDaysAgo);

  const dayOffsets = [1, 2, 3, 4, 5, 6, 7, 14, 30];
  const cohorts = new Map<string, { id: string; signupDate: string }[]>();

  for (const p of profiles) {
    const signupDate = toKSTDateString(p.created_at);
    if (signupDate < MIN_DAILY_COHORT) continue;
    if (!cohorts.has(signupDate)) cohorts.set(signupDate, []);
    cohorts.get(signupDate)!.push({ id: p.id, signupDate });
  }

  const rows: MetricRow[] = [];
  for (const [cohortDate, users] of cohorts) {
    for (const dN of dayOffsets) {
      let returned = 0;
      let eligible = 0;
      for (const u of users) {
        const targetDay = new Date(
          new Date(u.signupDate + "T00:00:00+09:00").getTime() + dN * 86400000,
        ).toISOString().slice(0, 10);
        if (targetDay > targetDate) continue;
        eligible++;
        if (visitDays.get(u.id)?.has(targetDay)) returned++;
      }
      if (eligible > 0) {
        rows.push({
          date: targetDate,
          metric_type: "daily_cohort",
          cohort_key: cohortDate,
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
 * Activation Funnel 집계: 가입→팀선택→첫글쓰기→첫댓글→첫채팅.
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

  // 첫 글쓰기
  const postUsers = await fetchAllPages<{ author_id: string }>(
    () => supabase.from("posts").select("author_id").lte("created_at", targetDate + "T23:59:59+09:00").order("created_at", { ascending: true }),
  );
  const uniquePostUsers = new Set(postUsers.map((r) => r.author_id)).size;

  // 첫 댓글
  const commentUsers = await fetchAllPages<{ author_id: string }>(
    () => supabase.from("comments").select("author_id").lte("created_at", targetDate + "T23:59:59+09:00").order("created_at", { ascending: true }),
  );
  const uniqueCommentUsers = new Set(commentUsers.map((r) => r.author_id)).size;

  // 첫 채팅
  const chatUsers = await fetchAllPages<{ user_id: string }>(
    () => supabase.from("chat_messages").select("user_id").lte("created_at", targetDate + "T23:59:59+09:00").order("created_at", { ascending: true }),
  );
  const uniqueChatUsers = new Set(chatUsers.map((r) => r.user_id)).size;

  const steps = [
    { key: "signup", value: totalSignups },
    { key: "team_select", value: teamSelected ?? 0 },
    { key: "first_post", value: uniquePostUsers },
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
 * 재방문 횟수별 유저 분포: 최근 30일 내 활동일 수 기준으로 유저를 버킷팅.
 * 1회, 2회, ..., 9회, 10회 이상.
 */
export async function computeVisitDistribution(
  supabase: SupabaseClient,
  targetDate: string,
): Promise<MetricRow[]> {
  const thirtyDaysAgo = new Date(
    new Date(targetDate + "T00:00:00+09:00").getTime() - 30 * 86400000,
  ).toISOString();

  const visitDays = await collectActivityDays(supabase, thirtyDaysAgo);

  // 활동이 1회 이상인 유저만 카운트
  const buckets = new Map<string, number>();
  for (let i = 1; i <= 9; i++) buckets.set(String(i), 0);
  buckets.set("10+", 0);

  for (const [, days] of visitDays) {
    const count = days.size;
    if (count <= 0) continue;
    const key = count >= 10 ? "10+" : String(count);
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }

  const total = Array.from(buckets.values()).reduce((a, b) => a + b, 0);
  if (total === 0) return [];

  const rows: MetricRow[] = [];
  for (const [bucket, count] of buckets) {
    rows.push({
      date: targetDate,
      metric_type: "visit_dist",
      cohort_key: "all",
      metric_key: bucket,
      total,
      value: count,
      rate: Math.round((count / total) * 10000) / 10000,
    });
  }
  return rows;
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

  const profiles = await fetchAllPages<{ id: string; created_at: string }>(
    () => supabase.from("profiles").select("id, created_at").gte("created_at", sixtyDaysAgo).order("created_at", { ascending: true }),
  );

  if (!profiles.length) return [];

  // 활동 데이터 수집
  const visitDays = await collectActivityDays(supabase, sixtyDaysAgo);

  // 유저별: 가입일 이후 경기일 목록 (시간순), 그 중 활동한 경기일 체크
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
    // W16 이전 코호트는 스킵
    if (cohortKey < MIN_COHORT) continue;

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
