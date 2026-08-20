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
import {
  ackFallbackFlush,
  observeFallback,
  requeueFallbackFlush,
  takeFallbackBuffer,
  type FallbackDelta,
} from "@/lib/monitoring/fallback-buffer";

interface FallbackEvent {
  apiName: string;
  reason: "timeout" | "http-error" | "schema-error" | "network-error";
  timestamp: Date;
  statusCode?: number;
  errorMessage?: string;
  /** dedupe 축(예: gameId). 같은 (api, reason, scope, 1분 버킷)은 DB 1행으로 합산된다. */
  scope?: string;
}

// In-memory 추적 (서버리스 인스턴스별 독립)
const recentFallbacks: FallbackEvent[] = [];
const lastAlertTime = new Map<string, number>(); // apiName -> timestamp

const ALERT_THRESHOLD = 3; // N회 이상
const ALERT_WINDOW_MS = 5 * 60 * 1000; // 5분 내
const COOLDOWN_MS = 30 * 60 * 1000; // 30분 쿨다운
const LEGACY_TELEGRAM_TIMEOUT_MS = 8000;
// 유저 대면 /api/stats(+stats 크론)가 kbo-player-stats-batter/pitcher 에 레거시 trackFallback 을
// 쓰는데, in-memory cooldown 은 서버리스 인스턴스별이라 KBO 열화 중 트래픽이 인스턴스마다 첫 알림을
// 발사해 텔레그램이 폭주한다(kbo-games 와 동일 패턴). 이벤트 저장은 유지하되 durable tracker 로
// 전환하기 전까지 legacy Telegram fanout 만 차단한다.
const LEGACY_TELEGRAM_SUPPRESSED_APIS = new Set([
  "kbo-games",
  "kbo-player-stats-batter",
  "kbo-player-stats-pitcher",
]);

export function getRecentFallbackBufferSizeForTest(): number {
  return recentFallbacks.length;
}

/**
 * Fallback 이벤트 기록 + 알림 체크
 */
export async function trackFallback(
  apiName: string,
  reason: FallbackEvent["reason"],
  options?: { statusCode?: number; errorMessage?: string; scope?: string }
) {
  const event: FallbackEvent = {
    apiName,
    reason,
    timestamp: new Date(),
    statusCode: options?.statusCode,
    errorMessage: options?.errorMessage,
    scope: options?.scope,
  };

  // Supabase 영구 저장 — 반드시 await 한다. fire-and-forget은 응답 반환 직후
  // 서버리스 freeze로 insert가 유실된다(2026-08-11 실측: "Failed to save to
  // Supabase: fetch failed" — 장애 중 이벤트 공백으로 진단 지연). 실패해도 계속.
  await saveToSupabase(event).catch(err => {
    console.error("[API Fallback] Failed to save to Supabase:", err.message);
  });

  // kbo-games 경보는 서버리스 인스턴스별 in-memory cooldown 때문에 장애 중 중복 폭주한다.
  // 이벤트 저장은 유지하되 durable tracker 교체 전까지 legacy Telegram fanout만 차단한다.
  if (LEGACY_TELEGRAM_SUPPRESSED_APIS.has(apiName)) {
    return;
  }

  // 이벤트 추가 (메모리)
  recentFallbacks.push(event);

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

  // 전송 전에 cooldown 을 선점한다. Telegram 이 stall 되어도 같은 인스턴스에서
  // 임계치 이후 이벤트마다 detached fetch 가 추가되는 것을 막는다.
  lastAlertTime.set(apiName, now);

  await sendTelegramAlert(apiName, events);
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LEGACY_TELEGRAM_TIMEOUT_MS);
    try {
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: "Markdown",
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    console.error("[API Fallback] Failed to send Telegram alert:", error);
  }
}

/**
 * Supabase 저장 — delta 버퍼 경유.
 *
 * 폴백 1회당 1행 INSERT 였다. 라이브 경기 중 유저 폴링 수만큼 쌓여 `kbo-game-detail` 하나가
 * 하루 138,708행(2026-08-20 실측, gameId 하나에 52,297건)을 만들었다 — "장애 13.8만 회"가
 * 아니라 계측 설계 결함이다.
 *
 * ⚠️ 이벤트마다 `UPSERT count+1` 로 바꾸는 것은 불충분하다(삼순 blocker 1) — 행 수만 줄고
 *    **쓰기 횟수·WAL 은 그대로**이며 같은 행을 계속 갱신해 HOT 가 막히고 hot-row lock 이 생긴다.
 *    그래서 버퍼에 모았다가 주기적으로 1회 batch flush 한다.
 */
