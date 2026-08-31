/**
 * 공유 YouTube Data API quota 원장 헬퍼.
 *
 * 여러 크론(videos-rss fallback/backfill, youtube-highlights _ALL 검색,
 * videos-player-shorts, channel-discovery)이 하나의 프로젝트 quota를 소비한다.
 * 조율이 없으면 앞선 잡이 quota를 먼저 소진해 뒤 잡이 통째로 403 degrade 된다
 * (2026-07-19: 선수 숏츠 하루 4회 중 3회가 quota 0으로 헛돎).
 *
 * 이 원장으로 각 API 호출 전에 `reserveQuota`로 소비분을 원자적으로 예약해서
 *  · 남은 quota가 없으면 doomed 호출을 아예 건너뛰고(=warning degrade)
 *  · 여러 잡이 공유 상한을 넘지 않게 한다.
 * 원장 RPC 자체가 실패하면(테이블 미배포·일시 오류) 파이프라인을 막지 않고
 * 기존 런타임 403 백스톱에 맡긴다(allowed=true + ledgerError).
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * YouTube Data API 단위 비용(고정).
 *  · search.list = 100 units/call
 *  · videos.list(contentDetails/snippet) = 1 unit/call
 * 소비 기록은 "실제 시도한 호출당" 이 비용을 누적한다(삼순 #709 2번).
 */
export const YT_UNITS_SEARCH = 100;
export const YT_UNITS_VIDEOS_LIST = 1;
export const YT_UNITS_PLAYLIST_ITEMS = 1;

/**
 * 프로젝트의 절대 quota 상한(하드 리밋). Google 기본 프로젝트 한도 = 10,000/day.
 * env·호출부가 이 값을 넘겨도 TS·RPC 양쪽에서 강제로 clamp 한다(삼순 #709 2번:
 * 10M 허용이 한도 우회로 이어져 절대 yield 안 하는 상태 방지). quota 증량이
 * 실제로 승인되면 이 상수 + 마이그레이션을 함께 올린다.
 */
export const YT_QUOTA_HARD_MAX = 10_000;

/**
 * 공유 quota 상한 기본값. 프로젝트 한도(10,000)에서 유저 대면 라우트 record 소비용
 * 마진을 뺀 값. env로 조절하되 [1, YT_QUOTA_HARD_MAX] 로 clamp.
 * 비정상값(NaN/≤0)은 fail-closed — 기본 9500으로 폴백.
 */
export const YT_QUOTA_DAILY_DEFAULT = 9500;
export function resolveQuotaCap(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return YT_QUOTA_DAILY_DEFAULT;
  // 하드 리밋 강제: 절대 프로젝트 한도(10k)를 초과하지 못함.
  return Math.min(Math.floor(n), YT_QUOTA_HARD_MAX);
}
export const YT_QUOTA_DAILY_CAP = resolveQuotaCap(process.env.YT_QUOTA_DAILY_CAP);

/**
 * Google YouTube quota는 Pacific(America/Los_Angeles) 자정에 리셋되므로
 * 원장 키를 Pacific 날짜로 잡는다(KST 16:00 경계와 일치).
 */
export function getQuotaDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now); // "YYYY-MM-DD"
}

// ─────────────────────────────────────────────────────────────────────
//  실제 시도 단위 quota 카운터 (유저 라우트: reserve 안 하고 사후 record)
// ─────────────────────────────────────────────────────────────────────

/** 라우트 1회 처리 동안 실제 시도한 API 호출의 quota 단위를 누적. */
export interface QuotaCounter {
  /** 누적 units */
  units: number;
  /** 실제 시도한 search.list 호출 수 */
  searches: number;
  /** 실제 시도한 videos.list 호출 수 */
  videoLists: number;
  /** 실제 시도한 playlistItems.list 호출 수 */
  playlistItems: number;
}
export function newQuotaCounter(): QuotaCounter {
  return { units: 0, searches: 0, videoLists: 0, playlistItems: 0 };
}
/** search.list 1회 시도 기록 */
export function countSearch(c: QuotaCounter | undefined): void {
  if (!c) return;
  c.searches += 1;
  c.units += YT_UNITS_SEARCH;
}
/** videos.list 1회 시도 기록 */
export function countVideoList(c: QuotaCounter | undefined): void {
  if (!c) return;
  c.videoLists += 1;
  c.units += YT_UNITS_VIDEOS_LIST;
}
/** playlistItems.list 1회 시도 기록 (uploads 폴링, 1 unit) */
export function countPlaylistItems(c: QuotaCounter | undefined): void {
  if (!c) return;
  c.playlistItems += 1;
  c.units += YT_UNITS_PLAYLIST_ITEMS;
}

/**
 * counter 를 생성해 fn 에 넘기고, **모든 종료 경로(성공·조기 return·예외)** 에서
 * 실제 시도한 units 를 finally 로 정확히 1회 durable 기록한다(삼순 #709 3번).
 * fetch/res.json() 가 throw 해 fn 이 중단되어도 이미 소비된 search(100) 를 undercount 하지 않는다.
 * `record` 콜백은 throw 하지 않아야 한다(원본 예외 마스킹 방지). units=0이면 기록 생략.
 */
export async function withQuotaRecording<T>(
  record: (units: number) => Promise<unknown>,
  fn: (counter: QuotaCounter) => Promise<T>,
): Promise<T> {
  const counter = newQuotaCounter();
  try {
    return await fn(counter);
  } finally {
    if (counter.units > 0) await record(counter.units);
  }
}

// ─────────────────────────────────────────────────────────────────────
//  구조화된 YouTube API quota 시그널 감지 (공용)
// ─────────────────────────────────────────────────────────────────────

