// S2 Slice0 스모크 — canonical data-only game_event emit + 버전 게이트 3분할 fanout + n_expires_at 불변.
// 실행: npm run qa:game-event-fanout
//
// 삼순 계약(스펙 §S2-1/§S2-1b/§S2-5) 회귀 고정. 실 production 발송 헬퍼(composeGameEventFanout /
// buildGameEventData / partitionGameEventTokens / deriveGameEventExpiresAtMs)를 *직접* 호출해
// 3분할 분기 payload를 캡처·검증한다(삼순 실 빌더 검증 선호).

import {
  MIN_GAME_EVENT_ANDROID_BUILD,
  GAME_EVENT_TTL_MS,
  deriveGameEventExpiresAtMs,
  deriveGameEventExpiresAtMsOrNull,
  shouldRetryGameEventSend,
  isGameEventDataOnlyToken,
  partitionGameEventTokens,
  buildGameEventData,
  composeGameEventFanout,
  type GameEventEmit,
  type GameEventSub,
  type TokenMeta,
} from "../../src/lib/notifications/game-event-fanout";
import {
  buildAndroidConfig,
  buildDeadlineAndroidConfig,
} from "../../src/lib/notifications/fcm-android-config";
import { mapHighlightSettlements, type ClaimedHighlightToken } from "../../src/lib/notifications/player-highlight-delivery";
import type { TokenDeliveryOutcome } from "../../src/lib/notifications/fcm-batch";
import { normalizeAppBuild } from "../../src/lib/notifications/app-build";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) { pass += 1; console.log(`  PASS ${name}`); }
  else { fail += 1; console.error(`  FAIL ${name}`); }
}

const SUBS: GameEventSub[] = ["score", "concede", "inning-summary", "fav", "fav-so"];

// ── 1. 버전 게이트 판정(토큰별 3분할) ──────────────────────────────────────
console.log("[game-event-fanout] 버전 게이트 3분할 — iOS/구Android=notification, 신Android=data-only");
{
  check("iOS(빌드 무한대) → notification", isGameEventDataOnlyToken("ios", MIN_GAME_EVENT_ANDROID_BUILD + 100) === false);
  check("Android app_build null → notification(fail-safe 구버전)", isGameEventDataOnlyToken("android", null) === false);
  check("Android 현행 실빌드(예 120) → notification(MIN 미출시라 inert)", isGameEventDataOnlyToken("android", 120) === false);
  check("Android app_build < MIN → notification", isGameEventDataOnlyToken("android", MIN_GAME_EVENT_ANDROID_BUILD - 1) === false);
  check("Android app_build == MIN → data-only", isGameEventDataOnlyToken("android", MIN_GAME_EVENT_ANDROID_BUILD) === true);
  check("Android app_build > MIN → data-only", isGameEventDataOnlyToken("android", MIN_GAME_EVENT_ANDROID_BUILD + 5) === true);
  // 알 수 없는 platform은 fail-safe(notification)
  check("unknown platform → notification", isGameEventDataOnlyToken("web", MIN_GAME_EVENT_ANDROID_BUILD + 5) === false);
}

