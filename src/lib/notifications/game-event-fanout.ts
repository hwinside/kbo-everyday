// S2 Slice0 — canonical data-only `game_event` emit + 버전 게이트 3분할 fanout (서버 파트).
// 스펙: specs/notif-s2-native-grouping.md §S2-1 / §S2-1b / §③ 서버파트.
//
// 이 모듈은 *순수 헬퍼*만 담는다(supabase/FCM 의존 0) — 실 발송 fanout(토큰 조회·2버킷
// 전송·결과 병합)은 fcm.ts가 이 헬퍼들을 조합해 수행한다(순환 import 회피).
//
// Slice0 계약(회귀 위험 0): MIN 임계값이 *아직 미출시* versionCode라 현 실단말 중
// `app_build >= MIN`인 Android가 없다 → data-only 버킷은 프로덕션에서 항상 비어 있고,
// 모든 실트래픽은 기존과 동일하게 notification 버킷으로만 나간다(iOS/구Android 경로 불변).
// 실제 게이트 전환(신버전 versionCode 확정)은 §⑤ Slice5에서 수행.

/** 이벤트 배너 구독 namespace — 서버 dedup suffix와 1:1(§S2-1b 실측 5종). */
export type GameEventSub = "score" | "concede" | "inning-summary" | "fav" | "fav-so";

/**
 * data-only `game_event`를 native 렌더하는 첫 Android 릴리즈의 versionCode(임계값).
 * ⚠️ 아직 그 릴리즈가 출시되지 않았다 — 센티넬로 매우 큰 값을 두어 *어떤 실단말도* 이
 * 값 이상이 되지 않게 한다(data-only 버킷 inert = fail-safe). Slice5(게이트 전환)에서
 * 실제 출시 빌드의 versionCode로 교체한다. 이 상수를 낮추는 순간 신Android로 data-only가
 * 실제 배달되기 시작하므로, native 렌더(Slice1~4)·QA가 끝난 뒤에만 조정한다.
 */
export const MIN_GAME_EVENT_ANDROID_BUILD = 2_147_483_600;