/** quota/rate 관련 googleapis error reason(소문자) */
const QUOTA_REASONS = new Set([
  "quotaexceeded",
  "dailylimitexceeded",
  "ratelimitexceeded",
  "userratelimitexceeded",
  "servinglimitexceeded",
]);

/** YouTube API 호출 실패를 status/reason과 함께 실어 나르는 에러(문자열 손실 방지). */
export class YouTubeApiError extends Error {
  status?: number;
  reason?: string;
  constructor(message: string, opts?: { status?: number; reason?: string }) {
    super(message);
    this.name = "YouTubeApiError";
    this.status = opts?.status;
    this.reason = opts?.reason;
  }
}

/** fetch 응답 + json body 에서 status·reason·message 구조화 추출. */
export function extractYouTubeError(
  status: number,
  data: unknown,
): { message: string; reason?: string } {
  const err = (data as { error?: { message?: string; errors?: Array<{ reason?: string }> } })?.error;
  const reason = err?.errors?.[0]?.reason;
  const message = err?.message || `YouTube API error (HTTP ${status})`;
  return { message, reason };
}

/**
 * quota/rate 소진 시그널 판별(공용, 구조화). 대표 문구·HTTP status·reason 모두 반영.
 *  · HTTP 429 → 항상 rate 제한(yield)
 *  · reason ∈ QUOTA_REASONS → quota
 *  · message 에 quota/dailyLimit/rateLimit/usageLimit 포함 → quota
 * 단순 403(forbidden, 잘못된 키 등)은 reason/message 없으면 quota 아님.
 */
export function isQuotaSignal(info: { status?: number; reason?: string; message?: string }): boolean {
  if (info.status === 429) return true;
  const reason = (info.reason || "").toLowerCase();
  if (reason && QUOTA_REASONS.has(reason)) return true;
  const m = (info.message || "").toLowerCase();
  return (
    m.includes("quotaexceeded") ||
    m.includes("quota exceeded") ||
    m.includes("exceeded your quota") ||
    m.includes("dailylimitexceeded") ||
    m.includes("daily limit") ||
    m.includes("ratelimitexceeded") ||
    m.includes("rate limit") ||
    m.includes("usagelimits") ||
    m.includes("usage limit")
  );
}

/** 임의 에러 → isQuotaSignal 입력으로 정규화(YouTubeApiError 는 status/reason 보존). */
export function quotaInfoFromError(err: unknown): { status?: number; reason?: string; message?: string } {
  if (err instanceof YouTubeApiError) {
    return { status: err.status, reason: err.reason, message: err.message };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { message };
}

export interface QuotaReservation {
  allowed: boolean;
  remaining: number;
  used: number;
  /** RPC 실패 시 메시지 — 이 경우 allowed=true(백스톱 위임), 원장은 미반영 */
  ledgerError?: string;
}

/**
 * 공유 원장에서 units 만큼 예약(원자적). allowed=true면 소비도 기록된 것.
 * - allowed=false: 잔여 부족 → 호출부는 API 호출을 건너뛰고 degrade(warning)
 * - ledgerError: RPC 실패 → 원장 불가, allowed=true 로 진행(런타임 403 백스톱이 방어)
 */
export async function reserveQuota(
  sb: SupabaseClient,
  units: number,
  cap: number = YT_QUOTA_DAILY_CAP,
  now?: Date,
): Promise<QuotaReservation> {
  const date = getQuotaDate(now);
  const { data, error } = await sb.rpc("reserve_youtube_quota", {
    p_date: date,
    p_units: units,
    p_cap: cap,
  });
  if (error) {
    return { allowed: true, remaining: cap, used: 0, ledgerError: error.message };
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return { allowed: true, remaining: cap, used: 0, ledgerError: "no row" };
  return {
    allowed: !!row.allowed,
    remaining: Number(row.remaining ?? 0),
    used: Number(row.used_after ?? 0),
  };
}

/** recordQuota 결과 — RPC 오류를 삼키지 않고 노출(호출부가 로그/경고). throw 안 함. */
export interface QuotaRecordResult {
  recorded: boolean;
  used?: number;
  error?: string;
}

/**
 * quota 소비를 원장에 비조건 기록(고우선순위 잡·유저 라우트 사후 기록용).
 * cap과 무관하게 누적만 한다. 실패해도 throw 하지 않지만, 오류를 결과로 노출해
 * 호출부가 반드시 확인/로그하게 한다(삼순 #709 2번: fire-and-forget·오류 무시 금지).
 * 호출부는 반드시 await 해서 durable 하게 완료를 보장할 것.
 */
export async function recordQuota(
  sb: SupabaseClient,
  units: number,
  now?: Date,
): Promise<QuotaRecordResult> {
  if (units <= 0) return { recorded: false };
  const { data, error } = await sb.rpc("record_youtube_quota", {
    p_date: getQuotaDate(now),
    p_units: units,
  });
  if (error) return { recorded: false, error: error.message };
  const used = typeof data === "number" ? data : Number(Array.isArray(data) ? data[0] : data);
  return { recorded: true, used: Number.isFinite(used) ? used : undefined };
}

/**
 * quota 소비 잡의 최종 status 판정(순수 함수).
 * - hardErrors > 0 → error
 * - quota degrade(부분 수집/skip) → warning  (성공 오표기 교정)
 * - 그 외 → success
 */
export function quotaJobStatus(opts: {
  hardErrors: number;
  degraded: boolean;
}): "success" | "warning" | "error" {
  if (opts.hardErrors > 0) return "error";
  if (opts.degraded) return "warning";
  return "success";
}
