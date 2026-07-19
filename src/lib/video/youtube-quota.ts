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
 * 공유 quota 상한. Google 기본 10,000에서 유저 대면 라우트용 마진을 뺀 값. env로 조절.
 * 비정상값(NaN/≤0/과대)은 fail-closed — 기본 9500으로 폴백(삼순 3번 검증).
 */
export const YT_QUOTA_DAILY_DEFAULT = 9500;
export function resolveQuotaCap(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 10_000_000) return YT_QUOTA_DAILY_DEFAULT;
  return Math.floor(n);
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

/**
 * quota 소비를 원장에 비조건 기록(고우선순위 잡용). cap과 무관하게 누적만 한다.
 * best-effort — 실패해도 파이프라인을 막지 않는다(원장 미반영, 런타임 403 백스톱).
 */
export async function recordQuota(
  sb: SupabaseClient,
  units: number,
  now?: Date,
): Promise<void> {
  if (units <= 0) return;
  try {
    await sb.rpc("record_youtube_quota", { p_date: getQuotaDate(now), p_units: units });
  } catch {
    // best-effort — 원장 기록 실패는 수집을 막지 않음
  }
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
