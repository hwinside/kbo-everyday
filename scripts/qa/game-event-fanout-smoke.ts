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
  isGameEventDataOnlyToken,
  partitionGameEventTokens,
  buildGameEventData,
  composeGameEventFanout,
  type GameEventEmit,
  type GameEventSub,
  type TokenMeta,
} from "../../src/lib/notifications/game-event-fanout";

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
  const plan = composeGameEventFanout(metas, notif, gameEvent, 1_800_000_999_000);

  check("iOS+구Android → notification 버킷", plan.notificationTokens.sort().join(",") === "ios,old");
  check("신Android → data-only 버킷", plan.dataOnlyTokens.join(",") === "new");
  // notification 버킷 payload = data-only/data 필드 없음(구버전 시스템 렌더용)
  check("notification payload에 dataOnly/data 없음", !("dataOnly" in plan.notificationPayload) && !("data" in plan.notificationPayload));
  // data-only 버킷 payload = dataOnly:true + canonical data
  check("data-only payload dataOnly=true", plan.dataOnlyPayload.dataOnly === true);
  check("data-only payload data.kind=game_event", plan.dataOnlyPayload.data.kind === "game_event");
  check("data-only payload n_expires_at 불변 반영", plan.dataOnlyPayload.data.n_expires_at === String(nExpiresAtMs));

  // 멱등/at-most-one 기반: 같은 이벤트 재시도(동일 입력) → 동일 eventId·n_expires_at·버킷.
  const plan2 = composeGameEventFanout(metas, notif, gameEvent, 1_800_000_999_000);
  check("재시도 plan: eventId 불변", plan2.dataOnlyPayload.data.eventId === plan.dataOnlyPayload.data.eventId);
  check("재시도 plan: n_expires_at 불변", plan2.dataOnlyPayload.data.n_expires_at === plan.dataOnlyPayload.data.n_expires_at);
  check("재시도 plan: 버킷 동일(native at-most-one canonicalKey 안정)",
    plan2.dataOnlyTokens.join(",") === plan.dataOnlyTokens.join(",")
    && plan2.notificationTokens.join(",") === plan.notificationTokens.join(","));

  // 프로덕션(신버전 미출시): 모든 실단말 notification, data-only 버킷 empty → 기존 발송 불변.
  const prod = composeGameEventFanout(
    [{ fcmToken: "a", platform: "ios", appBuild: 300 }, { fcmToken: "b", platform: "android", appBuild: 120 }],
    notif, gameEvent, 1,
  );
  check("프로덕션 유사: data-only 0(기존 발송 경로 불변)", prod.dataOnlyTokens.length === 0 && prod.notificationTokens.length === 2);
}

console.log(`\n[game-event-fanout] ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
