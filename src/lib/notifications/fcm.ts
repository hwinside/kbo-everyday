import { getMessaging } from "firebase-admin/messaging";
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { DEFAULT_PREFS, type PrefKey } from "@/lib/notifications/prefs";
import { fetchAllByKeyset } from "@/lib/db/paginate";
import { deliverTokenChunks } from "@/lib/notifications/fcm-batch";

// FCM 발송 공용 헬퍼 (push-notifications-v1 S3).
// 디스패처(/api/notifications/dispatch)와 어드민 수동 발송(/api/admin/push/send-fcm)이 공용.

export function getFcm() {
  if (getApps().length === 0) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) return null;
    initializeApp({ credential: cert(JSON.parse(raw)) });
  }
  return getMessaging();
}

export interface PushPayload {
  title: string;
  body: string;
  /** 알림 탭 시 이동할 앱 내 경로 (예: "/community?post=123") */
  url?: string;
  /**
   * data-only 메시지 — notification 블록 생략, title/body/추가 data를 data 블록에 실음.
   * 안드로이드 네이티브(KboMessagingService)가 직접 처리하는 잠금화면 ongoing card용.
   * notification 블록을 같이 보내면 일반 푸시 + ongoing이 이중 표시됨 (삼순 C2 조건).
   */
  dataOnly?: boolean;
  /** data 블록에 추가로 실을 키 (예: { kind: "game_live" }). */
  data?: Record<string, string>;
  /**
   * iOS 무음(백그라운드) 푸시 — APNs `content-available:1` + `apns-push-type:background`.
   * 알림 배너 없이 앱을 백그라운드로 깨우기만 한다(Live Activity update 토큰 등록용, Layer 2).
   * 반드시 `dataOnly`와 함께 쓴다(notification 블록이 있으면 무음이 아님). iOS 전용 헤더라
   * Android엔 무영향. Apple이 무음 푸시를 throttle하므로 best-effort.
   */
  apnsBackground?: boolean;
  /**
   * APNs collapse-id (apnsBackground 전용) — 같은 id의 미배달 push를 최신 1건으로 합침.
   * 경기별 위젯 갱신처럼 "최신만 의미 있는" 스트림에 사용(지연 배달 백로그 방지, 삼순 #674 blocker③).
   */
  apnsCollapseId?: string;
  /**
   * APNs 상대 만료 초 (apnsBackground 전용) — 이 시간 내 미배달 시 폐기(apns-expiration 헤더).
   * 다음 발송이 공 덮어쓰는 스트림은 짧게(예: 90) 주어 stale 배달을 줄인다.
   */
  apnsExpirationSeconds?: number;
  /**
   * Android FCM collapse key — 같은 키의 미배달 메시지는 최신 1건만 보관/배달한다.
   * 라이브 위젯처럼 매분 갱신되는 data 푸시에 경기별 키를 주면, 기기가 잠시
   * 오프라인/딥슬립이었다가 복귀할 때 옛 상태 백로그가 한꺼번에 배달되는 대신
   * *가장 최신 상태 1건만* 배달된다(위젯 깜빡임·stale 방지). Android 전용.
   */
  collapseKey?: string;
  /**
   * Android FCM TTL(초). 이 시간 내 배달 못 하면 폐기한다(admin SDK는 ms라 ×1000 변환).
   * 라이브 스코어처럼 다음 틱이 곧 덮어쓰는 data는 짧은 TTL(예 90s)을 줘서, 오래된
   * 상태가 뒤늦게 배달돼 최신값(또는 game_end)을 덮어쓰는 걸 막는다. Android 전용.
   */
  ttlSeconds?: number;
}

/**
 * 안드 위젯 제어 스트림(data-only kind: game_live/game_cancel/game_end) 공통 delivery policy.
 * 위젯 상태를 만지는 *모든* 발송 경로(매분 warmup tick·경기 시작·득점·종료·취소 clear)가
 * 반드시 이걸 spread해야 한다 — 한 경로라도 빠지면 그 메시지는 FCM 기본(비collapse·최대 4주
 * 보관)으로 남아, 절전 복귀 시 옛 LIVE가 game_end *뒤에* 도착해 위젯을 되살릴 수 있다(삼순 #649).
 *
 * 단일 stream key: 위젯은 기기당 한 경기 상태만 보관하므로 경기별 키가 아닌 단일 키로 묶어야
 * 미배달분 전체에서 최신 1건만 남고(신·구 경기 간 순서 역전 차단), collapse key 4개/기기
 * 한도도 1개로 고정된다.
 * TTL 분리: live tick은 다음 틱이 곧 덮어쓰므로 90s에 폐기(뒤늦은 배달이 terminal을 덮지 않게),
 * terminal(종료/취소)은 장시간 오프라인 복귀에도 마지막 상태가 배달되도록 24h — 이후엔 다음
 * 경기 pregame/live push가 같은 스트림 키로 자연 대체한다.
 */
