// FCM Android delivery config 빌더 (순수, supabase/firebase 의존 0).
// fcm.ts와 QA 스모크가 *동일* 함수로 Admin SDK / HTTP deadline transport 양쪽 payload를
// 만들어, TTL·priority·collapseKey가 두 전송 경로에 동일하게 실리는지 회귀로 잠근다
// (삼순 S2 Slice0 NO-GO #1: data-only game_event TTL 누락).

/** Android delivery에 반영할 필드(PushPayload에서 구조적으로 뽑아 쓴다). */
export interface AndroidDeliveryFields {
  dataOnly?: boolean;
  collapseKey?: string;
  /** Android FCM TTL(초). 지정 시에만 실린다. data-only game_event는 n_expires_at-now로 계산. */
  ttlSeconds?: number;
}

/** Firebase Admin SDK용 Android delivery 설정(ttl은 ms). */
export function buildAndroidConfig(payload: AndroidDeliveryFields) {
  return {
    ...(payload.dataOnly ? { priority: "high" as const } : {}),
    ...(payload.collapseKey ? { collapseKey: payload.collapseKey } : {}),
    ...(payload.ttlSeconds != null ? { ttl: payload.ttlSeconds * 1000 } : {}),
  };
}

/** FCM HTTP v1 deadline transport용 Android delivery 설정(ttl은 "<n>s" 문자열). */
export function buildDeadlineAndroidConfig(payload: AndroidDeliveryFields) {
  return {
    ...(payload.dataOnly ? { priority: "HIGH" as const } : {}),
    ...(payload.collapseKey ? { collapse_key: payload.collapseKey } : {}),
    ...(payload.ttlSeconds != null ? { ttl: `${payload.ttlSeconds}s` } : {}),
  };
}
