import type {
  DailyStat,
  KpiData,
  PageViewRank,
  AnomalyLog,
  JobInfo,
  JobLog,
  FeedbackItem,
  CohortRow,
} from "./types";

// Helper: generate date strings for last N days
function lastNDays(n: number): string[] {
  const dates: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

function rand(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Seeded-ish deterministic mock (same structure every call but different values)
const DATES_30 = lastNDays(30);

export function generateDailyStats(): DailyStat[] {
  return DATES_30.map((date, i) => {
    const base = 800 + i * 15;
    return {
      date,
      uv: base + rand(-50, 100),
      pv: base * 3 + rand(-100, 300),
      newUsers: rand(15, 60),
      posts: rand(30, 120),
      comments: rand(80, 350),
      photos: rand(5, 30),
      predictions: rand(40, 200),
    };
  });
}

export function generateKpis(stats: DailyStat[]): KpiData[] {
  const today = stats[stats.length - 1];
  const yesterday = stats[stats.length - 2];
  return [
    { label: "UV", value: today.uv, prev: yesterday.uv },
    { label: "PV", value: today.pv, prev: yesterday.pv },
    { label: "가입자", value: today.newUsers, prev: yesterday.newUsers },
    { label: "게시글", value: today.posts, prev: yesterday.posts },
    { label: "댓글", value: today.comments, prev: yesterday.comments },
    { label: "직찍", value: today.photos, prev: yesterday.photos },
  ];
}

export function generatePopularPages(): PageViewRank[] {
  return [
    { path: "/", label: "홈", views: 4820 },
    { path: "/game", label: "경기 트래커", views: 3654 },
    { path: "/stats", label: "선수 스탯", views: 2930 },
    { path: "/community", label: "커뮤니티", views: 2415 },
    { path: "/prediction", label: "승부예측", views: 2180 },
    { path: "/news", label: "뉴스 피드", views: 1876 },
    { path: "/highlights", label: "하이라이트", views: 1543 },
    { path: "/standings", label: "순위표", views: 1290 },
    { path: "/stadium", label: "구장 가이드", views: 987 },
    { path: "/player/123", label: "선수 프로필", views: 856 },
  ];
}

export function generateAnomalies(): AnomalyLog[] {
  return [
    {
      id: 1,
      type: "traffic",
      severity: "warning",
      message: "UV가 전일 대비 52% 감소했습니다",
      acknowledged: false,
      createdAt: new Date(Date.now() - 3600000).toISOString(),
    },
    {
      id: 2,
      type: "crawler",
      severity: "critical",
      message: "KBO 크롤러 3회 연속 실패",
      details: { lastError: "TIMEOUT" },
      acknowledged: false,
      createdAt: new Date(Date.now() - 7200000).toISOString(),
    },
  ];
}

export function generateJobInfos(): JobInfo[] {
  return [
    {
      name: "kbo-scores",
      label: "KBO 스코어 크롤러",
      schedule: "매 5분",
      lastRun: new Date(Date.now() - 300000).toISOString(),
      duration: 2400,
      status: "success",
      description: "KBO 공식 사이트에서 실시간 스코어 수집",
    },
    {
      name: "naver-news",
      label: "네이버 뉴스 크롤러",
      schedule: "매 30분",
      lastRun: new Date(Date.now() - 1800000).toISOString(),
      duration: 5300,
      status: "success",
      description: "네이버 스포츠 뉴스 수집",
    },
    {
      name: "youtube-highlights",
      label: "유튜브 하이라이트",
      schedule: "매 1시간",
      lastRun: new Date(Date.now() - 3600000).toISOString(),
      duration: 8200,
      status: "error",
      description: "구단별 유튜브 채널 하이라이트 수집",
    },
    {
      name: "stats-update",
      label: "선수 스탯 업데이트",
      schedule: "매일 06:00",
      lastRun: new Date(Date.now() - 86400000).toISOString(),
      duration: 45000,
      status: "success",
      description: "KBO 선수 기록 일괄 업데이트",
    },
    {
      name: "daily-aggregation",
      label: "일별 집계 배치",
      schedule: "매일 00:05",
      lastRun: new Date(Date.now() - 86400000).toISOString(),
      duration: 12000,
      status: "success",
      description: "일별 통계 집계 (UV/PV/가입/게시글)",
    },
    {
      name: "anomaly-check",
      label: "이상 감지 체크",
      schedule: "매 10분",
      lastRun: new Date(Date.now() - 600000).toISOString(),
      duration: 1200,
      status: "success",
      description: "트래픽/에러율/성능 이상 감지",
    },
  ];
}

export function generateJobLogs(): JobLog[] {
  const jobs = ["kbo-scores", "naver-news", "youtube-highlights", "stats-update", "daily-aggregation", "anomaly-check"];
  const logs: JobLog[] = [];
  for (let i = 0; i < 100; i++) {
    const jobName = jobs[i % jobs.length];
    const startedAt = new Date(Date.now() - i * 600000);
    const isError = jobName === "youtube-highlights" && i < 6;
    const duration = rand(1000, 15000);
    logs.push({
      id: 100 - i,
      jobName,
      status: isError ? "error" : "success",
      startedAt: startedAt.toISOString(),
      finishedAt: new Date(startedAt.getTime() + duration).toISOString(),
      durationMs: duration,
      resultSummary: isError ? null : `처리 완료`,
      errorMessage: isError ? "YouTube API quota exceeded" : null,
    });
  }
  return logs;
}

export function generateFeedbackItems(): FeedbackItem[] {
  const types: FeedbackItem["type"][] = ["bug", "data", "feature", "content", "other"];
  const statuses: FeedbackItem["status"][] = ["received", "reviewing", "done", "rejected"];
  const titles = [
    "앱 로딩이 너무 느려요",
    "선수 사진이 안 보여요",
    "다크 모드 글씨가 안 보여요",
    "구장 가이드에 주차장 정보 추가해주세요",
    "승부예측 결과 알림 기능 원해요",
    "KIA 선수 이적 정보가 안 맞아요",
    "하이라이트 영상 재생 오류",
    "커뮤니티 신고 기능 필요해요",
    "LG 팀 컬러가 이상해요",
    "실시간 채팅 기능 추가 부탁",
    "iOS에서 알림이 안 옵니다",
    "삼성 2군 선수 정보 없음",
    "게시글 수정 시 이미지가 사라져요",
    "예측 포인트 랭킹 기능 원해요",
    "경기 일정 위젯 부탁드려요",
  ];
  return titles.map((title, i) => ({
    id: i + 1,
    userId: `user-${rand(100, 999)}`,
    type: types[i % types.length],
    title,
    body: i % 3 === 0 ? "상세 내용입니다. 이런 저런 상황에서 발생합니다." : null,
    pageUrl: i % 2 === 0 ? "/game" : null,
    deviceInfo: i % 2 === 0 ? "iPhone 15 / iOS 18" : "Galaxy S24 / Android 15",
    status: statuses[i % statuses.length],
    adminNote: i % 4 === 2 ? "확인 완료, 다음 릴리즈에 반영" : null,
    createdAt: new Date(Date.now() - i * 86400000).toISOString(),
  }));
}

export function generateCohortData(): CohortRow[] {
  const weeks: CohortRow[] = [];
  for (let w = 7; w >= 0; w--) {
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - w * 7);
    const label = `${weekStart.getMonth() + 1}/${weekStart.getDate()}주`;
    const cohortSize = rand(40, 120);
    const retention: number[] = [];
    let rate = 100;
    for (let d = 0; d <= 30; d++) {
      if (d === 0) {
        retention.push(100);
      } else {
        rate = Math.max(0, rate - rand(2, 8));
        retention.push(d <= (7 - w) * 4 ? rate : -1); // -1 means no data yet
      }
    }
    weeks.push({ week: label, cohortSize, retention });
  }
  return weeks;
}

export const TEAM_DISTRIBUTION = [
  { team: "LG", value: 18, color: "#C60C30" },
  { team: "두산", value: 14, color: "#131230" },
  { team: "KT", value: 9, color: "#E85050" },
  { team: "SSG", value: 11, color: "#CE0E2D" },
  { team: "NC", value: 8, color: "#315288" },
  { team: "KIA", value: 15, color: "#EA0029" },
  { team: "롯데", value: 7, color: "#002856" },
  { team: "삼성", value: 10, color: "#074CA1" },
  { team: "한화", value: 5, color: "#FF6600" },
  { team: "키움", value: 3, color: "#820024" },
];

export const LEVEL_DISTRIBUTION = [
  { level: "Lv.1 루키", count: 420 },
  { level: "Lv.2 레귤러", count: 285 },
  { level: "Lv.3 올스타", count: 156 },
  { level: "Lv.4 MVP", count: 67 },
  { level: "Lv.5 레전드", count: 12 },
];

export const API_USAGE = [
  { name: "Naver News", daily: 2400, limit: 10000, color: "#30D158" },
  { name: "YouTube Data", daily: 890, limit: 5000, color: "#FF453A" },
  { name: "KBO 크롤링", daily: 1440, limit: 0, color: "#6366F1" },
];

export const PERF_METRICS = {
  lcp: { p50: 1.2, p95: 2.8, p99: 4.1 },
  fid: { p50: 12, p95: 45, p99: 120 },
  cls: { p50: 0.02, p95: 0.08, p99: 0.15 },
  apiResponseMs: { p50: 85, p95: 320, p99: 890 },
  errorRate: 0.8,
};

export const DEPLOY_HISTORY = [
  { id: 1, version: "v0.9.2", env: "production", status: "success", deployedAt: new Date(Date.now() - 86400000).toISOString(), duration: 62 },
  { id: 2, version: "v0.9.1", env: "production", status: "success", deployedAt: new Date(Date.now() - 259200000).toISOString(), duration: 58 },
  { id: 3, version: "v0.9.0", env: "production", status: "success", deployedAt: new Date(Date.now() - 604800000).toISOString(), duration: 71 },
  { id: 4, version: "v0.8.9", env: "preview", status: "failed", deployedAt: new Date(Date.now() - 691200000).toISOString(), duration: 45 },
];
