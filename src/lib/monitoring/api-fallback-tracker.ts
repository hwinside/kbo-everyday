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

/**
 * Durable API 열화 추적 + outbox/lease + 2xx ACK 경보.
 *
 * 1) claim_api_fallback_alert RPC: 이벤트 durable insert + window count + (cooldown && lease)
 *    원자 claim. should_send=true 면 이 호출이 전송 담당(cooldown 은 아직 확정 안 함).
 * 2) 텔레그램 전송을 시도하고 **실제 2xx(ACK)** 를 받은 뒤에만 confirm 을 호출해 cooldown 확정.
 *    토큰 부재/4xx/5xx/timeout 은 confirm 을 건너뛰어 lease 만료 후 다음 이벤트가 재시도한다.
 *
 * **절대 throw 하지 않는다** — 호출측(요약 생성 등) 응답을 경보 실패가 막지 못하게 한다
 * (next/server `after` 안에서 실행 권장 — 응답 이후 수명 보장 + 요약 latency 무영향).
 */
export async function trackApiDegradation(
  apiName: string,
  reason: FallbackEvent["reason"],
  options: { statusCode?: number; errorMessage?: string },
  policy: DegradationAlertPolicy,
): Promise<void> {
  try {
    const { data: shouldSend, error } = await supabase.rpc("claim_api_fallback_alert", {
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
    if (shouldSend !== true) return; // 임계치 미달 / cooldown / 다른 워커 전송 중

    // 실제 2xx 를 받았을 때만 confirm(cooldown 확정). 실패면 lease 만료 후 재시도.
    const delivered = await sendDegradationTelegramAlert(apiName, reason, options, policy);
    if (delivered) {
      const { error: confirmErr } = await supabase.rpc("confirm_api_fallback_alert", {
        p_api_name: apiName,
      });
      if (confirmErr) {
        console.error("[API Degradation] confirm RPC failed:", confirmErr.message);
      }
    }
  } catch (err) {
    console.error(
      "[API Degradation] unexpected error:",
      err instanceof Error ? err.message : String(err),
    );
  }
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