// ── 2. 토큰 분할(partition) ────────────────────────────────────────────────
console.log("[game-event-fanout] partition — 각 토큰이 정확히 한 버킷");
{
  const metas: TokenMeta[] = [
    { fcmToken: "ios-a", platform: "ios", appBuild: 999999 },
    { fcmToken: "ios-b", platform: "ios", appBuild: null },
    { fcmToken: "and-old-null", platform: "android", appBuild: null },
    { fcmToken: "and-old-120", platform: "android", appBuild: 120 },
    { fcmToken: "and-belowmin", platform: "android", appBuild: MIN_GAME_EVENT_ANDROID_BUILD - 1 },
    { fcmToken: "and-new", platform: "android", appBuild: MIN_GAME_EVENT_ANDROID_BUILD },
    { fcmToken: "and-newer", platform: "android", appBuild: MIN_GAME_EVENT_ANDROID_BUILD + 10 },
  ];
  const { notificationTokens, dataOnlyTokens } = partitionGameEventTokens(metas);
  check("notification 버킷 = iOS+구Android 5개", notificationTokens.length === 5
    && ["ios-a", "ios-b", "and-old-null", "and-old-120", "and-belowmin"].every((t) => notificationTokens.includes(t)));
  check("data-only 버킷 = 신Android 2개", dataOnlyTokens.length === 2
    && ["and-new", "and-newer"].every((t) => dataOnlyTokens.includes(t)));
  check("두 버킷 disjoint + 전체 커버", notificationTokens.length + dataOnlyTokens.length === metas.length
    && new Set([...notificationTokens, ...dataOnlyTokens]).size === metas.length);
  // 현행 프로덕션(신버전 미출시)에선 실단말이 전부 notification — data-only 0(안전).
  const prodLike: TokenMeta[] = [
    { fcmToken: "p1", platform: "ios", appBuild: 210 },
    { fcmToken: "p2", platform: "android", appBuild: 118 },
    { fcmToken: "p3", platform: "android", appBuild: null },
  ];
  check("프로덕션 유사 토큰 → data-only 0(inert)", partitionGameEventTokens(prodLike).dataOnlyTokens.length === 0);
}

// ── 3. data-only payload 필드 완전성(§S2-1) ────────────────────────────────
console.log("[game-event-fanout] data-only payload — canonical 필드 완전성");
{
  const nExpiresAtMs = deriveGameEventExpiresAtMs(1_800_000_000_000);
  for (const sub of SUBS) {
    const e: GameEventEmit = {
      gameId: "20260727LGHH0",
      eventId: `20260727LGHH0-at_bat_hit-3z43vav${sub === "fav" ? "#fav" : sub === "fav-so" ? "#fav-so" : sub === "concede" ? "-concede" : sub === "inning-summary" ? "-summary" : ""}`,
      sub,
      title: "타이틀",
      body: "본문",
      url: "/games/20260727LGHH0",
      nExpiresAtMs,
      wTsMs: 1_800_000_123_456,
    };
    const d = buildGameEventData(e, 999);
    const required = ["kind", "gameId", "eventId", "title", "body", "url", "w_ts", "sub", "n_expires_at"];
    const hasAll = required.every((k) => typeof d[k] === "string" && d[k].length > 0);
    check(`[${sub}] 필수 필드 9종 전부 string`, hasAll);
    check(`[${sub}] kind=game_event`, d.kind === "game_event");
    check(`[${sub}] sub 반영`, d.sub === sub);
    check(`[${sub}] eventId=persistedDedupId 그대로`, d.eventId === e.eventId);
    check(`[${sub}] n_expires_at=절대 epoch ms 문자열`, d.n_expires_at === String(nExpiresAtMs));
    check(`[${sub}] w_ts=지정 send-time 우선`, d.w_ts === "1800000123456");
    // notification payload에는 절대 없어야 할 값이 새지 않게(data 전용 필드)
    check(`[${sub}] gameId 반영`, d.gameId === e.gameId);
  }
  // w_ts 미지정 시 발송 stamp 사용
  const e2: GameEventEmit = { gameId: "g", eventId: "g:score", sub: "score", title: "t", body: "b", url: "/x", nExpiresAtMs };
  check("w_ts 미지정 → stamp 값 사용", buildGameEventData(e2, 424242).w_ts === "424242");
}

// ── 4. n_expires_at 불변(스펙 NO-GO #4) ────────────────────────────────────
console.log("[game-event-fanout] n_expires_at 불변 — source 앵커 재사용, now 재계산 금지");
{
  const sourceMs = 1_800_000_555_000;
  const a = deriveGameEventExpiresAtMs(sourceMs);
  const b = deriveGameEventExpiresAtMs(sourceMs);
  check("동일 source → 동일 n_expires_at", a === b && a === sourceMs + GAME_EVENT_TTL_MS);
  // 같은 이벤트 2회 emit(재시도) → 동일 n_expires_at
  const mk = () => buildGameEventData(
    { gameId: "g", eventId: "g:score", sub: "score", title: "t", body: "b", url: "/x", nExpiresAtMs: a },
    Date.now(),
  ).n_expires_at;
  check("같은 이벤트 2회 build → n_expires_at 동일(불변)", mk() === mk());
  check("6h TTL", GAME_EVENT_TTL_MS === 6 * 60 * 60 * 1000);
}

