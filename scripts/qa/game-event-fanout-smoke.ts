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
import { normalizeAppBuild, appBuildFromNativeInfo } from "../../src/lib/notifications/app-build";

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

// ── 10. native-push App.getInfo().build → appBuild 실함수 매핑(NO-GO #3 client wiring) ──
console.log("[game-event-fanout] appBuildFromNativeInfo — native-push가 실제 호출하는 getInfo().build 매핑");
{
  check("getInfo build 정수 → 그대로", appBuildFromNativeInfo({ build: 210 }) === 210);
  check("getInfo build 문자열 → 정수(Capacitor는 string 반환)", appBuildFromNativeInfo({ build: "210" }) === 210);
  check("getInfo build 0/누락 → null(구버전)", appBuildFromNativeInfo({ build: 0 }) === null && appBuildFromNativeInfo({}) === null);
  check("info null(getInfo 실패) → null", appBuildFromNativeInfo(null) === null);
  // 서버 route와 동일 규칙(양측 잠금): 같은 입력에 같은 결과.
  check("client/route 동일 규칙", appBuildFromNativeInfo({ build: "abc" }) === normalizeAppBuild("abc"));
}

// ── 11. register-device route 실배선: body.appBuild → normalizeAppBuild → app_build 저장(helper-only 탈피) ──
async function verifyRegisterDeviceWiring(): Promise<void> {
  console.log("[game-event-fanout] register-device route — body.appBuild가 app_build로 저장되는 실경로");
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://appbuild-smoke.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "appbuild-smoke-key";
  const { supabaseAdmin } = await import("../../src/lib/supabase/admin");
  const admin = supabaseAdmin as unknown as {
    auth: { getUser: (t: string) => Promise<unknown> };
    from: (t: string) => unknown;
  };
  // getVerifiedUserFromRequest가 붙는 동일 싱글톤이라 auth.getUser 모킹이 적용된다.
  admin.auth = { getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }) };
  let captured: { payload: Record<string, unknown>; options: unknown } | null = null;
  admin.from = (table: string) => {
    if (table === "device_push_tokens") {
      return {
        upsert: async (payload: Record<string, unknown>, options: unknown) => {
          captured = { payload, options };
          return { error: null };
        },
      };
    }
    throw new Error("urgent-notice path skipped in smoke"); // route try/catch가 삼킴
  };
  const { POST } = await import("../../src/app/api/push/register-device/route");
  async function post(appBuild: unknown): Promise<Record<string, unknown> | null> {
    captured = null;
    const req = new Request("https://x/api/push/register-device", {
      method: "POST",
      headers: { authorization: "Bearer tok", "content-type": "application/json" },
      body: JSON.stringify({ fcmToken: "fcm-abc", platform: "android", appBuild }),
    });
    await POST(req as never);
    return captured?.payload ?? null;
  }
  const p210 = await post("210");
  check("route: body.appBuild '210' → app_build 210 저장", p210?.app_build === 210);
  check("route: fcm_token/platform 그대로 저장", p210?.fcm_token === "fcm-abc" && p210?.platform === "android");
  const p0 = await post(0);
  check("route: body.appBuild 0 → app_build null(fail-closed)", p0?.app_build === null);
  const pMissing = await post(undefined);
  check("route: appBuild 미보고 → app_build null", pMissing?.app_build === null);
  const p1209 = await post("120.9");
  check("route 저장값 == normalizeAppBuild(동일 규칙)", p1209?.app_build === normalizeAppBuild("120.9"));
}

