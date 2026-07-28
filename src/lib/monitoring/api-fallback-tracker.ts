/**
 * API Fallback Tracker
 * 
 * 외부 API 의존성 모니터링:
 * - Primary API 실패 시 fallback 이벤트 추적
 * - Supabase 영구 저장
 * - 임계치 초과 시 텔레그램 알림
 * - 알림 스팸 방지 (쿨다운)
 */

import { supabaseAdmin as supabase } from "@/lib/supabase/admin";

interface FallbackEvent {
  apiName: string;
  reason: "timeout" | "http-error" | "schema-error" | "network-error";
  timestamp: Date;
  statusCode?: number;
  errorMessage?: string;
}

// In-memory 추적 (서버리스 인스턴스별 독립)
const recentFallbacks: FallbackEvent[] = [];
const lastAlertTime = new Map<string, number>(); // apiName -> timestamp

const ALERT_THRESHOLD = 3; // N회 이상
const ALERT_WINDOW_MS = 5 * 60 * 1000; // 5분 내
const COOLDOWN_MS = 30 * 60 * 1000; // 30분 쿨다운

/**
 * Fallback 이벤트 기록 + 알림 체크
 */
export async function trackFallback(
  apiName: string,
  reason: FallbackEvent["reason"],
  options?: { statusCode?: number; errorMessage?: string }
) {
  const event: FallbackEvent = {
    apiName,
    reason,
    timestamp: new Date(),
    statusCode: options?.statusCode,
    errorMessage: options?.errorMessage,
  };

  // 이벤트 추가 (메모리)
  recentFallbacks.push(event);

  // Supabase 영구 저장 (비동기, 실패해도 알림은 계속)
  saveToSupabase(event).catch(err => {
    console.error("[API Fallback] Failed to save to Supabase:", err.message);
  });

  // 5분 이상 된 이벤트 제거 (메모리 관리)
  const cutoff = Date.now() - ALERT_WINDOW_MS;
  const validIndex = recentFallbacks.findIndex(e => e.timestamp.getTime() >= cutoff);
  if (validIndex > 0) {
    recentFallbacks.splice(0, validIndex);
  }

  // 같은 API 최근 이벤트 개수 확인
  const sameApiEvents = recentFallbacks.filter(e => e.apiName === apiName);
  
  // 임계치 초과 확인
  if (sameApiEvents.length >= ALERT_THRESHOLD) {
    await checkAndAlert(apiName, sameApiEvents);
  }
}

/**
 * 임계치 초과 시 알림 (쿨다운 체크)
 */
async function checkAndAlert(apiName: string, events: FallbackEvent[]) {
  const now = Date.now();
  const lastAlert = lastAlertTime.get(apiName) || 0;

  // 쿨다운 중이면 알림 스킵
  if (now - lastAlert < COOLDOWN_MS) {
    return;
  }

  // 알림 발송
  await sendTelegramAlert(apiName, events);
  
  // 쿨다운 갱신
  lastAlertTime.set(apiName, now);
}

/**
 * 텔레그램 알림 발송
 */
async function sendTelegramAlert(apiName: string, events: FallbackEvent[]) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID || "6796048731"; // 하린아빠 (수정: 2026-04-10)

  if (!botToken) {
    console.warn("[API Fallback] TELEGRAM_BOT_TOKEN not set, skipping alert");
    return;
  }

  // 이유별 카운트
  const reasonCounts = events.reduce((acc, e) => {
    acc[e.reason] = (acc[e.reason] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const reasonText = Object.entries(reasonCounts)
    .map(([r, c]) => `  • ${r}: ${c}회`)
    .join("\n");

  const lastEvent = events[events.length - 1];
  const errorInfo = lastEvent.errorMessage 
    ? `\n\n마지막 에러:\n${lastEvent.errorMessage.slice(0, 200)}`
    : "";

  const message = `
🚨 API Fallback 경고

**${apiName}** 실패 감지
최근 5분 내 ${events.length}회 fallback 발생

${reasonText}${errorInfo}

시간: ${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}
  `.trim();

  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: "Markdown",
      }),
    });
  } catch (error) {
    console.error("[API Fallback] Failed to send Telegram alert:", error);
  }
}

/**
 * Supabase 저장
 */
