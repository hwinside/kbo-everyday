/**
 * Realtime 재연결 백오프/재구독 판정 순수 헬퍼 스모크.
 * 2026-07-28 재구독 폭주(양의 피드백) P0 회귀를 결정론으로 고정한다(dev-server 불필요).
 *
 * 실행: npx tsx scripts/qa/realtime-reconnect-smoke.ts
 */
import { computeReconnectDelay, shouldResubscribeOnVisible } from "../../src/lib/supabase/realtime-reconnect";
import { createRealtimeChannelLifecycle } from "../../src/lib/supabase/realtime-channel-lifecycle";
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

  lifecycle.start();
  check("초기 A는 joining", lifecycle.snapshot().channel?.id === "A" && lifecycle.snapshot().state === "joining");
  lifecycle.visible();
  check("initial joining visibility는 교체 timer 0", timers.filter((timer) => !timer.cleared && !timer.fired).length === 0);

  statusCallbacks.get("A")?.("CHANNEL_ERROR");
  const reconnectA = timers.find((timer) => !timer.cleared && !timer.fired);
  check("current A error만 재연결 예약", reconnectA != null);
  const replacingA = reconnectA?.callback();
  check("A 제거 완료 전 B subscribe 직렬 대기", channels.length === 1 && removed.join(",") === "A");

  statusCallbacks.get("A")?.("CLOSED");
  check("제거 중 A CLOSED는 추가 timer 0", timers.filter((timer) => !timer.cleared && !timer.fired).length === 0);
  resolveRemoveA();
  await replacingA;
  check("A 제거 후 B 생성", channels.map((channel) => channel.id).join(",") === "A,B");

  statusCallbacks.get("B")?.("SUBSCRIBED");
  statusCallbacks.get("A")?.("CLOSED");
  check("late A CLOSED 뒤 B subscribed 유지", lifecycle.snapshot().channel?.id === "B" && lifecycle.snapshot().state === "subscribed");
  check("late A CLOSED 뒤 timer 0", lifecycle.snapshot().reconnectPending === false);
  check("healthy B 미제거", removed.includes("B") === false);

  statusCallbacks.get("B")?.("CHANNEL_ERROR");
  check("current B error는 다음 백오프 예약", lifecycle.snapshot().reconnectPending === true);
  statusCallbacks.get("B")?.("CLOSED");
  check("같은 B 후속 CLOSED는 중복 예약/attempt 증가 없음", lifecycle.snapshot().reconnectAttempts === 1);
  check("B subscribed backfill 1회", backfills === 2);
  lifecycle.stop();
}

async function runActualRealtimeClientRegression() {
  type Timer = { callback: () => Promise<void>; fired: boolean; cleared: boolean };
  const client = new RealtimeClient("ws://127.0.0.1:65535/socket", {
    params: { apikey: "pr950-test" },
  });
  const statusCallbacks = new Map<
    RealtimeChannel,
    (status: "SUBSCRIBED" | "CHANNEL_ERROR" | "TIMED_OUT" | "CLOSED") => void
  >();
  const timers: Timer[] = [];
  let removeAttempts = 0;

  const manager = createRealtimeChannelLifecycle<RealtimeChannel, Timer>({
    createChannel: () => client.channel("chat:pr950"),
    subscribeChannel: (channel, onStatus) => statusCallbacks.set(channel, onStatus),
    removeChannel: async (channel) => {
      removeAttempts += 1;
      if (removeAttempts === 1) {
        const unsubscribe = channel.unsubscribe.bind(channel);
        channel.unsubscribe = async () => "error";
        const result = await client.removeChannel(channel);
        channel.unsubscribe = unsubscribe;
        return result;
      }
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

  const nextTimer = () => timers.find((timer) => !timer.fired && !timer.cleared);
  manager.start();
  const channelA = manager.snapshot().channel;
  check("actual client A 최초 tracked", channelA != null && client.getChannels().includes(channelA));

  if (!channelA) throw new Error("actual RealtimeClient A missing");
  statusCallbacks.get(channelA)?.("CHANNEL_ERROR");
  await nextTimer()?.callback();
  check("actual remove error면 B 생성 금지", manager.snapshot().channel == null);
  check("actual remove error면 A tracked 유지", client.getChannels().length === 1 && client.getChannels()[0] === channelA);
  check("actual remove error면 removal retry 예약", manager.snapshot().reconnectPending === true);

  await nextTimer()?.callback();
  const channelB = manager.snapshot().channel;
  check("actual remove 성공 뒤 B 생성", channelB != null && channelB !== channelA);
  check("actual client에는 B만 tracked", channelB != null && client.getChannels().length === 1 && client.getChannels()[0] === channelB);

  if (!channelB) throw new Error("actual RealtimeClient B missing");
  statusCallbacks.get(channelB)?.("SUBSCRIBED");
  statusCallbacks.get(channelA)?.("CLOSED");
  check("actual late A CLOSED 뒤 manager B 유지", manager.snapshot().channel === channelB && manager.snapshot().state === "subscribed");
  check("actual late A CLOSED 뒤 client B tracked", client.getChannels().length === 1 && client.getChannels()[0] === channelB);
  check("actual late A CLOSED 뒤 timer 0", manager.snapshot().reconnectPending === false);
  manager.stop();
}

Promise.all([runLifecycleRegression(), runActualRealtimeClientRegression()])
  .then(() => {
    console.log(`\nrealtime-reconnect: ${pass}/${pass + fail} pass${fail ? `, ${fail} FAIL` : ""}`);
    if (fail) process.exit(1);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
