export interface DailyStat {
  date: string;
  uv: number;
  pv: number;
  newUsers: number;
  posts: number;
  comments: number;
  photos: number;
  predictions: number;
}

export interface KpiData {
  label: string;
  value: number;
  prev: number;
  format?: "number" | "percent";
}

export interface PageViewRank {
  path: string;
  label: string;
  views: number;
}

export interface AnomalyLog {
  id: number;
  type: string;
  severity: "info" | "warning" | "critical";
  message: string;
  details?: Record<string, unknown>;
  acknowledged: boolean;
  createdAt: string;
}

export interface JobInfo {
  name: string;
  label: string;
  schedule: string;
  lastRun: string;
  duration: number;
  status: "success" | "running" | "error";
  description: string;
}

export interface JobLog {
  id: number;
  jobName: string;
  status: "success" | "running" | "error";
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  resultSummary: string | null;
  errorMessage: string | null;
}

export type FeedbackStatus =
  | "pending"
  | "reviewing"
  | "in_progress"
  | "resolved"
  | "rejected"
  | "duplicate"
  | "received"
  | "done";

export interface FeedbackItem {
  id: string;
  userId: string;
  userNickname: string | null;
  type: "bug" | "data" | "feature" | "content" | "android_test" | "other";
  title: string;
  body: string | null;
  pageUrl: string | null;
  deviceInfo: string | null;
  status: FeedbackStatus;
  adminNote: string | null;
  createdAt: string;
}

export interface CohortRow {
  week: string;
  cohortSize: number;
  retention: number[]; // D0..D30 percentages
}

export interface PerfMetric {
  path: string;
  metricName: string;
  value: number;
  createdAt: string;
}

export type AdminTab = "overview" | "users" | "retention" | "content" | "jobs" | "feedback" | "system";

export interface RetentionMetric {
  date: string;
  metricType: "cohort" | "funnel" | "gameday";
  cohortKey: string;
  metricKey: string;
  total: number;
  value: number;
  rate: number;
}

/** 코호트 히트맵 행: D0(가입 당일)~D7/D14/D30 활동율 */
export interface CohortHeatmapRow {
  cohortKey: string;
  cohortSize: number;
  d0: number;
  d1: number;
  d2: number;
  d3: number;
  d4: number;
  d5: number;
  d6: number;
  d7: number;
  d14: number;
  d30: number;
}

/** Activation 퍼널 단계 */
export interface FunnelStep {
  step: string;
  label: string;
  count: number;
  rate: number;
}

/** 롤링 윈도우 리텐션 행: 가입 후 W1(1~7일)·W2(8~14)·W3(15~21)·W4(22~28) 각 구간 1회+ 재활동율 */
export interface RollingRetentionRow {
  cohortKey: string;
  cohortSize: number;
  w1: number;
  w2: number;
  w3: number;
  w4: number;
}

/** 게임데이 리텐션 행 */
export interface GamedayRetention {
  cohortKey: string;
  cohortSize: number;
  gd1: number;
  gd2: number;
  gd3: number;
}

/** 재방문 횟수 분포 */
export interface VisitDistBucket {
  bucket: string;   // "1", "2", ..., "9", "10+"
  count: number;
}