// ── 5. 3분할 fanout plan(실 발송 헬퍼 직접 호출, payload 캡처) ──────────────
console.log("[game-event-fanout] composeGameEventFanout — 실 헬퍼가 만든 3분할 plan 캡처");
{
  const metas: TokenMeta[] = [
    { fcmToken: "ios", platform: "ios", appBuild: 300 },
    { fcmToken: "old", platform: "android", appBuild: 120 },
    { fcmToken: "new", platform: "android", appBuild: MIN_GAME_EVENT_ANDROID_BUILD },
  ];
  const nExpiresAtMs = deriveGameEventExpiresAtMs(1_800_000_000_000);
  const gameEvent: GameEventEmit = {
    gameId: "20260727LGHH0", eventId: "20260727LGHH0#fav", sub: "fav",
    title: "홈런!", body: "본문", url: "/games/20260727LGHH0", nExpiresAtMs,
  };
  const notif = { title: "홈런!", body: "본문", url: "/games/20260727LGHH0" };
  // nowMs = source 직후(만료 전) — TTL 양수, data-only 버킷 살아있음.
  const nowMs = 1_800_000_000_000 + 60_000;
  const plan = composeGameEventFanout(metas, notif, gameEvent, 1_800_000_999_000, nowMs);

  check("iOS+구Android → notification 버킷", plan.notificationTokens.sort().join(",") === "ios,old");
  check("신Android → data-only 버킷", plan.dataOnlyTokens.join(",") === "new");
  // notification 버킷 payload = data-only/data 필드 없음(구버전 시스템 렌더용)
  check("notification payload에 dataOnly/data 없음", !("dataOnly" in plan.notificationPayload) && !("data" in plan.notificationPayload));
  // data-only 버킷 payload = dataOnly:true + canonical data
  check("data-only payload dataOnly=true", plan.dataOnlyPayload.dataOnly === true);
  check("data-only payload data.kind=game_event", plan.dataOnlyPayload.data.kind === "game_event");
  check("data-only payload n_expires_at 불변 반영", plan.dataOnlyPayload.data.n_expires_at === String(nExpiresAtMs));

  // 멱등/at-most-one 기반: 같은 이벤트 재시도(동일 입력) → 동일 eventId·n_expires_at·버킷.
  const plan2 = composeGameEventFanout(metas, notif, gameEvent, 1_800_000_999_000, nowMs);
  check("재시도 plan: eventId 불변", plan2.dataOnlyPayload.data.eventId === plan.dataOnlyPayload.data.eventId);
  check("재시도 plan: n_expires_at 불변", plan2.dataOnlyPayload.data.n_expires_at === plan.dataOnlyPayload.data.n_expires_at);
  check("재시도 plan: 버킷 동일(native at-most-one canonicalKey 안정)",
    plan2.dataOnlyTokens.join(",") === plan.dataOnlyTokens.join(",")
    && plan2.notificationTokens.join(",") === plan.notificationTokens.join(","));

  // 프로덕션(신버전 미출시): 모든 실단말 notification, data-only 버킷 empty → 기존 발송 불변.
  const prod = composeGameEventFanout(
    [{ fcmToken: "a", platform: "ios", appBuild: 300 }, { fcmToken: "b", platform: "android", appBuild: 120 }],
    notif, gameEvent, 1, nowMs,
  );
  check("프로덕션 유사: data-only 0(기존 발송 경로 불변)", prod.dataOnlyTokens.length === 0 && prod.notificationTokens.length === 2);
}