async function saveToSupabase(event: FallbackEvent) {
  const shouldFlush = observeFallback({
    apiName: event.apiName,
    reason: event.reason,
    statusCode: event.statusCode ?? null,
    errorMessage: event.errorMessage ?? null,
    scope: event.scope ?? null,
    policy: LEGACY_TRACK_POLICY,
    // legacy 경로는 경보를 in-memory 로 판정한다. 서버 outbox 를 잡으면 아무도 settle 하지
    // 않아 outbox 가 남고 drainer 와 중복 발송된다(삼순 2차 blocker 3).
    claim: false,
  });
  if (!shouldFlush) return;

  const result = await flushFallbackDeltas();
  if (result?.error) {
    throw new Error(`Supabase insert failed: ${result.error}`);
  }
}

/** flush RPC 가 돌려주는 경보 claim 행. claim:true 로 보낌 delta 에만 따라온다. */
interface FlushAlertClaim {
  out_api_name: string;
  out_attempt_token: string;
  out_reason: string;
  out_error_message: string | null;
  out_scope: string | null;
}

/**
 * 버퍼를 꺼내 1회 batch RPC 로 보낸다. 성공하면 ack, 실패하면 requeue 한다.
 *
 * ⚠️ 삼순 2차 blocker 3: 종전엔 take 직후 pending 을 지우고 끝났다. RPC 가 실패하면
 *    첫 관측을 포함한 delta 가 그대로 증발했고, "방금 보냈다"고 기록돼 재시도도 막혔다.
 */
async function flushFallbackDeltas(): Promise<{ error?: string; claims: FlushAlertClaim[] }> {
  const deltas = takeFallbackBuffer();
  if (deltas.length === 0) return { claims: [] };

  const { data, error } = await supabase.rpc("flush_api_fallback_buckets", { p_events: deltas });
  if (error) {
    requeueFallbackFlush(deltas);
    return { error: error.message, claims: [] };
  }
  ackFallbackFlush(deltas);
  return { claims: (Array.isArray(data) ? data : []) as FlushAlertClaim[] };
}

/** 테스트·종단 게이트용 — 프로덕션이 실제로 부르는 RPC 이름과 인자 집합을 노출한다. */
export const FALLBACK_RPC_CONTRACT = {
  flush: {
    name: "flush_api_fallback_buckets",
    args: ["p_events"] as const,
  },
  deltaFields: [
    "api_name",
    "reason",
    "status_code",
    "error_message",
    "scope",
    "fingerprint",
    "count",
    "window_minutes",
    "threshold",
    "cooldown_minutes",
    "lease_seconds",
    "claim",
  ] as const,
} as const;

/**
 * legacy trackFallback 경로의 임계치 정책. 종전 상수(ALERT_THRESHOLD/WINDOW/COOLDOWN)와
 * 같은 값을 쓴다 — 이 경로는 텐레그램 전송을 in-memory 로 판정하므로 DB 측 임계치는
 * 사실상 쓰이지 않지만, flush RPC 가 공통 경로라 값을 명시해야 한다.
 */