export const WIDGET_STREAM = {
  live: { collapseKey: "kbo_widget_stream", ttlSeconds: 90 },
  terminal: { collapseKey: "kbo_widget_stream", ttlSeconds: 24 * 60 * 60 },
} as const;

/**
 * 위젯 제어 data-only 스트림 kind — 이 kind엔 서버 send-time(w_ts, ms)을 실어 네이티브가
 * 순서 역전 배달을 차단(seq 가드)하고 수신→렌더 지연을 계측한다(삼순 vc14). w_ts는 단조 증가하는
 * send-time이라 같은 경기에서 더 작은/같은 값은 옛 배달로 보고 버린다.
 */
export const WIDGET_CONTROL_KINDS = new Set(["game_live", "game_cancel", "game_end"]);

/**
 * 대상 유저들에게 FCM 발송.
 * - prefKey 지정 시 notification_prefs로 필터 (row 없음 = 디폴트)
 * - 토큰 500개 chunk + 무효 토큰 정리
 */
export interface SendResult {
  /** FCM에 실제 전달을 시도한 디바이스 토큰 수(sent + failed). */
  tokens: number;
  sent: number;
  failed: number;
  cleaned: number;
  skipped: number;
  /** 인프라 정상 여부 — env 누락/DB 조회 실패면 false (호출자 재시도 판단용).
   *  대상/토큰 0명은 정상이므로 ok:true (보낼 사람이 없을 뿐) */
  ok: boolean;
  lastError?: string | null;
  /** transient FCM 응답·deadline 미시도로 다음 fast tick 재시도가 필요한 토큰 수. */
  retryableFailed?: number;
  sendStartedAtMs?: number;
  sendCompletedAtMs?: number;
}

interface FcmSendOptions {
  minAppBuild?: number;
  /** 이 epoch ms 이후에는 prefs/token 조회나 새 FCM chunk를 시작하지 않는다. */
  deadlineAtMs?: number;
}

export async function sendFcmToUsers(
  userIds: string[],
  payload: PushPayload,
  prefKey?: PrefKey,
  platform?: "ios" | "android",
  opts?: FcmSendOptions,
): Promise<SendResult> {
  if (userIds.length === 0) return { tokens: 0, sent: 0, failed: 0, cleaned: 0, skipped: 0, ok: true };
  try {
    return await sendFcmToUsersInner(userIds, payload, prefKey, platform, opts);
  } catch (e) {
    // getFcm()의 JSON parse/init 또는 sendEachForMulticast throw 등 —
    // ok:false로 호출자(game-status unclaim)가 재시도하게 함 (삼순 #210 재리뷰 NO-GO)
    console.error("[fcm] send threw:", (e as Error).message);
    return {
      tokens: 0, sent: 0, failed: 0, cleaned: 0, skipped: 0, ok: false,
      lastError: e instanceof Error ? e.message : "fcm_send_exception",
    };
  }
}

