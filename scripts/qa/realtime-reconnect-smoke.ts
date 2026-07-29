/**
 * Realtime 재연결 백오프/재구독 판정 순수 헬퍼 스모크.
 * 2026-07-28 재구독 폭주(양의 피드백) P0 회귀를 결정론으로 고정한다(dev-server 불필요).
 *
 * 실행: npx tsx scripts/qa/realtime-reconnect-smoke.ts
 */
import { computeReconnectDelay, shouldResubscribeOnVisible } from "../../src/lib/supabase/realtime-reconnect";
import { createRealtimeChannelLifecycle, type RealtimeLifecycleStatus } from "../../src/lib/supabase/realtime-channel-lifecycle";
import { RealtimeChannel, RealtimeClient } from "@supabase/realtime-js";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) { pass++; }
  else { fail++; console.error(`  ✗ ${name}`); }
}

// random=0 으로 jitter 제거 → 순수 지수 백오프 값 검증.
const noJitter = { random: () => 0 };

// --- 지수 백오프: base*2^attempt, 상한 max ---
check("attempt0 = base(1000)", computeReconnectDelay(0, noJitter) === 1000);
check("attempt1 = 2000", computeReconnectDelay(1, noJitter) === 2000);
check("attempt2 = 4000", computeReconnectDelay(2, noJitter) === 4000);
check("attempt3 = 8000", computeReconnectDelay(3, noJitter) === 8000);
check("attempt4 = 16000", computeReconnectDelay(4, noJitter) === 16000);
check("attempt5 = 30000(cap)", computeReconnectDelay(5, noJitter) === 30000);
check("attempt10 = 30000(cap 유지)", computeReconnectDelay(10, noJitter) === 30000);

// --- circuit breaker: 대량 attempt 에도 Infinity/오버플로우 없이 max 고정 ---
check("attempt31 = max(overflow 방지)", computeReconnectDelay(31, noJitter) === 30000);
check("attempt1e6 = max(overflow 방지)", computeReconnectDelay(1_000_000, noJitter) === 30000);
check("attempt31 유한값", Number.isFinite(computeReconnectDelay(31, { random: () => 0.9 })));

// --- 방어: 음수/NaN/소수 attempt → 0 취급 ---
check("attempt -1 → base", computeReconnectDelay(-1, noJitter) === 1000);
check("attempt NaN → base", computeReconnectDelay(NaN, noJitter) === 1000);
check("attempt 2.9 → floor(2)=4000", computeReconnectDelay(2.9, noJitter) === 4000);

// --- jitter: [0, jitterMs) 범위, 결정적 주입 ---
check("jitter random=0 → +0", computeReconnectDelay(0, { random: () => 0 }) === 1000);
check("jitter random≈1 → base+거의jitter", computeReconnectDelay(0, { random: () => 0.999, jitterMs: 1000 }) === 1000 + 999);
check("jitter 폭 옵션 반영", computeReconnectDelay(0, { random: () => 0.5, jitterMs: 2000 }) === 1000 + 1000);

// --- 고정 1초와의 차이(storm 완화 실증): 5회 연속 실패 누적 대기 ---
// 구(고정 1s): 5회 = 5000ms. 신(백오프, no jitter): 1000+2000+4000+8000+16000 = 31000ms.
const oldTotal = 1000 * 5;
let newTotal = 0;
for (let a = 0; a < 5; a++) newTotal += computeReconnectDelay(a, noJitter);
check("백오프가 고정 1초 대비 재시도 빈도를 크게 낮춘다", newTotal > oldTotal * 5);

// --- visibility 복귀 시 재구독 판정 ---
// 정상 채널(subscribed) → 재구독 안 함(join storm 차단). backfill 은 별개로 항상 수행.
check("정상 채널 복귀 → 재구독 X", shouldResubscribeOnVisible(true, false) === false);
check("정상 채널 + 예약 있음 → 재구독 X", shouldResubscribeOnVisible(true, true) === false);
// dead 채널 → 재구독 O(예약 없을 때만)
check("dead 채널 + 예약 없음 → 재구독 O", shouldResubscribeOnVisible(false, false) === true);
check("dead 채널 + 예약 있음 → 재구독 X(중복 예약 방지)", shouldResubscribeOnVisible(false, true) === false);
check("joining 채널 + 예약 없음 → 재구독 X", shouldResubscribeOnVisible(false, false, true) === false);

// --- baseMs:0(사용자 복귀 즉시성) → [0, jitter) 즉시 재구독 ---
check("visible 재구독은 base0 → 즉시(≈0)", computeReconnectDelay(0, { baseMs: 0, random: () => 0 }) === 0);
check("visible 재구독 base0 + jitter 상한 내", computeReconnectDelay(0, { baseMs: 0, random: () => 0.999, jitterMs: 1000 }) === 999);

