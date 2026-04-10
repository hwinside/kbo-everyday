/**
 * API Fallback Tracker
 * 
 * 외부 API 의존성 모니터링:
 * - Primary API 실패 시 fallback 이벤트 추적
 * - 임계치 초과 시 텔레그램 알림
 * - 알림 스팸 방지 (쿨다운)
 */

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

  // 이벤트 추가
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