/** 이벤트 알림 절대 보존 상한 = 6시간(하린아빠 2026-07-27 확정). */
export const GAME_EVENT_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * `n_expires_at`(절대 만료 epoch ms) 유도 = 최초 source event/원장 row 시각 + 6h.
 * ⚠️ 불변 계약(스펙 NO-GO #4): `now` 기준이 아니라 **source 시각**을 앵커로 쓴다 —
 * live/due/token-ledger 재시도가 동일 source 시각으로 호출하면 동일 값이 나온다(재계산 금지).
 * 호출자는 재시도 간 안정된 앵커(이벤트 timestamp / 원장 row created_at)를 넘겨야 한다.
 */
export function deriveGameEventExpiresAtMs(sourceEpochMs: number): number {
  return sourceEpochMs + GAME_EVENT_TTL_MS;
}

/**
 * fail-closed 변형(스펙 NO-GO #2): 안정 source(유한 epoch ms)가 없으면 **null**을 돌려
 * 호출자가 `now` 재계산으로 매 재시도마다 다른 만료를 굽는 것을 금지한다. null이면 호출자는
 * data-only `game_event`를 붙이지 않고 기존 notification 경로로만 발송한다(구버전 fanout 유지).
 */
export function deriveGameEventExpiresAtMsOrNull(sourceEpochMs: number): number | null {
  return Number.isFinite(sourceEpochMs) ? sourceEpochMs + GAME_EVENT_TTL_MS : null;
}

/**
 * 이벤트 발송 결과가 재시도(선점 해제)돼야 하는지(스펙 NO-GO #3 — at-least-once).
 * `res.ok=false`(청크 throw/deadline/init 실패)뿐 아니라 **token별 transient(retryableFailed>0)**
 * 도 재시도 대상이다. 기존엔 transient가 남아도 event-global claim이 유지돼 그 토큰이 영구
 * 미재시도였다(= at-least-once 아님). token 원장이 있는 fav/fav-so는 원장이 selective retry를
 * 담당하므로 이 gate는 event-global claim(score/concede/inning-summary)에서 쓴다.
 */
export function shouldRetryGameEventSend(res: { ok: boolean; retryableFailed?: number }): boolean {
  return !res.ok || (res.retryableFailed ?? 0) > 0;
}

/**
 * 이 토큰이 data-only `game_event` 대상인지(신Android) 판정.
 * - iOS → false(notification 유지, APNs 경로 불변)
 * - Android `app_build` null/구버전(< MIN) → false(fail-safe, notification 유지)
 * - Android `app_build >= MIN` → true(data-only native 렌더)
 */
export function isGameEventDataOnlyToken(
  platform: string | null | undefined,
  appBuild: number | null | undefined,
): boolean {
  return platform === "android" && appBuild != null && appBuild >= MIN_GAME_EVENT_ANDROID_BUILD;
}

export interface TokenMeta {
  fcmToken: string;
  platform: string | null;
  appBuild: number | null;
}

/** 토큰 목록을 notification 버킷(iOS+구Android)과 data-only 버킷(신Android)으로 3분할. */
export function partitionGameEventTokens(metas: TokenMeta[]): {
  notificationTokens: string[];
  dataOnlyTokens: string[];
} {
  const notificationTokens: string[] = [];
  const dataOnlyTokens: string[] = [];
  for (const m of metas) {
    if (isGameEventDataOnlyToken(m.platform, m.appBuild)) dataOnlyTokens.push(m.fcmToken);
    else notificationTokens.push(m.fcmToken);
  }
  return { notificationTokens, dataOnlyTokens };
}

/** data-only `game_event` 1건에 필요한 canonical 필드(§S2-1). */
export interface GameEventEmit {
  gameId: string;
  /** = persistedDedupId(발송 원장에 영속된 dedup id 그 자체, sub suffix 이미 encode — §S2-1b). */
  eventId: string;
  sub: GameEventSub;
  title: string;
  body: string;
  url: string;
  /** 절대 만료 epoch ms(불변, deriveGameEventExpiresAtMs). */
  nExpiresAtMs: number;
  /** 서버 send-time ms(순서 신호). 미지정 시 발송 시점에 stamp. */
  wTsMs?: number;
}

/**
 * FCM data 블록(전부 string) — native가 `kind=game_event`로 파싱해 렌더(Slice1~).
 * fcm.ts의 dataOnly 전송(`data:` 블록)에 그대로 실린다.
 */
export function buildGameEventData(
  e: GameEventEmit,
  wTsMs: number,
): Record<string, string> {
  return {
    kind: "game_event",
    gameId: e.gameId,
    eventId: e.eventId,
    title: e.title,
    body: e.body,
    url: e.url,
    w_ts: String(e.wTsMs ?? wTsMs),
    sub: e.sub,
    n_expires_at: String(e.nExpiresAtMs),
  };
}

export interface GameEventNotification {
  title: string;
  body: string;
  url: string;
}

export interface GameEventFanoutPlan {
  /** iOS + 구Android(app_build null/<MIN) — 기존 notification payload 그대로. */
  notificationTokens: string[];
  notificationPayload: GameEventNotification;
  /**
   * 신Android(app_build>=MIN) — notification 블록 없는 data-only `game_event`.
   * ⚠️ 이미 만료(now >= n_expires_at)면 **비어 있다**(FCM 호출 전 drop, NO-GO #1). 만료분은
   * notification 버킷으로 옮기지 않는다 — stale 이벤트는 어느 경로로도 렌더하지 않는다(스펙 §S2-1).
   */
  dataOnlyTokens: string[];
  dataOnlyPayload: GameEventNotification & {
    dataOnly: true;
    data: Record<string, string>;
    /** 발송시각 기준 남은 절대시간(초) = ceil((n_expires_at - now)/1000). Admin/HTTP 양 transport 공용. */
    ttlSeconds: number;
  };
  /** now >= n_expires_at 라 data-only를 drop했는지(회귀 가시성). */
  dataOnlyExpired: boolean;
}

/**
 * 버전 게이트 3분할 발송 *plan*을 순수 계산(실 발송만 별도) — 삼순 “실 빌더 직호” 검증의 seam.
 * 두 버킷의 토큰 집합과 각각이 받을 payload를 확정한다. fcm.ts의 실 fanout과 smoke가 *동일* 함수를 호출.
 */
export function composeGameEventFanout(
  metas: TokenMeta[],
  notification: GameEventNotification,
  gameEvent: GameEventEmit,
  wTsMs: number,
  nowMs: number,
): GameEventFanoutPlan {
  const { notificationTokens, dataOnlyTokens } = partitionGameEventTokens(metas);
  // TTL은 *발송시각*(nowMs) 기준으로 매번 계산한다 — payload의 n_expires_at 불변성과는 별개 축.
  // n_expires_at은 최초 1회 확정 절대값(재시도 불변), TTL은 그 절대값까지 "지금부터 남은 초".
  const ttlSeconds = Math.max(0, Math.ceil((gameEvent.nExpiresAtMs - nowMs) / 1000));
  const dataOnlyExpired = ttlSeconds <= 0; // now >= n_expires_at → FCM 호출 전 drop(NO-GO #1)
  return {
    notificationTokens,
    notificationPayload: {
      title: notification.title,
      body: notification.body,
      url: notification.url,
    },
    // 만료면 data-only 대상 토큰을 전부 drop(notification 버킷으로 옮기지 않음).
    dataOnlyTokens: dataOnlyExpired ? [] : dataOnlyTokens,
    dataOnlyPayload: {
      title: gameEvent.title,
      body: gameEvent.body,
      url: gameEvent.url,
      dataOnly: true,
      data: buildGameEventData(gameEvent, wTsMs),
      ttlSeconds,
    },
    dataOnlyExpired,
  };
}