async function saveToSupabase(event: FallbackEvent) {
  const { error } = await supabase.from("api_fallback_events").insert({
    api_name: event.apiName,
    reason: event.reason,
    status_code: event.statusCode || null,
    error_message: event.errorMessage || null,
    timestamp: event.timestamp.toISOString(),
    alert_sent: false, // 알림 발송 전이므로 false
  });

  if (error) {
    throw new Error(`Supabase insert failed: ${error.message}`);
  }
}

// ============================================================================
// Durable 열화 감지·경보 (장애대책 슬라이스1 — 삼순 NO-GO 반영)
//
// 위 trackFallback 의 count/cooldown 은 in-memory 라 서버리스 인스턴스별 독립이다.
// 분산 호출에서 임계치 판정이 깨지는 경로(요약 열화 감지 등)는 아래 durable 경로를 쓴다.
// count/cooldown/claim 을 단일 원자 RPC(record_api_fallback_and_claim)로 판정하므로
// 인스턴스 분산에도 "임계치 초과 시 경보 1회"를 보장한다.
// ============================================================================

export interface DegradationAlertPolicy {
  windowMinutes: number;
  threshold: number;
  cooldownMinutes: number;
  leaseSeconds: number;
}

/** 전송 실패 시 다음 재시도까지 backoff(초). drainer 가 이 간격 뒤에 재획득. */
export const DEGRADATION_NACK_BACKOFF_SECONDS = 60;
/** drainer give-up 기준: outbox 가 이 시간보다 오래되면 포기(영구 재시도 방지). */
export const DEGRADATION_MAX_AGE_MINUTES = 120;

/** claim/drain 결과 1행을 안전하게 꺼낸다(table-returning RPC 는 rows 배열). */
function firstRow<T>(data: unknown): T | null {
  if (Array.isArray(data)) return (data[0] as T) ?? null;
  return (data as T) ?? null;
}

/**
 * fast path: Durable API 열화 추적 + outbox 생성 + 즉시 전송 시도.
 *
 * 1) claim_api_fallback_alert: 이벤트 durable insert + window count + (cooldown && outbox부재)
 *    판정 후 outbox 생성 + attempt_token 발급. should_send=true 면 이 호출이 전송 담당.
 * 2) 텔레그램 전송 → 실제 2xx(ACK) 면 confirm(token), 실패면 nack(token, backoff).
 *    전송 실패/crash 시 outbox 는 durable 하게 남아 recovery drainer(cron)가 재전송한다.
 *
 * **절대 throw 하지 않는다** — next/server `after` 안에서 실행 권장(응답 수명 보장 + 요약 latency 무영향).
 */
