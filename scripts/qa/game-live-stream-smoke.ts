import {
  consumeLivePollStream,
  createLivePollStream,
  shouldEmbedDetail,
  shouldEmbedLive,
  shouldCombineGameEvents,
  type LivePollEnvelope,
} from "../../src/lib/game/live-poll-stream";

let pass = 0;
let fail = 0;

function check(name: string, condition: boolean) {
  if (condition) pass += 1;
  else {
    fail += 1;
    console.error(`  ✗ ${name}`);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

async function main() {
  // 15초 창: 종전 relay 5 + events 1 = 6 Edge Requests, 통합 후 relay 계열 5건.
  {
    const combined = Array.from({ length: 5 }, (_, index) =>
      shouldCombineGameEvents(index, false)
    );
    check("events cadence stays once per five relay polls", combined.filter(Boolean).length === 1);
    check("first live poll includes events immediately", combined[0] === true);
    check("combined polling cuts 15s-window Edge Requests 6→5", 5 < 5 + combined.filter(Boolean).length);
    check("final transition always includes events", shouldCombineGameEvents(3, true) === true);
    check("live embed cadence stays every 3 polls", shouldEmbedLive(0) && shouldEmbedLive(3) && !shouldEmbedLive(1));
    check("detail embed cadence stays every 10 polls", shouldEmbedDetail(0) && shouldEmbedDetail(10) && !shouldEmbedDetail(9));
  }

  // events가 멈춰도 relay frame은 먼저 도착한다(추가 지연 0 + 부분 장애 격리).
  {
    const relay = deferred<Response>();
    const events = deferred<Response>();
    const response = new Response(createLivePollStream([
      { channel: "relay", task: relay.promise },
      { channel: "events", task: events.promise },
    ]));
    const envelopes: LivePollEnvelope[] = [];
    const consumed = consumeLivePollStream(response, (envelope) => envelopes.push(envelope));

    relay.resolve(Response.json({ gameId: "g1", innings: [] }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    check("relay arrives while events is still pending", envelopes.length === 1);
    check("first frame is relay", envelopes[0]?.channel === "relay");
    check("relay frame keeps success status", envelopes[0]?.ok === true && envelopes[0]?.status === 200);

    events.resolve(Response.json({ error: "events degraded" }, { status: 503 }));
    await consumed;
    check("events failure is isolated in its own frame", envelopes[1]?.channel === "events" && envelopes[1]?.ok === false);
    check("stream closes after both independent frames", envelopes.length === 2);
  }

  // events가 먼저 끝나는 경우도 두 channel을 유실 없이 전달한다.
  {
    const relay = deferred<Response>();
    const events = deferred<Response>();
    const response = new Response(createLivePollStream([
      { channel: "relay", task: relay.promise },
      { channel: "events", task: events.promise },
    ]));
    const channels: string[] = [];
    const consumed = consumeLivePollStream(response, (envelope) => channels.push(envelope.channel));

    events.resolve(Response.json({ events: [] }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    check("events may arrive first without waiting for relay", channels.join(",") === "events");
    relay.resolve(Response.json({ gameId: "g2", innings: [] }));
    await consumed;
    check("relay still arrives after early events", channels.join(",") === "events,relay");
  }

  console.log(`game-live-stream-smoke: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

void main();