// --- 실제 channel identity/generation + remove→subscribe 직렬화 수명 회귀 ---
async function runLifecycleRegression() {
  type FakeChannel = { id: string };
  type Timer = { callback: () => void | Promise<void>; cleared: boolean; fired: boolean };
  const channels: FakeChannel[] = [];
  const statusCallbacks = new Map<string, (status: "SUBSCRIBED" | "CHANNEL_ERROR" | "TIMED_OUT" | "CLOSED") => void>();
  const timers: Timer[] = [];
  const removed: string[] = [];
  let resolveRemoveA!: () => void;
  const removeA = new Promise<void>((resolve) => { resolveRemoveA = resolve; });
  let backfills = 0;
  const lifecycle = createRealtimeChannelLifecycle<FakeChannel, Timer>({
    createChannel: () => {
      const channel = { id: String.fromCharCode(65 + channels.length) };
      channels.push(channel);
      return channel;
    },
    subscribeChannel: (channel, onStatus) => statusCallbacks.set(channel.id, onStatus),
    removeChannel: async (channel) => {
      removed.push(channel.id);
      if (channel.id === "A") await removeA;
    },
    onSubscribed: () => { backfills += 1; },
    onVisible: () => { backfills += 1; },
    setTimer: (callback) => {
      const timer: Timer = {
        callback: async () => {
          timer.fired = true;
          await callback();
        },
        cleared: false,
        fired: false,
      };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { timer.cleared = true; },
    reconnectDelay: () => 0,
    visibleReconnectDelay: () => 0,
  });

  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  const pendingTimers = () => timers.filter((timer) => !timer.cleared && !timer.fired);

  lifecycle.start();
  check("초기 A는 joining", lifecycle.snapshot().channel?.id === "A" && lifecycle.snapshot().state === "joining");
  lifecycle.visible();
  check("initial joining visibility는 교체 timer 0", pendingTimers().length === 0);

  // P0: terminal 즉시 A 제거 시작(내장 rejoin owner off). B/timer 아직 없음.
  statusCallbacks.get("A")?.("CHANNEL_ERROR");
  await flush();
  check("A error 즉시 제거 시작(앱 delay timer 기다리지 않음)", removed.join(",") === "A");
  check("A 제거 중 B 미생성", channels.length === 1);
  check("A 제거 중 subscribe timer 없음", pendingTimers().length === 0);

  // 제거 진행 중 old A 후속 terminal 은 fence 되어 무시(추가 제거/timer 0).
  statusCallbacks.get("A")?.("CLOSED");
  await flush();
  check("제거 중 A CLOSED 무시", removed.join(",") === "A" && pendingTimers().length === 0);

  // 제거 성공 → 이제서야 subscribe timer 예약, 만료 전에는 B 미생성.
  resolveRemoveA();
  await flush();
  const subscribeTimer = pendingTimers()[0];
  check("A 제거 성공 뒤 subscribe timer 예약", subscribeTimer != null);
  check("subscribe timer 만료 전 B 미생성", channels.length === 1);
  await subscribeTimer?.callback();
  check("subscribe timer 만료 뒤에만 B 생성", channels.map((channel) => channel.id).join(",") === "A,B");

  statusCallbacks.get("B")?.("SUBSCRIBED");
  statusCallbacks.get("A")?.("CLOSED");
  check("late A CLOSED 뒤 B subscribed 유지", lifecycle.snapshot().channel?.id === "B" && lifecycle.snapshot().state === "subscribed");
  check("late A CLOSED 뒤 timer 0", lifecycle.snapshot().reconnectPending === false);
  check("healthy B 미제거", removed.includes("B") === false);

  // B terminal 도 즉시 제거 진행 → attempt 1 증가, 후속 CLOSED 는 fence.
  statusCallbacks.get("B")?.("CHANNEL_ERROR");
  check("current B error 즉시 제거 진행", lifecycle.snapshot().reconnectPending === true);
  statusCallbacks.get("B")?.("CLOSED");
  await flush();
  check("같은 B 후속 CLOSED는 attempt 증가 없음", lifecycle.snapshot().reconnectAttempts === 1);
  check("B subscribed backfill 1회", backfills === 2);
  lifecycle.stop();
}

async function runActualRealtimeClientRegression() {
  type Timer = { callback: () => Promise<void>; fired: boolean; cleared: boolean };
  // _trigger / rejoinTimer 는 realtime-js 내부 API(공개 타입 미노출) — 실제 내장 rejoin owner 관찰용.
  type InternalChannel = RealtimeChannel & {
    _trigger: (type: string, payload?: unknown, ref?: string) => void;
    rejoinTimer: { timer: ReturnType<typeof setTimeout> | undefined };
  };
  const client = new RealtimeClient("ws://127.0.0.1:65535/socket", {
    params: { apikey: "pr950-test" },
    timeout: 1000,
  });
  const statusCallbacks = new Map<RealtimeChannel, (status: RealtimeLifecycleStatus) => void>();
  const timers: Timer[] = [];
  let removeAttempts = 0;

  const manager = createRealtimeChannelLifecycle<RealtimeChannel, Timer>({
    createChannel: () => client.channel("chat:pr950"),
    // 실제 Supabase 내장 rejoin 머신(rejoinTimer)을 켜기 위해 진짜 channel.subscribe() 호출.
    subscribeChannel: (channel, onStatus) => {
      statusCallbacks.set(channel, onStatus);
      channel.subscribe(onStatus);
    },
    removeChannel: async (channel) => {
      removeAttempts += 1;
      if (removeAttempts === 1) {
        // 첫 제거 실패 시뮬레이션 → B 없이 제거만 재시도(fail-closed). unsubscribe 를 우회하므로
        // 내장 rejoinTimer 는 reset 되지 않는다(아직 owner off 아님).
        const unsubscribe = channel.unsubscribe.bind(channel);
        channel.unsubscribe = async () => "error";
        const result = await client.removeChannel(channel);
        channel.unsubscribe = unsubscribe;
        return result;
      }
      // 두 번째 제거는 실제 unsubscribe → rejoinTimer.reset() + client 에서 제거.
      return client.removeChannel(channel);
    },
    isRemovalSuccessful: (result) => result === "ok" || result === "timed out",
    onSubscribed: () => {},
    onVisible: () => {},
    setTimer: (callback) => {
      const timer: Timer = {
        callback: async () => {
          timer.fired = true;
          await callback();
        },
        fired: false,
        cleared: false,
      };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { timer.cleared = true; },
    reconnectDelay: () => 0,
  });

  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  const nextTimer = () => timers.find((timer) => !timer.fired && !timer.cleared);

  manager.start();
  const channelA = manager.snapshot().channel as InternalChannel | null;
  check("actual client A 최초 tracked", channelA != null && client.getChannels().includes(channelA));
  if (!channelA) throw new Error("actual RealtimeClient A missing");

  // 실제 subscribe 로 켜진 내장 rejoin owner 를, 실제 phx_error 로 동기 발동.
  channelA._trigger("phx_error", "pr950-injected");
  check("actual phx_error 로 내장 rejoin owner 켜짐", channelA.rejoinTimer.timer !== undefined);
  await flush();
  // P0: error 직후 즉시 제거 시도(앱 delay timer 를 먼저 기다리지 않음).
  check("actual A error 직후 즉시 제거 시도", removeAttempts === 1);
  check("actual 첫 제거 실패면 B 미생성", manager.snapshot().channel == null);
  check("actual 첫 제거 실패면 A tracked 유지", client.getChannels().length === 1 && client.getChannels()[0] === channelA);
  check("actual 첫 제거 실패면 제거 재시도 예약", manager.snapshot().reconnectPending === true);

  // 재시도 timer 만료 → 실제 removeChannel 성공 → 내장 rejoin owner off + A untracked.
  await nextTimer()?.callback();
  await flush();
  check("actual 제거 성공 뒤 A untracked", client.getChannels().includes(channelA) === false);
  check("actual 제거 성공 뒤 내장 rejoin owner off", channelA.rejoinTimer.timer === undefined);
  // 제거 성공 뒤에도 subscribe 는 backoff timer 로만 — 아직 B 없음.
  check("actual 제거 성공 뒤 subscribe timer 예약", nextTimer() != null);
  check("actual subscribe timer 만료 전 B 미생성", manager.snapshot().channel == null);

  await nextTimer()?.callback();
  const channelB = manager.snapshot().channel;
  check("actual subscribe timer 만료 뒤에만 B 생성", channelB != null && channelB !== channelA);
  check("actual client 에는 B만 tracked", channelB != null && client.getChannels().length === 1 && client.getChannels()[0] === channelB);

  if (!channelB) throw new Error("actual RealtimeClient B missing");
  statusCallbacks.get(channelB)?.("SUBSCRIBED");
  // old A generation 의 late terminal 은 fence 되어 healthy B 를 건드리지 않는다.
  statusCallbacks.get(channelA)?.("CLOSED");
  check("actual late A CLOSED 뒤 manager B 유지", manager.snapshot().channel === channelB && manager.snapshot().state === "subscribed");
  check("actual late A CLOSED 뒤 client B tracked", client.getChannels().length === 1 && client.getChannels()[0] === channelB);
  check("actual late A CLOSED 뒤 timer 0", manager.snapshot().reconnectPending === false);
  manager.stop();
  await flush();
  client.disconnect();
}

Promise.all([runLifecycleRegression(), runActualRealtimeClientRegression()])
  .then(() => {
    console.log(`\nrealtime-reconnect: ${pass}/${pass + fail} pass${fail ? `, ${fail} FAIL` : ""}`);
    // 실제 RealtimeClient 소켓/재연결 timer 가 event loop 를 붙잡을 수 있어 명시적으로 종료.
    process.exit(fail ? 1 : 0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
