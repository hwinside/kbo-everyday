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

export interface FeedbackItem {
  id: number;
  userId: string;
  type: "bug" | "data" | "feature" | "content" | "other";
  title: string;
  body: string | null;
  pageUrl: string | null;
  deviceInfo: string | null;
  status: "pending" | "received" | "reviewing" | "done" | "rejected";
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

export type AdminTab = "overview" | "users" | "content" | "jobs" | "feedback" | "system";
