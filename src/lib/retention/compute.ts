import { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllByKeyset } from "@/lib/db/paginate";
import { toKSTDateString, addKSTDays } from "@/lib/utils/date-kst";

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
  // KST 캘린더 날짜(YYYY-MM-DD) 자체를 UTC 자정으로 잡아 요일 계산.
  // (이전엔 dateStr+"+09:00" instant의 getUTCDay를 읽어 KST 월요일이 전날 UTC 일요일로
  //  밀려 주 경계가 표시단 weekToMonday와 어긋났음 — 예: 06-29가 W26으로 오분류.)
  const [y, m, day] = dateStr.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1, day));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

/**
 * page_view(방문) 적재가 RLS 수정(#446)으로 복구된 6/26부터만 broad 리텐션이
 * 일관되게 집계됨. 그 전 코호트는 눈팅 방문이 누락돼 과소집계되므로 제외한다.
 * (6/25는 마이그레이션이 낮에 배포돼 반나절만 잡힌 부분치라 함께 제외)
 */
const MIN_DAILY_COHORT = "2026-06-26";
/** 주간 코호트도 page_view 계측이 온전한 주부터. W26은 6/25(미계측일)를 포함하므로 W27부터. */
const MIN_COHORT = "2026-W27";

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
    if (error) throw new Error(`[retention] page ${from / batchSize + 1}: ${error.message}`);
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < batchSize) break;
  }
  return all;
}

/**
 * 유저별 활동일 수집: posts, comments, likes, chat_messages와 page-view 일별 rollup에서 추출.
 * broad revisit: 페이지 방문도 활동으로 포함.
 * untilExclusive(2026-07-21 추가, 삼순 리뷰): targetDate 익일 KST 00:00 exclusive 상한 —
 * backfill 시 미래 활동이 과거 행에 섞이는 것을 원천 차단(visit_dist는 일 수 카운트라 상한 필수,
 * 나머지 축은 특정일 매칭이라 의미론 no-op이지만 fetch 절감 + 계약 통일).
 * exclusive(.lt)인 이유: `<= 23:59:59` 형태는 23:59:59.500 같은 마지막 1초 fractional
 * timestamp를 누락(삼순 3차 리뷰 재현) — 익일 00:00 미만으로 경계 손실 없이 포함.
 */
