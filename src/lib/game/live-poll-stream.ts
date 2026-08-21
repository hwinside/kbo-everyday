export type LivePollChannel = "relay" | "events" | "live" | "detail";

export interface LivePollEnvelope {
  channel: LivePollChannel;
  ok: boolean;
  status: number;
  data: unknown;
}

export const EVENTS_REFRESH_EVERY = 5;

/** 3초 relay cadence에서 첫 poll과 매 5번째(15초) poll을 events 통합 요청으로 고른다. */
export function shouldCombineGameEvents(
  pollIndex: number,
  isFinal: boolean,
): boolean {
  return isFinal || pollIndex % EVENTS_REFRESH_EVERY === 0;
}

/**
 * 3초 그리드에서는 10초를 정확히 찍을 수 없으므로, 60초 창 총량 6회를 보존한다.
 * 식: (pollIndex * intervalMs) % 10_000 < intervalMs
 * 3초 cadence면 0,4,7,10,14,17,20... 번째 poll이 선택되어 개별 간격은 9~12초다.
 */
export function shouldEmbedLive(pollIndex: number, intervalMs: number): boolean {
  return ((pollIndex * intervalMs) % 10_000) < intervalMs;
}

/**
 * detail은 30초 cadence를 그대로 유지한다.
 * 식: (pollIndex * intervalMs) % 30_000 < intervalMs
 */
export function shouldEmbedDetail(pollIndex: number, intervalMs: number): boolean {
  return ((pollIndex * intervalMs) % 30_000) < intervalMs;
}

const encoder = new TextEncoder();

async function responseEnvelope(
  channel: LivePollChannel,
  task: Promise<Response>,
): Promise<LivePollEnvelope> {
  try {
    const response = await task;
    let data: unknown = null;
    try {
      data = await response.json();
    } catch {
      data = { error: `${channel}_invalid_json` };
    }
    return {
      channel,
      ok: response.ok,
      status: response.status,
      data,
    };
  } catch (error) {
    return {
      channel,
      ok: false,
      status: 503,
      data: {
        error: error instanceof Error ? error.message : `${channel}_failed`,
      },
    };
  }
}

/**
 * relay/events를 한 HTTP 응답으로 multiplex한다.
 *
 * 각 작업이 끝나는 즉시 독립 NDJSON frame을 내보내므로 느리거나 실패한 events가
 * relay frame 전달을 막지 않는다. 두 작업은 호출자가 이미 동시에 시작한 Promise다.
 */
export function createLivePollStream(
  tasks: Array<{ channel: LivePollChannel; task: Promise<Response> }>,
): ReadableStream<Uint8Array> {
  let open = tasks.length;
  let cancelled = false;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const send = async (
        channel: LivePollChannel,
        task: Promise<Response>,
      ) => {
        const envelope = await responseEnvelope(channel, task);
        if (!cancelled) {
          controller.enqueue(encoder.encode(`${JSON.stringify(envelope)}\n`));
        }
        open -= 1;
        if (open === 0 && !cancelled) controller.close();
      };
      for (const { channel, task } of tasks) {
        void send(channel, task);
      }
    },
    cancel() {
      cancelled = true;
    },
  });
}

/** 브라우저에서 NDJSON frame을 도착 순서대로 소비한다. */
export async function consumeLivePollStream(
  response: Response,
  onEnvelope: (envelope: LivePollEnvelope) => void,
): Promise<void> {
  if (!response.body) throw new Error("game_live_stream_missing_body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });

    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) onEnvelope(JSON.parse(line) as LivePollEnvelope);
      newline = buffer.indexOf("\n");
    }

    if (done) break;
  }

  const tail = buffer.trim();
  if (tail) onEnvelope(JSON.parse(tail) as LivePollEnvelope);
}