export async function trackApiDegradation(
  apiName: string,
  reason: FallbackEvent["reason"],
  options: { statusCode?: number; errorMessage?: string },
  policy: DegradationAlertPolicy,
): Promise<void> {
  try {
    const { data, error } = await supabase.rpc("claim_api_fallback_alert", {
      p_api_name: apiName,
      p_reason: reason,
      p_status_code: options.statusCode ?? null,
      p_error_message: options.errorMessage ?? null,
      p_window_minutes: policy.windowMinutes,
      p_threshold: policy.threshold,
      p_cooldown_minutes: policy.cooldownMinutes,
      p_lease_seconds: policy.leaseSeconds,
    });
    if (error) {
      console.error("[API Degradation] claim RPC failed:", error.message);
      return;
    }
    const row = firstRow<{ should_send: boolean; attempt_token: string | null }>(data);
    if (!row || row.should_send !== true || !row.attempt_token) return;

    await deliverAndSettle(apiName, reason, options, policy, row.attempt_token);
  } catch (err) {
    console.error(
      "[API Degradation] unexpected error:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * recovery drainer: 새 열화 이벤트 없이도 due outbox(전송 실패/crash 잔여)를 재전송한다.
 * cron 이 주기적으로 호출. 각 due outbox 를 새 토큰으로 재획득 → 전송 → 2xx confirm / 실패 nack.
 * 절대 throw 하지 않고 { drained, sent, failed } 요약을 반환.
 */
export async function drainApiFallbackAlerts(
  policy: { leaseSeconds: number; maxBatch?: number } = { leaseSeconds: 120 },
): Promise<{ drained: number; sent: number; failed: number }> {
  const summary = { drained: 0, sent: 0, failed: 0 };
  try {
    const { data, error } = await supabase.rpc("drain_api_fallback_alerts", {
      p_lease_seconds: policy.leaseSeconds,
      p_max_age_minutes: DEGRADATION_MAX_AGE_MINUTES,
      p_max_batch: policy.maxBatch ?? 20,
    });
    if (error) {
      console.error("[API Degradation] drain RPC failed:", error.message);
      return summary;
    }
    const rows = (Array.isArray(data) ? data : []) as Array<{
      api_name: string;
      attempt_token: string;
      reason: string;
      error_message: string | null;
    }>;
    for (const r of rows) {
      summary.drained++;
      const delivered = await settleAttempt(
        r.api_name,
        r.reason,
        { errorMessage: r.error_message ?? undefined },
        { windowMinutes: 5, threshold: 1, cooldownMinutes: 30, leaseSeconds: policy.leaseSeconds },
        r.attempt_token,
      );
      if (delivered) summary.sent++;
      else summary.failed++;
    }
  } catch (err) {
    console.error(
      "[API Degradation] drain unexpected error:",
      err instanceof Error ? err.message : String(err),
    );
  }
  return summary;
}

async function deliverAndSettle(
  apiName: string,
  reason: string,
  options: { statusCode?: number; errorMessage?: string },
  policy: DegradationAlertPolicy,
  token: string,
): Promise<void> {
  await settleAttempt(apiName, reason, options, policy, token);
}

/** 전송 시도 + 토큰 소유자 기준 confirm/nack. delivered(2xx) 여부 반환. */
async function settleAttempt(
  apiName: string,
  reason: string,
  options: { statusCode?: number; errorMessage?: string },
  policy: DegradationAlertPolicy,
  token: string,
): Promise<boolean> {
  const delivered = await sendDegradationTelegramAlert(apiName, reason, options, policy);
  if (delivered) {
    const { error } = await supabase.rpc("confirm_api_fallback_alert", {
      p_api_name: apiName,
      p_token: token,
    });
    if (error) console.error("[API Degradation] confirm RPC failed:", error.message);
  } else {
    const { error } = await supabase.rpc("nack_api_fallback_alert", {
      p_api_name: apiName,
      p_token: token,
      p_backoff_seconds: DEGRADATION_NACK_BACKOFF_SECONDS,
    });
    if (error) console.error("[API Degradation] nack RPC failed:", error.message);
  }
  return delivered;
}

/** 텔레그램 전송. 실제 HTTP 2xx(ACK) 이면 true, 그 외(토큰 부재/4xx/5xx/timeout)는 false. */
export async function sendDegradationTelegramAlert(
  apiName: string,
  reason: string,
  options: { statusCode?: number; errorMessage?: string },
  policy: DegradationAlertPolicy,
): Promise<boolean> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID || "6796048731"; // 하린아빠
  if (!botToken) {
    console.warn("[API Degradation] TELEGRAM_BOT_TOKEN not set — NACK(재시도 대상)");
    return false; // NACK: confirm 안 함 → env 배선 후 다음 이벤트에서 재전송
  }
  const detail = options.errorMessage ? `\n\n${options.errorMessage.slice(0, 300)}` : "";
  const message = `
🚨 외부 API 열화 감지

**${apiName}** (${reason})
최근 ${policy.windowMinutes}분 내 ${policy.threshold}회 이상 fallback${detail}

시간: ${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}
  `.trim();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let res: Response;
    try {
      res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: "Markdown" }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      console.error(`[API Degradation] Telegram non-2xx: ${res.status} — NACK(재시도)`);
      return false;
    }
    return true; // 2xx ACK
  } catch (error) {
    console.error("[API Degradation] Telegram send failed — NACK(재시도):", error);
    return false;
  }
}

/**
 * 현재 상태 조회 (디버깅/대시보드용)
 */
export function getFallbackStats() {
  const now = Date.now();
  const cutoff = now - ALERT_WINDOW_MS;
  
  const recent = recentFallbacks.filter(e => e.timestamp.getTime() >= cutoff);
  
  return {
    recentCount: recent.length,
    byApi: recent.reduce((acc, e) => {
      if (!acc[e.apiName]) acc[e.apiName] = [];
      acc[e.apiName].push(e);
      return acc;
    }, {} as Record<string, FallbackEvent[]>),
    cooldowns: Array.from(lastAlertTime.entries()).map(([api, time]) => ({
      api,
      lastAlert: new Date(time),
      cooldownRemaining: Math.max(0, COOLDOWN_MS - (now - time)),
    })),
  };
}
