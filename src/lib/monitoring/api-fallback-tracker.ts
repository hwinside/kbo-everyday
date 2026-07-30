/**
 * API Fallback Tracker
 * 
 * 외부 API 의존성 모니터링:
 * - Primary API 실패 시 fallback 이벤트 추적
 * - Supabase durable 이벤트 저장
 * - 임계치 초과 시 단일 텔레그램 알림
 * - 공유 쿨다운으로 알림 스팸 방지
 */

import { supabaseAdmin as supabase } from "@/lib/supabase/admin";

type FallbackReason = "timeout" | "http-error" | "schema-error" | "network-error";

const ALERT_THRESHOLD = 3; // N회 이상

// 삼순 NO-GO(exact b85fdb744) blocker 1: trackFallback 호출부(fetchGames의 Naver
// 폴백 직전, game-relay의 503 반환 직전)가 전부 `await trackFallback` 이라 claim RPC나
// Telegram 전송이 느리면 사용자 응답/폴백까지 그만큼 지연된다. trackFallback 호출부가
// route 핸들러 request scope 밖(예: scripts, season-games-cache 배치)에서도 쓰이므로
// next/server `after()`를 여기서 강제할 수 없다 — 대신 관제 작업에 짧은 예산을 걸어
// 예산 초과 시 즉시 반환하고 나머지(RPC/텔레그램)는 백그라운드로 흘려보낸다.
// trackApiDegradation은 내부에서 절대 throw하지 않으므로 백그라운드로 넘어가도
// unhandled rejection이 발생하지 않는다.
const TRACK_FALLBACK_BUDGET_MS = 50;

function budgetTimeout(ms: number): Promise<"budget-exceeded"> {
  return new Promise((resolve) => setTimeout(() => resolve("budget-exceeded"), ms));
}

/**
 * Fallback 이벤트를 durable 저장하고 공유 threshold/cooldown으로 알림을 판정한다.
 * 사용자 요청/Naver 폴백 critical path를 막지 않도록 예산(TRACK_FALLBACK_BUDGET_MS) 내에
 * 반환한다 — 예산을 넘기면 관제 작업은 백그라운드에서 계속 진행되고 이 함수는 즉시 끝난다.
 */
export async function trackFallback(
  apiName: string,
  reason: FallbackReason,
  options?: { statusCode?: number; errorMessage?: string }
) {
  const work = trackApiDegradation(
    apiName,
    reason,
    options ?? {},
    { windowMinutes: 5, threshold: ALERT_THRESHOLD, cooldownMinutes: 30, leaseSeconds: 120 },
  );
  await Promise.race([work, budgetTimeout(TRACK_FALLBACK_BUDGET_MS)]);
}

// ============================================================================
// Durable 열화 감지·경보 (장애대책 슬라이스1 — 삼순 NO-GO 반영)
//
// 모든 fallback 경로가 아래 durable 경로를 쓴다.
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
  reason: FallbackReason,
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

/**
 * 전송 시도 + 토큰 소유자 기준 confirm/nack.
 * 소유권을 실제로 소비(confirm=true)해 outbox 를 우리 토큰이 비운 경우에만 true.
 * confirm 이 false(삼순 4차: 리스가 만료되어 drain 이 토큰을 먼저 회전시킴)면 이 시도는
 * audit/state 를 바꾸지 않은 것이므로 sent 로 세지 않는다(drain 요약 이중카운트 방지).
 */
async function settleAttempt(
  apiName: string,
  reason: string,
  options: { statusCode?: number; errorMessage?: string },
  policy: DegradationAlertPolicy,
  token: string,
): Promise<boolean> {
  const delivered = await sendDegradationTelegramAlert(apiName, reason, options, policy);
  if (!delivered) {
    const { error } = await supabase.rpc("nack_api_fallback_alert", {
      p_api_name: apiName,
      p_token: token,
      p_backoff_seconds: DEGRADATION_NACK_BACKOFF_SECONDS,
    });
    if (error) console.error("[API Degradation] nack RPC failed:", error.message);
    return false;
  }
  // 2xx ACK → confirm. 반환 boolean 을 반드시 확인: 토큰 소유자만 true(outbox 소비 + exact event sent).
  const { data, error } = await supabase.rpc("confirm_api_fallback_alert", {
    p_api_name: apiName,
    p_token: token,
  });
  if (error) {
    // 확정 RPC 자체 실패 → 소유 미확정(outbox durable 유지, drainer 가 재시도). sent 로 안 셀.
    console.error("[API Degradation] confirm RPC failed:", error.message);
    return false;
  }
  const confirmed = data === true;
  if (!confirmed) {
    // stale: 우리 토큰이 이미 재회전됨 → 이 시도는 audit(alert_sent)/state 를 바꾸지 않았음.
    console.warn(`[API Degradation] confirm no-op(stale token) — ${apiName}`);
  }
  return confirmed;
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