// ── 12. native-push registerTokenWithServer 실배선: App.getInfo().build → fetch body.appBuild ──
// (삼순 3차 NO-GO #3 client wiring) — 지금까지 appBuildFromNativeInfo() 단위 호출만 검증해
// getInfo→body 매핑이 끊겨도 통과했다. 실 함수를 주입 seam으로 호출해 body 조립 경로를 잠근다.
async function verifyNativePushWiring(): Promise<void> {
  console.log("[game-event-fanout] native-push registerTokenWithServer — App.getInfo().build → body.appBuild 실배선");
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://appbuild-smoke.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-smoke-key";
  const { registerTokenWithServer } = await import("../../src/lib/native-push");
  let captured: Record<string, unknown> | null = null;
  const fetchImpl = (async (_url: unknown, init: { body: string }) => {
    captured = JSON.parse(init.body) as Record<string, unknown>;
    return { ok: true } as Response;
  }) as unknown as typeof fetch;

  const ok = await registerTokenWithServer("fcm-xyz", {
    getAccessToken: async () => "access-tok",
    getAppInfo: async () => ({ build: "210" }),
    fetchImpl, platform: "android",
  });
  check("native-push: getInfo().build '210' → body.appBuild 210(실배선)", captured?.appBuild === 210);
  check("native-push: fcmToken/platform도 body에 실림", captured?.fcmToken === "fcm-xyz" && captured?.platform === "android");
  check("native-push: 등록 성공 반환", ok === true);

  // getInfo throw(브릿지 없음) → appBuild null(fail-closed)로도 등록 진행
  captured = null;
  await registerTokenWithServer("fcm-2", {
    getAccessToken: async () => "t",
    getAppInfo: async () => { throw new Error("no native bridge"); },
    fetchImpl, platform: "ios",
  });
  check("native-push: getInfo throw → body.appBuild null(구버전 fail-closed)", captured?.appBuild === null && captured?.platform === "ios");

  // getInfo build 0/누락 → null (route와 동일 normalizeAppBuild 규칙)
  captured = null;
  await registerTokenWithServer("fcm-3", {
    getAccessToken: async () => "t", getAppInfo: async () => ({ build: 0 }), fetchImpl, platform: "android",
  });
  check("native-push: getInfo build 0 → body.appBuild null(route 동일 규칙)", captured?.appBuild === normalizeAppBuild(0));

  // 세션 없음 → fetch 미호출·false (네트워크/getInfo 접근 전 종료)
  let fetchCalled = false;
  const fx = (async () => { fetchCalled = true; return { ok: true } as Response; }) as unknown as typeof fetch;
  const r = await registerTokenWithServer("fcm-4", { getAccessToken: async () => null, fetchImpl: fx });
  check("native-push: 세션 없음 → fetch 미호출·false", r === false && fetchCalled === false);
}

// ── 13. sendGameEventToTokens meta never-settle → deadline abort·FCM 0 (삼순 3차 NO-GO #3 실행 회귀) ──
// PR이 보고만 하고 실행 회귀가 없던 "meta never-settle → deadline 종료·lease 중복 0"을 실측 잠금.
async function verifyMetaNeverSettleDeadline(): Promise<void> {
  console.log("[game-event-fanout] sendGameEventToTokens — meta never-settle 주입 → deadline abort·새 FCM 0");
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://meta-smoke.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "meta-smoke-key";
  const [{ sendGameEventToTokens }, { supabaseAdmin }] = await Promise.all([
    import("../../src/lib/notifications/fcm"),
    import("../../src/lib/supabase/admin"),
  ]);
  const admin = supabaseAdmin as unknown as { from: (t: string) => unknown };
  const originalFrom = admin.from;

  // device_push_tokens meta 조회가 영원히 settle 안 되는 상황 주입. abortSignal이 붙고
  // runBeforeDeadline이 deadline에 reject → 메타 수집 break → 남은 토큰은 fail-safe notification.
  let abortSignalAttached = false;
  admin.from = (table: string) => {
    if (table !== "device_push_tokens") throw new Error(`unexpected table ${table}`);
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.in = () => b;
    b.abortSignal = () => { abortSignalAttached = true; return b; };
    // never-settle: onFulfilled/onRejected를 절대 호출하지 않아 runBeforeDeadline 타임아웃이 이긴다.
    b.then = () => new Promise(() => {});
    return b;
  };

  try {
    const t0 = Date.now();
    const deadlineAtMs = t0 + 300; // 300ms 안에 반드시 종료(무한 hang 방지 실증)
    const res = await sendGameEventToTokens(
      ["tok-1", "tok-2", "tok-3"],
      { title: "t", body: "b", url: "/x" },
      { gameId: "g", eventId: "g#fav", sub: "fav", title: "t", body: "b", url: "/x", nExpiresAtMs: deriveGameEventExpiresAtMs(t0) },
      { deadlineAtMs },
    );
    const elapsed = Date.now() - t0;
    check("meta never-settle: abortSignal이 meta query에 결속됨", abortSignalAttached === true);
    check("meta never-settle: deadline(≈300ms) 내 종료(무한 hang 0)", elapsed < 3000);
    check("meta never-settle: 새 FCM 발송 0(deadline 초과 → send skip)", res.sent === 0);
    check("meta never-settle: ok=false(deadline_exceeded 표식)", res.ok === false);
  } finally {
    admin.from = originalFrom;
  }
}