const LEGACY_TRACK_POLICY = {
  windowMinutes: ALERT_WINDOW_MS / 60_000,
  threshold: ALERT_THRESHOLD,
  cooldownMinutes: COOLDOWN_MS / 60_000,
  leaseSeconds: 120,
} as const;

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
  options: { statusCode?: number; errorMessage?: string; scope?: string },
  policy: DegradationAlertPolicy,
): Promise<void> {
  try {
    // ⚠️ 삼순 2차 blocker 1: 종전엔 이 함수가 이벤트마다 claim_api_fallback_alert 를
    //    직접 불렀다. 그게 **하루 13.8만건을 만든 바로 그 경로**인데 버퍼를 안 타고 있었고,
    //    더구나 EXPAND 재작성 후엔 9-인자 시그니처가 DB 에 없어 RPC 가 전량 실패했다.
    //    이제 단일 batch 경로(flush_api_fallback_buckets)로 통합한다.
    //    claim:true 로 보내야 서버가 임계 판정 후 attempt_token 을 돌려준다.
    const shouldFlush = observeFallback({
      apiName,
      reason,
      statusCode: options.statusCode ?? null,
      errorMessage: options.errorMessage ?? null,
      scope: options.scope ?? null,
      policy,
      claim: true,
    });
    if (!shouldFlush) return;

    const { error, claims } = await flushFallbackDeltas();
    if (error) {
      console.error("[API Degradation] flush RPC failed:", error);
      return;
    }
    if (claims.length === 0) return;

    for (const claim of claims) {
      if (!claim.out_attempt_token) continue;
      // 경보 귀속은 서버가 돌려준 행 기준이다 — batch 안에 여러 api 가 섞여 있을 수 있으므로
      // 호출 당시의 apiName/scope 를 그대로 쓰면 엉뚜한 경보에 붙을 수 있다.
      const claimOptions = {
        statusCode: options.statusCode,
        errorMessage: claim.out_error_message ?? undefined,
        scope: claim.out_scope ?? undefined,
      };
      // 복구 알림 등록은 반드시 **경보 전송 confirm 이후** (삼순 Blocker 2).
      // should_send 시점에 등록하면 전송 실패 → 복구 시 ✅가 먼저 나가고 drainer의
      // 🚨가 나중에 가는 순서 역전이 생긴다.
      const delivered = await deliverAndSettle(
        claim.out_api_name,
        claim.out_reason,
        claimOptions,
        policy,
        claim.out_attempt_token,
      );
      if (delivered) {
        // scope(예: gameId) 단위로 묶는다 — 경보를 유발한 scope가 정상으로 돌아왔을
        // 때만 복구로 인정(삼순 2차 ③). scope 미지정 경보는 "*"로 등록된다.
        const scopes = pendingRecoveryNotice.get(claim.out_api_name) ?? new Set<string>();
        scopes.add(claim.out_scope ?? "*");
        pendingRecoveryNotice.set(claim.out_api_name, scopes);
      }
    }
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
): Promise<boolean> {
  return settleAttempt(apiName, reason, options, policy, token);
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

// ============================================================================
// 복구 알림 (best-effort, 2026-08-11 실질 요구사항: 경보 후 "다시 정상"을 알 수 있게)
//
// 설계: 전역 claim 승자 인스턴스만 pendingRecoveryNotice에 등록되므로 복구 알림도
// 쿨다운 창당 최대 1회다. 그 인스턴스가 재활용 전에 죽으면 복구 알림은 생략될 수
// 있다(best-effort 명시). 경보 자체는 durable(outbox)하므로 정확성에 영향 없음.
// ============================================================================

const pendingRecoveryNotice = new Map<string, Set<string>>();

/**
 * 성공 경로에서 호출: 이 인스턴스가 직전에 경보를 보냈고 **그 경보의 scope**가
 * 정상으로 돌아왔을 때만 복구 알림을 1회 보낸다(삼순 2차 ③: 다른 scope의 정상
 * 응답이 전역 ✅를 보내는 오보 차단). 경보 이력이 없으면 in-memory 체크로 즉시 반환.
 */
export async function markApiRecovered(apiName: string, scope = "*"): Promise<void> {
  const scopes = pendingRecoveryNotice.get(apiName);
  if (!scopes || scopes.size === 0) return;
  // 경보 scope와 일치하거나, scope 미지정("*") 경보만 복구 대상.
  const matched = scopes.has(scope) ? scope : scopes.has("*") ? "*" : null;
  if (matched === null) return;
  scopes.delete(matched);
  if (scopes.size === 0) pendingRecoveryNotice.delete(apiName);
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID || "6796048731"; // 하린아빠
  if (!botToken) return;
  const scopeText = matched === "*" ? "" : ` (${matched})`;
  const message = `✅ 외부 API 복구\n\n**${apiName}**${scopeText} 정상 응답 확인\n\n시간: ${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: "Markdown" }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    // 복구 알림은 best-effort — 실패해도 서비스 경로에 영향 없음. 재등록하지 않는다
    // (다음 경보 사이클에서 다시 기회가 생김).
    console.error("[API Recovery] Telegram send failed:", error);
  }
}

/** 테스트 전용: 복구 알림 대기 상태 주입/조회. */
export function _setPendingRecoveryForTest(
  apiName: string,
  pending: boolean,
  scope = "*",
): void {
  if (pending) {
    const scopes = pendingRecoveryNotice.get(apiName) ?? new Set<string>();
    scopes.add(scope);
    pendingRecoveryNotice.set(apiName, scopes);
  } else {
    pendingRecoveryNotice.delete(apiName);
  }
}
export function _hasPendingRecoveryForTest(apiName: string, scope?: string): boolean {
  const scopes = pendingRecoveryNotice.get(apiName);
  if (!scopes || scopes.size === 0) return false;
  return scope ? scopes.has(scope) : true;
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