async function sendFcmToUsersInner(
  userIds: string[],
  payload: PushPayload,
  prefKey?: PrefKey,
  platform?: "ios" | "android",
  opts?: FcmSendOptions,
): Promise<SendResult> {
  if (opts?.deadlineAtMs != null && Date.now() >= opts.deadlineAtMs) {
    return { tokens: 0, sent: 0, failed: 0, cleaned: 0, skipped: 0, ok: false, lastError: "deadline_exceeded" };
  }
  const fcm = getFcm();
  if (!fcm) return { tokens: 0, sent: 0, failed: 0, cleaned: 0, skipped: 0, ok: false }; // env 미설정 = 인프라 실패

  // 1. 알림 종류별 설정 필터 (row 없음 = 디폴트)
  // ⚠️ .in()에 id를 한 번에 넣으면 대상이 수백 명일 때 URL 한도 초과(Bad Request)
  // — PR #170 어드민 수신함과 동일 함정. IN_CHUNK 단위로 분할 조회.
  const IN_CHUNK = 200;
  let targets = [...new Set(userIds)];
  let skipped = 0;
  if (prefKey) {
    const explicit = new Map<string, boolean>();
    for (let i = 0; i < targets.length; i += IN_CHUNK) {
      const slice = targets.slice(i, i + IN_CHUNK);
      const remainingMs = opts?.deadlineAtMs == null ? null : opts.deadlineAtMs - Date.now();
      if (remainingMs != null && remainingMs <= 0) {
        return { tokens: 0, sent: 0, failed: 0, cleaned: 0, skipped: 0, ok: false, lastError: "deadline_exceeded" };
      }
      const { data: prefRows, error: prefErr } = await supabase
        .from("notification_prefs")
        .select(`user_id, ${prefKey}`)
        .in("user_id", slice);
      if (prefErr) {
        console.error("[fcm] prefs query failed:", prefErr.message);
        return { tokens: 0, sent: 0, failed: 0, cleaned: 0, skipped: 0, ok: false };
      }
      for (const r of prefRows ?? []) {
        const row = r as unknown as Record<string, unknown>;
        explicit.set(row.user_id as string, row[prefKey] as boolean);
      }
    }
    const before = targets.length;
    targets = targets.filter((id) => explicit.get(id) ?? DEFAULT_PREFS[prefKey]);
    skipped = before - targets.length;
  }
  if (targets.length === 0) return { tokens: 0, sent: 0, failed: 0, cleaned: 0, skipped, ok: true };

  // 2. 디바이스 토큰 (동일하게 분할 조회)
  const tokens: string[] = [];
  for (let i = 0; i < targets.length; i += IN_CHUNK) {
    const slice = targets.slice(i, i + IN_CHUNK);
    const rows = await fetchAllByKeyset(
      async (cursor, limit) => {
        const remainingMs = opts?.deadlineAtMs == null ? null : opts.deadlineAtMs - Date.now();
        if (remainingMs != null && remainingMs <= 0) throw new Error("FCM device token targets: deadline_exceeded");
        let tokenQuery = supabase
          .from("device_push_tokens")
          .select("id, fcm_token")
          .in("user_id", slice)
          .order("id", { ascending: true })
          .limit(limit);
        if (platform) tokenQuery = tokenQuery.eq("platform", platform);
        if (opts?.minAppBuild != null) tokenQuery = tokenQuery.gte("app_build", opts.minAppBuild);
        if (cursor !== null) tokenQuery = tokenQuery.gt("id", cursor);
        if (remainingMs != null) tokenQuery = tokenQuery.abortSignal(AbortSignal.timeout(Math.max(1, remainingMs)));
        return tokenQuery;
      },
      (row) => row.id,
      { label: "FCM device token targets" },
    );
    for (const row of rows) tokens.push(row.fcm_token);
  }
  if (tokens.length === 0) return { tokens: 0, sent: 0, failed: 0, cleaned: 0, skipped, ok: true };

  const delivery = await sendFcmToTokens(tokens, payload, { deadlineAtMs: opts?.deadlineAtMs });
  return { ...delivery, skipped };
}

