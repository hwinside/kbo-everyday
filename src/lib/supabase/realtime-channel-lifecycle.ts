import { computeReconnectDelay, shouldResubscribeOnVisible } from "./realtime-reconnect";

export type RealtimeLifecycleStatus =
  | "SUBSCRIBED"
  | "CHANNEL_ERROR"
  | "TIMED_OUT"
  | "CLOSED";

type ConnectionState = "joining" | "subscribed" | "dead";

export interface RealtimeChannelLifecycleOptions<Channel, TimerHandle> {
  createChannel: () => Channel;
  subscribeChannel: (
    channel: Channel,
    onStatus: (status: RealtimeLifecycleStatus) => void,
  ) => void;
  removeChannel: (channel: Channel) => Promise<unknown>;
  onSubscribed: () => void;
  onVisible: () => void;
  setTimer: (callback: () => void | Promise<void>, delay: number) => TimerHandle;
  clearTimer: (handle: TimerHandle) => void;
  reconnectDelay?: (attempt: number) => number;
  visibleReconnectDelay?: () => number;
}

/**
 * Realtime 채널 하나의 수명과 재연결을 소유한다.
 * 이전 generation callback은 무시하고, old remove가 끝난 뒤에만 new subscribe를 시작한다.
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
  let replacing = false;
  let cancelled = false;

  const clearReconnectTimer = () => {
    if (reconnectTimer == null) return;
    options.clearTimer(reconnectTimer);
    reconnectTimer = null;
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
      current.state = "dead";
      if (reconnectTimer != null || replacing) return;
      const delay =
        options.reconnectDelay?.(reconnectAttempts) ??
        computeReconnectDelay(reconnectAttempts);
      reconnectAttempts += 1;
      scheduleReconnect(delay);
    });
  };

  const replaceChannel = async () => {
    if (cancelled || replacing) return;
    replacing = true;
    const old = current;
    current = null;
    generation += 1;
    try {
      if (old) await options.removeChannel(old.channel);
      if (!cancelled) {
        replacing = false;
        subscribe();
      }
    } finally {
      replacing = false;
    }
  };

  const scheduleReconnect = (delay: number) => {
    if (cancelled || reconnectTimer != null || replacing) return;
    reconnectTimer = options.setTimer(async () => {
      reconnectTimer = null;
      await replaceChannel();
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
          reconnectTimer != null || replacing,
          activeChannel,
        )
      ) {
        reconnectAttempts = 0;
        scheduleReconnect(
          options.visibleReconnectDelay?.() ??
            computeReconnectDelay(0, { baseMs: 0 }),
        );
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
    },
    snapshot() {
      return {
        channel: current?.channel ?? null,
        state: current?.state ?? null,
        reconnectAttempts,
        reconnectPending: reconnectTimer != null || replacing,
      };
    },
  };
}