// ── 6. data-only FCM TTL(NO-GO #1) — 발송시각 기준 남은시간, 만료 시 drop, 양 transport 동일 ──
console.log("[game-event-fanout] TTL — n_expires_at-now 계산 + 만료 drop + Admin/HTTP 동일 TTL");
{
  const sourceMs = 1_800_000_000_000;
  const nExpiresAtMs = deriveGameEventExpiresAtMs(sourceMs); // source + 6h
  const metas: TokenMeta[] = [
    { fcmToken: "ios", platform: "ios", appBuild: 300 },
    { fcmToken: "new", platform: "android", appBuild: MIN_GAME_EVENT_ANDROID_BUILD },
  ];
  const notif = { title: "t", body: "b", url: "/x" };
  const ge: GameEventEmit = { gameId: "g", eventId: "g:score", sub: "score", title: "t", body: "b", url: "/x", nExpiresAtMs };

  // (a) 만료 1시간 전: TTL ≈ 5h, data-only 살아있음
  const nowLive = sourceMs + 60 * 60 * 1000; // +1h → 남은 5h
  const planLive = composeGameEventFanout(metas, notif, ge, 1, nowLive);
  const expectTtl = Math.ceil((nExpiresAtMs - nowLive) / 1000);
  check("TTL = ceil((n_expires_at-now)/1000)", planLive.dataOnlyPayload.ttlSeconds === expectTtl && expectTtl === 5 * 60 * 60);
  check("만료 전 → data-only 버킷 살아있음", planLive.dataOnlyExpired === false && planLive.dataOnlyTokens.join(",") === "new");
  check("만료 전 → iOS는 notification 버킷", planLive.notificationTokens.join(",") === "ios");
  // (b) Admin SDK와 HTTP deadline transport 양쪽에 동일 TTL이 실린다(실 빌더 직호).
  const admin = buildAndroidConfig(planLive.dataOnlyPayload);
  const deadline = buildDeadlineAndroidConfig(planLive.dataOnlyPayload);
  check("Admin SDK TTL = ttlSeconds*1000(ms)", admin.ttl === expectTtl * 1000);
  check("HTTP deadline TTL = '<ttlSeconds>s'", deadline.ttl === `${expectTtl}s`);
  check("양 transport TTL 동일(ms÷1000 == 초)", (admin.ttl as number) / 1000 === Number(String(deadline.ttl).replace("s", "")));
  check("data-only priority high(Admin)/HIGH(HTTP)", admin.priority === "high" && deadline.priority === "HIGH");

  // (c) 이미 만료(now >= n_expires_at) → FCM 호출 전 drop(data-only 버킷 empty), notification으로 안 옮김
  const nowExpired = nExpiresAtMs + 1;
  const planDead = composeGameEventFanout(metas, notif, ge, 1, nowExpired);
  check("만료 → dataOnlyExpired=true", planDead.dataOnlyExpired === true);
  check("만료 → data-only 버킷 empty(drop)", planDead.dataOnlyTokens.length === 0);
  check("만료 → 신Android가 notification으로 옮겨지지 않음(iOS만)", planDead.notificationTokens.join(",") === "ios");
  check("만료 경계(now==n_expires_at) → drop", composeGameEventFanout(metas, notif, ge, 1, nExpiresAtMs).dataOnlyExpired === true);
}

// ── 7. fail-closed n_expires_at 앵커(NO-GO #2) — 안정 source 없으면 null(now 재계산 금지) ──
console.log("[game-event-fanout] fail-closed 앵커 — invalid source → null(data-only 미첨부)");
{
  const src = 1_800_000_000_000;
  check("유효 source → source+6h", deriveGameEventExpiresAtMsOrNull(src) === src + GAME_EVENT_TTL_MS);
  check("NaN(timestamp parse 실패) → null", deriveGameEventExpiresAtMsOrNull(Number.NaN) === null);
  check("Infinity → null", deriveGameEventExpiresAtMsOrNull(Number.POSITIVE_INFINITY) === null);
  check("Date.parse('') → null(now 폴백 없음)", deriveGameEventExpiresAtMsOrNull(Date.parse("")) === null);
  // 같은 source 2회(재시도) → 동일 값(now 미사용 → 불변)
  check("invalid source 2회 → 둘 다 null(재시도 동일)",
    deriveGameEventExpiresAtMsOrNull(Number.NaN) === deriveGameEventExpiresAtMsOrNull(Number.NaN));
  check("valid source 2회 → 동일(now 재계산 0)", deriveGameEventExpiresAtMsOrNull(src) === deriveGameEventExpiresAtMsOrNull(src));
}