// ── 14. deliverScoreFamilyEvent/due-drain deadline·lease 결속 (삼순 4차 NO-GO #2 실행 회귀) ──
// 삼순 4차 지적: 기존 "claim never-settle"이 실제 never-settle이 아니라 즉시 {data:[]} 반환 + abortSignal
// 부착 여부만 확인 → false-green. 여기서는 (1) 진짜 pending Promise를 주입하고 abortSignal이 실제 reject를
// 유발해 함수가 lease(20s) 훨씬 전에 종료·FCM 0을 실증, (2) settle never-settle → bounded abort를 실행으로
// 잠근다. "abortSignal 붙었나" assertion을 실행 결과(deadline 내 종료 + send/settle 도달 카운트)로 교체.
async function verifyScoreFamilyDeadline(): Promise<void> {
  console.log("[game-event-fanout] deliverScoreFamilyEvent — 실 지연 주입: claim/settle never-settle abort·FCM 0·bounded 종료");
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://sf-smoke.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sf-smoke-key";
  const [{ deliverScoreFamilyEvent, drainDueScoreFamilyEvents }, { supabaseAdmin }] = await Promise.all([
    import("../../src/lib/notifications/game-event-delivery"),
    import("../../src/lib/supabase/admin"),
  ]);
  const admin = supabaseAdmin as unknown as { rpc: (fn: string, args?: unknown) => unknown };
  const originalRpc = admin.rpc;
  // AbortSignal.timeout()은 unref'd 타이머라 실 IO가 없는 테스트에서는 event loop가 비어 abort 전 프로세스가
  // 종료될 수 있다(실 코드는 DB 소켓으로 loop 유지). 대기 구간 동안 loop를 살려둔다(ref'd timer).
  const keepAlive = setInterval(() => {}, 250);

  // supabase-js abortSignal 계약을 충실히 모사: 시그널 abort 시 reject, 그 외엔 영원히 pending(진짜 never-settle).
  const abortableNeverSettle = () => ({
    abortSignal: (sig: AbortSignal) => new Promise((_res, reject) => {
      if (sig.aborted) { reject(new Error("AbortError: aborted")); return; }
      sig.addEventListener("abort", () => reject(new Error("AbortError: aborted")), { once: true });
    }),
  });

  try {
    // (a) request deadline이 이미 지난 상태 → 루프 최초 guard에서 즉시 break, 신규 claim RPC 0회.
    let claimCallsA = 0;
    admin.rpc = (fn: string) => {
      if (fn === "claim_game_event_tokens") claimCallsA += 1;
      return { abortSignal: () => Promise.resolve({ data: [], error: null }) };
    };
    const rA = await deliverScoreFamilyEvent({
      eventId: "ev-past", gameId: "g", sub: "score", prefKey: "my_team_score",
      teamId: 1, title: "t", body: "b", url: "/x", sourceEpochMs: Date.now(), deadlineAtMs: Date.now() - 1,
    });
    check("score-family: request deadline 이후 같은 invocation 신규 claim 0회", claimCallsA === 0 && rA.accepted === 0);

    // (b) claim promise never-settle(진짜 pending) → attempt 마감 abortSignal이 실제 reject를 유발해
    //     lease(20s) 훨씬 전에 종료. claim 1회만(다음 분 overlap 0). send/settle 미도달 → FCM 0.
    let claimCallsB = 0;
    let settleCallsB = 0;
    admin.rpc = (fn: string) => {
      if (fn === "claim_game_event_tokens") { claimCallsB += 1; return abortableNeverSettle(); }
      if (fn === "settle_game_event_tokens") { settleCallsB += 1; return { abortSignal: () => Promise.resolve({ data: 0, error: null }) }; }
      return { abortSignal: () => Promise.resolve({ data: [], error: null }) };
    };
    const t0 = Date.now();
    let threwB: Error | null = null;
    // deadlineAtMs = t0+800 → attemptDeadline=t0+800 → AbortSignal.timeout(≈800ms)가 claim을 reject.
    try {
      await deliverScoreFamilyEvent({
        eventId: "ev-hang", gameId: "g", sub: "score", prefKey: "my_team_score",
        teamId: 1, title: "t", body: "b", url: "/x", sourceEpochMs: Date.now(), deadlineAtMs: t0 + 800,
      });
    } catch (e) { threwB = e as Error; }
    const elapsedB = Date.now() - t0;
    // abort는 query promise를 reject하므로 throw된 에러 = 원(abort) 에러. 단계(claim vs settle) 구분은 call 카운트로.
    check("claim never-settle: abort로 실제 reject·throw(경로 종료)", threwB != null && /abort/i.test(threwB.message));
    check("claim never-settle: lease(20s) 훨씬 전 종료(≈800ms, 무한 hang 0)", elapsedB >= 700 && elapsedB < 5000);
    check("claim never-settle: 신규 claim 1회만(다음 분 overlap 0)", claimCallsB === 1);
    check("claim never-settle: claim 단계에서 abort → FCM/settle 미도달(새 발송 0)", settleCallsB === 0);

    // (c) settle never-settle(진짜 pending) → bounded abort. claim은 토큰 1개 반환, transport deadline은
    //     이미 지나 send가 deadline_exceeded로 즉시 반환(네트워크 0), settle에서 abort로 bounded 종료.
    let claimCallsC = 0;
    let settleCallsC = 0;
    admin.rpc = (fn: string) => {
      if (fn === "claim_game_event_tokens") {
        claimCallsC += 1;
        return { abortSignal: () => Promise.resolve({ data: [{ token_id: 1, token_hash: "h", fcm_token: "tok", platform: "ios", app_build: null }], error: null }) };
      }
      if (fn === "settle_game_event_tokens") { settleCallsC += 1; return abortableNeverSettle(); }
      return { abortSignal: () => Promise.resolve({ data: [], error: null }) };
    };
    const t1 = Date.now();
    let threwC: Error | null = null;
    // deadlineAtMs = t1+2500 → transportDeadline<=now(전송 즉시 deadline_exceeded, 네트워크 0) →
    // settleTimeoutMs≈2500 → settle abortSignal.timeout이 bounded 종료 유발.
    try {
      await deliverScoreFamilyEvent({
        eventId: "ev-settle-hang", gameId: "g", sub: "score", prefKey: "my_team_score",
        teamId: 1, title: "t", body: "b", url: "/x", sourceEpochMs: Date.now(), deadlineAtMs: t1 + 2500,
      });
    } catch (e) { threwC = e as Error; }
    const elapsedC = Date.now() - t1;
    check("settle never-settle: claim 1회 후 settle 도달(send 경로 관통)", claimCallsC === 1 && settleCallsC === 1);
    check("settle never-settle: bounded abort로 throw(무한 hang 0, lease 내)", threwC != null && /abort/i.test(threwC.message) && elapsedC >= 2000 && elapsedC < 8000);
    // 계약(accepted-before-settle crash): settle이 abort로 checkpoint를 못 남기면 토큰은 leased로 남아
    // lease 만료 후 재claim → 재발송(at-least-once, prod dedup 없어 중복 위험). 이 재발송 창은
    // game-event-delivery-pg17.sh (f) accepted-before-settle에서 원장 상태로 회귀 고정한다.

    // (d) due-drain: list_due RPC에 abortSignal 결속·정상 반환(회귀 유지).
    let dueAbortAttached = false;
    admin.rpc = (fn: string) => ({
      abortSignal: (sig: AbortSignal) => {
        if (fn === "list_due_game_event_snapshots") { dueAbortAttached = sig instanceof AbortSignal; }
        return Promise.resolve({ data: [], error: null });
      },
    });
    const rD = await drainDueScoreFamilyEvents({ deadlineAtMs: Date.now() + 5000 });
    check("score-family due: list_due abortSignal 결속·정상 반환", dueAbortAttached === true && rD.accepted === 0);
  } finally {
    clearInterval(keepAlive);
    admin.rpc = originalRpc;
  }
}

async function main(): Promise<void> {
  await verifyRegisterDeviceWiring();
  await verifyNativePushWiring();
  await verifyMetaNeverSettleDeadline();
  await verifyScoreFamilyDeadline();
}

main()
  .catch((e) => { fail += 1; console.error("  FAIL async wiring suite threw:", e); })
  .finally(() => {
    console.log(`\n[game-event-fanout] ${pass} passed, ${fail} failed`);
    if (fail > 0) process.exit(1);
  });