/** 이미 전량 조회·검증한 토큰을 DB 재조회 없이 그대로 발송한다. */
export async function sendFcmToTokens(
  tokens: string[],
  payload: PushPayload,
  opts?: { deadlineAtMs?: number },
): Promise<SendResult> {
  if (opts?.deadlineAtMs != null && Date.now() >= opts.deadlineAtMs) {
    return {
      tokens: tokens.length, sent: 0, failed: tokens.length, cleaned: 0, skipped: 0,
      retryableFailed: tokens.length, ok: false, lastError: "deadline_exceeded",
    };
  }
  let fcm;
  try {
    fcm = getFcm();
  } catch (error) {
    return {
      tokens: tokens.length,
      sent: 0,
      failed: tokens.length,
      cleaned: 0,
      skipped: 0,
      ok: false,
      lastError: error instanceof Error ? error.message : "fcm_init_exception",
    };
  }
  if (!fcm) {
    return { tokens: tokens.length, sent: 0, failed: tokens.length, cleaned: 0, skipped: 0, ok: false, lastError: "missing_fcm_config" };
  }

  // 위젯 제어 스트림 send-time(ms) — 한 발송 내 모든 청크가 동일 w_ts를 갖도록 루프 밖에서 1회 계산.
  const sendStartedAtMs = Date.now();
  const sendTsMs = String(sendStartedAtMs);
  const delivery = await deliverTokenChunks(tokens, async (chunk) => {
    // data-only(ongoing card)는 notification 블록 생략 + title/body를 data에 실음.
    // (네이티브가 data.title/body를 읽어 잠금화면 카드/위젯에 표시 — 삼순 C2 조건)
    const dataBlock: Record<string, string> = {
      ...(payload.url ? { url: payload.url } : {}),
      ...(payload.data ?? {}),
      ...(payload.dataOnly ? { title: payload.title, body: payload.body } : {}),
    };
    // 위젯 제어 스트림(game_live/game_cancel/game_end)엔 서버 send-time(ms)을 실어
    // 네이티브가 순서 역전 배달을 차단(seq 가드)하고 수신→렌더 지연을 계측한다(삼순 vc14).
    // 청크 간 동일 값 보장을 위해 루프 밖 sendTsMs를 사용. w_ts가 이미 있으면 존중.
    if (WIDGET_CONTROL_KINDS.has(dataBlock.kind) && dataBlock.w_ts == null) {
      dataBlock.w_ts = sendTsMs;
    }
    // Android 설정 — data-only는 high priority(Doze 우회), collapseKey/ttl은 지정 시만.
    // 라이브 위젯처럼 매분 갱신되는 푸시에 (경기별 collapseKey + 짧은 ttl)을 주면 옛 상태
    // 백로그 대신 최신 1건만 배달된다. admin SDK의 ttl은 밀리초 단위.
    const androidCfg = {
      ...(payload.dataOnly ? { priority: "high" as const } : {}),
      ...(payload.collapseKey ? { collapseKey: payload.collapseKey } : {}),
      ...(payload.ttlSeconds != null ? { ttl: payload.ttlSeconds * 1000 } : {}),
    };
    return fcm.sendEachForMulticast({
      tokens: chunk,
      ...(payload.dataOnly ? {} : { notification: { title: payload.title, body: payload.body } }),
      ...(Object.keys(dataBlock).length ? { data: dataBlock } : {}),
      ...(Object.keys(androidCfg).length ? { android: androidCfg } : {}),
      // iOS 무음 백그라운드 푸시(Layer 2) — 배너 없이 앱을 깨워 LA 토큰 등록. content-available:1
      // + apns-push-type:background + priority 5(무음 필수). Android엔 apns 블록 무영향.
      ...(payload.apnsBackground
        ? {
            apns: {
              headers: {
                "apns-push-type": "background",
                "apns-priority": "5",
                // 지연 배달 백로그 방지(삼순 #674 blocker③) — 같은 collapse-id는 최신 1건만,
                // 짧은 expiration은 미배달 stale을 폐기(다음 발송이 공 덮어쓰는 스트림 전용).
                ...(payload.apnsCollapseId ? { "apns-collapse-id": payload.apnsCollapseId } : {}),
                ...(payload.apnsExpirationSeconds != null
                  ? { "apns-expiration": String(Math.floor(Date.now() / 1000) + payload.apnsExpirationSeconds) }
                  : {}),
              },
              payload: { aps: { "content-available": 1 } },
            },
          }
        : {}),
    });
  }, 500, { deadlineAtMs: opts?.deadlineAtMs });

  // 4. 무효 토큰 정리
  const CLEANUP_CHUNK = 200;
  for (let i = 0; i < delivery.invalid.length; i += CLEANUP_CHUNK) {
    if (opts?.deadlineAtMs != null && Date.now() >= opts.deadlineAtMs) break;
    const { error: cleanupError } = await supabase
      .from("device_push_tokens")
      .delete()
      .in("fcm_token", delivery.invalid.slice(i, i + CLEANUP_CHUNK));
    if (cleanupError) console.error("[fcm] invalid token cleanup failed:", cleanupError.message);
  }

  return {
    tokens: delivery.tokens,
    sent: delivery.sent,
    failed: delivery.failed,
    cleaned: delivery.invalid.length,
    skipped: 0,
    ok: delivery.ok,
    lastError: delivery.lastError,
    retryableFailed: delivery.retryableFailed,
    sendStartedAtMs,
    sendCompletedAtMs: Date.now(),
  };
}