// ── 8. at-least-once retry gate + token 원장 settle(NO-GO #3) ──
console.log("[game-event-fanout] at-least-once — transient retry gate + highlight token settle(accepted 미재발·transient 재시도)");
{
  // (a) event-global claim(score/concede/inning) retry gate: transient(retryableFailed>0)도 재시도.
  check("ok=true & retryable=0 → 재시도 안 함", shouldRetryGameEventSend({ ok: true, retryableFailed: 0 }) === false);
  check("ok=true & retryable>0(token transient) → 재시도(at-least-once)", shouldRetryGameEventSend({ ok: true, retryableFailed: 1 }) === true);
  check("ok=false(청크 throw/deadline) → 재시도", shouldRetryGameEventSend({ ok: false }) === true);
  check("retryableFailed undefined → 0 취급", shouldRetryGameEventSend({ ok: true }) === false);

  // (b) fav/fav-so token 원장: bucket1 accepted → crash(미시도/2번째 throw) → retry에서
  //     accepted는 accepted로 settle(미재발), transient/누락만 transient로 settle(재시도).
  const claimed: ClaimedHighlightToken[] = [
    { tokenId: 1, tokenHash: "h1", fcmToken: "t-accepted" },
    { tokenId: 2, tokenHash: "h2", fcmToken: "t-transient" },
    { tokenId: 3, tokenHash: "h3", fcmToken: "t-missing" }, // crash로 outcome 유실
  ];
  const outcomes: TokenDeliveryOutcome[] = [
    { token: "t-accepted", status: "accepted", errorCode: null },
    { token: "t-transient", status: "transient", errorCode: "messaging/internal-error" },
    // t-missing은 부분발송 후 crash로 outcome 없음
  ];
  const settled = mapHighlightSettlements(claimed, outcomes, "partial_crash");
  const byId = new Map(settled.map((s) => [s.token_id, s]));
  check("accepted token → settle 'accepted'(retry에 미재발)", byId.get(1)?.status === "accepted");
  check("transient token → settle 'transient'(재시도)", byId.get(2)?.status === "transient");
  check("outcome 누락(crash) token → settle 'transient'(재시도)", byId.get(3)?.status === "transient");
  // settle RPC는 status로 retry를 가른다(error는 진단용) → accepted 1개만 재발송 대상에서 제외, 나머지 2개만 재시도.
  const retryCount = settled.filter((s) => s.status !== "accepted").length;
  check("부분성공 crash → accepted 1 제외·transient 2만 재시도", retryCount === 2 && byId.get(1)?.status === "accepted");
}

// ── 9. app_build 정규화 wiring(NO-GO #4) — route/client 동일 규칙 잠금 ──
console.log("[game-event-fanout] normalizeAppBuild — register-device route + native-push 공용");
{
  check("유효 정수 → 그대로", normalizeAppBuild(120) === 120);
  check("소수 → trunc", normalizeAppBuild(120.9) === 120);
  check("문자열 숫자 → 정수", normalizeAppBuild("210") === 210);
  check("null → null(구버전)", normalizeAppBuild(null) === null);
  check("undefined → null", normalizeAppBuild(undefined) === null);
  check("0 → null(fail-closed)", normalizeAppBuild(0) === null);
  check("음수 → null", normalizeAppBuild(-5) === null);
  check("NaN/비수치 → null", normalizeAppBuild("abc") === null && normalizeAppBuild(Number.NaN) === null);
  check("MIN 임계값 그대로 보존", normalizeAppBuild(MIN_GAME_EVENT_ANDROID_BUILD) === MIN_GAME_EVENT_ANDROID_BUILD);
}

console.log(`\n[game-event-fanout] ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
