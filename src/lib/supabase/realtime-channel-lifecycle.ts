import { computeReconnectDelay, shouldResubscribeOnVisible } from "./realtime-reconnect";

export type RealtimeLifecycleStatus =
  | "SUBSCRIBED"
  | "CHANNEL_ERROR"
  | "TIMED_OUT"
  | "CLOSED";

type ConnectionState = "joining" | "subscribed" | "dead";
type ReconnectAction = "subscribe" | "remove";

export interface RealtimeChannelLifecycleOptions<Channel, TimerHandle> {
  createChannel: () => Channel;
  subscribeChannel: (
    channel: Channel,
    onStatus: (status: RealtimeLifecycleStatus) => void,
  ) => void;
  removeChannel: (channel: Channel) => Promise<unknown>;
  isRemovalSuccessful?: (result: unknown) => boolean;
  onSubscribed: () => void;
  onVisible: () => void;
  setTimer: (callback: () => void | Promise<void>, delay: number) => TimerHandle;
  clearTimer: (handle: TimerHandle) => void;
  reconnectDelay?: (attempt: number) => number;
  visibleReconnectDelay?: () => number;
}

/**
 * Realtime 채널 하나의 수명과 재연결을 소유한다.
 *
 * 재구독 폭주(양의 피드백) 차단 계약:
 * - terminal status(CHANNEL_ERROR/TIMED_OUT/CLOSED)가 오면 current generation을 즉시 fence하고
 *   old 채널을 *즉시* 제거해 Supabase 내장 rejoinTimer(중복 owner)를 끈다.
 *   (앱 backoff timer가 만료될 때까지 기다리지 않는다.)
 * - 제거가 성공하면 앱 backoff 만료 뒤에만 new 채널(B)을 subscribe 한다.
 * - 제거가 실패(error/throw)하면 B 없이 제거 자체만 backoff 로 재시도한다.
 * - 이전 generation callback 은 무시한다.
 */
export function createRealtimeChannelLifecycle<Channel, TimerHandle>(
  options: RealtimeChannelLifecycleOptions<Channel, TimerHandle>,
) {
  let current:
    | { channel: Channel; generation: number; state: ConnectionState }
    | null = null;
  let generation = 0;
  let reconnectAttempts = 0;
  let reconnectTimer: TimerHandle | null = null;
  let pendingRemoval: Channel | null = null;
  let removing = false;
  let cancelled = false;

  const clearReconnectTimer = () => {
    if (reconnectTimer == null) return;
    options.clearTimer(reconnectTimer);
    reconnectTimer = null;
  };

  const backoffDelay = () => {
    const delay =
      options.reconnectDelay?.(reconnectAttempts) ??
      computeReconnectDelay(reconnectAttempts);
    reconnectAttempts += 1;
    return delay;
  };

  const subscribe = () => {
    if (cancelled) return;
    const channel = options.createChannel();
    const capturedGeneration = ++generation;
    current = { channel, generation: capturedGeneration, state: "joining" };
    options.subscribeChannel(channel, (status) => {
      if (
        cancelled ||
        current?.channel !== channel ||
        current.generation !== capturedGeneration
      ) {
        return;
      }
      if (status === "SUBSCRIBED") {
        current.state = "subscribed";
        reconnectAttempts = 0;
        clearReconnectTimer();
        options.onSubscribed();
        return;
      }
      // terminal status → old 채널을 *즉시* 제거해 내장 rejoin owner 를 끈다.
      current.state = "dead";
      if (removing || reconnectTimer != null) return;
      void removeCurrentThenReconnect();
    });
  };

  /**
   * current(또는 pendingRemoval) 채널을 즉시 fence + 제거한다.
   * - 제거 성공: 앱 backoff 만료 뒤 subscribe(B) 예약.
   * - 제거 실패: B 없이 제거만 backoff 재시도.
   * @param immediateResubscribe visibility 복귀처럼 즉시성이 필요할 때 subscribe 지연을 0 근처로.
   */
  const removeCurrentThenReconnect = async (immediateResubscribe = false) => {
    if (cancelled || removing) return;
    removing = true;
    // fence: 이후 old 채널 callback 은 무시된다.
    let old: Channel | null = null;
    if (current) {
      old = current.channel;
      pendingRemoval = current.channel;
      current = null;
      generation += 1;
    } else if (pendingRemoval) {
      old = pendingRemoval;
    }
    let removed = true;
    if (old) {
      let result: unknown;
      try {
        result = await options.removeChannel(old);
      } catch {
        result = "error";
      }
      removed = options.isRemovalSuccessful?.(result) ?? result !== "error";
    }
    removing = false;
    if (cancelled) return;
    if (removed) {
      pendingRemoval = null;
      const delay = immediateResubscribe
        ? options.visibleReconnectDelay?.() ??
          computeReconnectDelay(0, { baseMs: 0 })
        : backoffDelay();
      // 제거 성공 → 앱 backoff 만료 뒤에만 B 생성.
      scheduleReconnect(delay, "subscribe");
    } else {
      // 제거 실패 → B 없이 제거만 backoff 재시도.
      scheduleReconnect(backoffDelay(), "remove");
    }
  };

  const scheduleReconnect = (delay: number, action: ReconnectAction) => {
    if (cancelled || reconnectTimer != null || removing) return;
    reconnectTimer = options.setTimer(async () => {
      reconnectTimer = null;
      if (action === "subscribe") {
        subscribe();
      } else {
        await removeCurrentThenReconnect();
      }
    }, delay);
  };

  return {
    start() {
      subscribe();
    },
    visible() {
      if (cancelled) return;
      options.onVisible();
      const activeChannel =
        current?.state === "joining" || current?.state === "subscribed";
      if (
        shouldResubscribeOnVisible(
          current?.state === "subscribed",
          reconnectTimer != null || removing,
          activeChannel,
        )
      ) {
        reconnectAttempts = 0;
        // dead 채널을 즉시 제거하고, 제거 뒤 B 를 (즉시성 있게) 생성한다.
        void removeCurrentThenReconnect(true);
      }
    },
    stop() {
      if (cancelled) return;
      cancelled = true;
      generation += 1;
      clearReconnectTimer();
      const old = current;
      current = null;
      if (old) void options.removeChannel(old.channel);
      if (pendingRemoval && pendingRemoval !== old?.channel) {
        void options.removeChannel(pendingRemoval);
      }
      pendingRemoval = null;
    },
    snapshot() {
      return {
        channel: current?.channel ?? null,
        state: current?.state ?? null,
        reconnectAttempts,
        reconnectPending: reconnectTimer != null || removing,
        removalPending: pendingRemoval,
      };
    },
  };
}