async function collectActivityDays(
  supabase: SupabaseClient,
  since: string,
  untilExclusive: string,
): Promise<Map<string, Set<string>>> {
  const visitDays = new Map<string, Set<string>>();

  function addVisit(userId: string | null | undefined, createdAt: string) {
    if (!userId) return;
    const day = toKSTDateString(createdAt);
    if (!visitDays.has(userId)) visitDays.set(userId, new Set());
    visitDays.get(userId)!.add(day);
  }

  function addVisitDay(userId: string | null | undefined, day: string) {
    if (!userId) return;
    if (!visitDays.has(userId)) visitDays.set(userId, new Set());
    visitDays.get(userId)!.add(day);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const q = (table: string, cols: string, extra?: (q: any) => any) => () => {
    let query = supabase.from(table).select(cols).gte("created_at", since).lt("created_at", untilExclusive).order("created_at", { ascending: true });
    if (extra) query = extra(query);
    return query;
  };

  const pageViewSinceDay = toKSTDateString(since);
  const pageViewUntilDay = untilExclusive.slice(0, 10);
  const [posts, comments, likes, chats, pageViewDays] = await Promise.all([
    fetchAllPages<{ author_id: string; created_at: string }>(q("posts", "author_id, created_at")),
    fetchAllPages<{ author_id: string; created_at: string }>(q("comments", "author_id, created_at")),
    fetchAllPages<{ user_id: string; created_at: string }>(q("likes", "user_id, created_at")),
    fetchAllPages<{ user_id: string; created_at: string }>(q("chat_messages", "user_id, created_at")),
    // user-day rollup도 keyset 유지 (2026-07-22 장애 후속 — OFFSET 재스캔 O(n²) 방지, #801)
    fetchAllByKeyset<{ id: number; user_id: string; day_kst: string }, number>(async (cursor, limit) => {
      let query = supabase.from("admin_page_view_user_days")
        .select("id, user_id, day_kst")
        .gte("day_kst", pageViewSinceDay)
        .lt("day_kst", pageViewUntilDay)
        .order("id", { ascending: true })
        .limit(limit);
      if (cursor !== null) query = query.gt("id", cursor);
      const { data, error } = await query;
      return { data: data as { id: number; user_id: string; day_kst: string }[] | null, error };
    }, (row) => row.id, { label: "retention page-view user days" }),
  ]);

  for (const r of posts) addVisit(r.author_id, r.created_at);
  for (const r of comments) addVisit(r.author_id, r.created_at);
  for (const r of likes) addVisit(r.user_id, r.created_at);
  for (const r of chats) addVisit(r.user_id, r.created_at);
  for (const r of pageViewDays) addVisitDay(r.user_id, r.day_kst);

  return visitDays;
}

/**
 * 코호트 리텐션 집계: 가입 주차별 D1/D7/D14/D30 재활동율.
 * 활동 기준: posts/comments/likes/chat_messages에 해당 유저 레코드 존재.
 */
/**
 * 고정 horizon Rolling Retention(metric_type="rolling", 삼순 리뷰 반영 2026-07-25).
 *
 * 기존 cohort/daily_cohort exact single-day 지표("가입+정확히 N일째 그 하루")는
 * KBO 무경기일(올스타 브레이크 등)에 통째로 휘둘려 D14>D7 역전처럼 리텐션
 * 곡선으로 오독되기 쉽다. 주차 비겹침 구간(W1~W4)은 독립이라 단조감소 미보장
 * (삼순 리뷰). 대신 **고정 horizon** Rolling: 각 anchor k는 [Dk, D_horizon] 구간 중 1회+.
 * 구간이 포함관계(⊃)이고 분모(eligible)가 같은 horizon 내 동일(가입+horizon 경과한
 * 성숙 코호트)이므로 R1 ≥ R7 ≥ … 단조 비증가 수학 보장(깨끗한 곡선).
 *
 * **2개 horizon 병행(삼순 리뷰 2차)**: 28일만 쓰면 현재 최소 코호트(2026-W27)가 D28
 * 미성숙이라 차트가 빈다. 그래서 **14일**(R1=[D1,D14]/R7=[D7,D14]/R14=D14, D14 성숙 코호트라
 * 지금 바로 노출) + **28일**(R1~R28, 성숙 시)을 함께 생성. metric_key = `h{horizon}_r{anchor}`.
 * total 필드 = 해당 horizon의 성숙 분모 n — 표시단이 "부분 코호트"(예: 6/29만 든 W27)를
 * 구분하도록 n을 노출한다. 예산/스캔 가드: 독립 스캔 없이 computeCohortRetention의
 * profiles+visitDays를 재사용해 추가 전수스캔 0(300초 cron 상한 영향 없음).
 */
const ROLLING_HORIZONS: { horizon: number; anchors: number[] }[] = [
  { horizon: 14, anchors: [1, 7, 14] },
  { horizon: 28, anchors: [1, 7, 14, 21, 28] },
];

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
  const visitDays = await collectActivityDays(supabase, sixtyDaysAgo, addKSTDays(targetDate, 1) + "T00:00:00+09:00");

  // 3) 코호트별 D-N 잔존율 계산 (D0 = 가입 당일 활동)
  const dayOffsets = [0, 1, 2, 3, 4, 5, 6, 7, 14, 30];
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
        const targetDay = addKSTDays(u.signupDate, dN);
        // D-N이 아직 안 지났거나 '오늘'(진행 중, 미완료)인 유저는 eligible 제외 →
        // 완료된 날 관측만 집계해 최근 주 D-N이 낮게 왜곡되는 것 방지.
        if (targetDay >= targetDate) continue;
        eligible++;
        // D0(가입일)은 가입 자체를 활동으로 인정 → 기준선 100% 고정(표준 코호트 앵커).
        // 실제 재방문율은 D1부터. (가입만 하고 활동 로그 없는 유저가 D0를 깎던 것 방지)
        if (dN === 0 || visitDays.get(u.id)?.has(targetDay)) returned++;
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

    // 고정 horizon Rolling Retention(14일+28일) — 같은 users/visitDays 재사용(추가 스캔 0).
    // 각 horizon별로 성숙(가입+horizon 경과) 코호트만 분모 — horizon 내 동일 분모라 단조 보장.
    for (const { horizon, anchors } of ROLLING_HORIZONS) {
      for (const start of anchors) {
        let returned = 0;
        let eligible = 0;
        for (const u of users) {
          const windowEnd = addKSTDays(u.signupDate, horizon);
          // D_horizon까지 성숙하지 않은(진행 중 포함) 코호트는 제외 → horizon 내 동일 분모 유지.
          if (windowEnd >= targetDate) continue;
          eligible++;
          // [start, horizon] 구간 중 하루라도 활동일이 있으면 잔존(구간 누적, exact-day 아님).
          const days = visitDays.get(u.id);
          if (days) {
            for (let d = start; d <= horizon; d++) {
              if (days.has(addKSTDays(u.signupDate, d))) { returned++; break; }
            }
          }
        }
        // 성숙 코호트가 없으면(eligible=0) row 자체를 만들지 않음 → 미집계를 0%로 그리지 않게(삼순 리뷰).
        if (eligible > 0) {
          rows.push({
            date: targetDate,
            metric_type: "rolling",
            cohort_key: cohortKey,
            metric_key: `h${horizon}_r${start}`,
            total: eligible,
            value: returned,
            rate: Math.round((returned / eligible) * 10000) / 10000,
          });
        }
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

  const visitDays = await collectActivityDays(supabase, sixtyDaysAgo, addKSTDays(targetDate, 1) + "T00:00:00+09:00");

  const dayOffsets = [0, 1, 2, 3, 4, 5, 6, 7, 14, 30];
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
        const targetDay = addKSTDays(u.signupDate, dN);
        if (targetDay > targetDate) continue;
        eligible++;
        // D0(가입일)은 가입 자체를 활동으로 인정 → 기준선 100% 고정(주간 코호트와 동일).
        if (dN === 0 || visitDays.get(u.id)?.has(targetDay)) returned++;
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
 * Activation Funnel 집계 (활성화 완료 기준 = 3조건 AND):
 *   ① 최애팀 지정  ② 최애선수 1명 이상 지정  ③ 서로 다른 경기 1개 이상 방문
 * MIN_DAILY_COHORT(데이터 온전 시점) 이후 가입 코호트 기준. 완료율 카드 = 마지막 스텝(activated).
 */
export async function computeActivationFunnel(
  supabase: SupabaseClient,
  targetDate: string,
): Promise<MetricRow[]> {
  const until = targetDate + "T23:59:59+09:00";

  // "데이터 제대로 쌓인" 시점(MIN_DAILY_COHORT) 이후 가입 코호트만.
  const cohortProfiles = await fetchAllPages<{ id: string; team_id: number | null; favorite_players: unknown }>(
    () => supabase.from("profiles").select("id, team_id, favorite_players")
      .gte("created_at", MIN_DAILY_COHORT + "T00:00:00+09:00")
      .lte("created_at", until)
      .order("created_at", { ascending: true }),
  );
  const cohortIds = new Set(cohortProfiles.map((p) => p.id));
  const totalSignups = cohortIds.size;

  if (!totalSignups) return [];

  // ① 최애팀 지정 (team_id not null)
  const teamSet = new Set(cohortProfiles.filter((p) => p.team_id != null).map((p) => p.id));

  // ② 최애선수 1명 이상 (favorite_players jsonb 배열 길이 >= 1)
  const players1Set = new Set(
    cohortProfiles
      .filter((p) => Array.isArray(p.favorite_players) && p.favorite_players.length >= 1)
      .map((p) => p.id),
  );

  // ③ 서로 다른 경기 1개 이상 방문. user/day rollup은 365일 뒤 purge되므로
  // purge와 분리 보존되는 사용자별 lifetime 최초 경기방문 상태를 읽는다 (PR #773).
  // (keyset 유지 — #801 OFFSET 재스캔 O(n²) 방지 사유 동일)
  const lifetimeGameVisits = await fetchAllByKeyset<{ user_id: string }, string>(
    async (cursor, limit) => {
      let query = supabase.from("admin_user_game_lifetime").select("user_id")
        .lte("first_game_day_kst", targetDate)
        .order("user_id", { ascending: true })
        .limit(limit);
      if (cursor !== null) query = query.gt("user_id", cursor);
      const { data, error } = await query;
      return { data: data as { user_id: string }[] | null, error };
    },
    (row) => row.user_id,
    { label: "activation lifetime game visits" },
  );
  const games1Set = new Set(
    lifetimeGameVisits.map((row) => row.user_id).filter((id) => cohortIds.has(id)),
  );

  // 활성화 완료 = ①②③ 모두 충족
  let activated = 0;
  for (const id of cohortIds) {
    if (teamSet.has(id) && players1Set.has(id) && games1Set.has(id)) activated++;
  }

  const steps = [
    { key: "signup", value: totalSignups },
    { key: "fav_team", value: teamSet.size },
    { key: "fav_players_1", value: players1Set.size },
    { key: "games_1plus", value: games1Set.size },
    { key: "activated", value: activated },
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

  const visitDays = await collectActivityDays(supabase, thirtyDaysAgo, addKSTDays(targetDate, 1) + "T00:00:00+09:00");

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
  const visitDays = await collectActivityDays(supabase, sixtyDaysAgo, addKSTDays(targetDate, 1) + "T00:00:00+09:00");

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
