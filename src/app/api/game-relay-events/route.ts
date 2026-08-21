import { NextRequest, NextResponse } from "next/server";
import { GET as getRelay } from "@/app/api/game-relay/route";
import { GET as getEvents } from "@/app/api/game-events/route";
import { GET as getLive } from "@/app/api/game-live/route";
import { GET as getDetail } from "@/app/api/game-detail/route";
import { createLivePollStream } from "@/lib/game/live-poll-stream";

export const dynamic = "force-dynamic";

function internalRequest(req: NextRequest, pathname: string): NextRequest {
  const url = new URL(req.url);
  url.pathname = pathname;
  return new NextRequest(url, {
    headers: req.headers,
    signal: req.signal,
  });
}

function parseInclude(req: NextRequest): Set<"events" | "live" | "detail"> {
  const include = req.nextUrl.searchParams.get("include");
  const values = new Set<"events" | "live" | "detail">();
  if (!include) return values;
  for (const entry of include.split(",")) {
    const trimmed = entry.trim();
    if (trimmed === "events" || trimmed === "live" || trimmed === "detail") values.add(trimmed);
  }
  return values;
}

/**
 * 라이브 경기 화면의 relay + events 단일 Edge Request.
 *
 * 두 기존 route handler를 프로세스 내부에서 동시에 실행하고 NDJSON으로 먼저 끝난
 * 결과부터 보낸다. public self-fetch를 하지 않으므로 추가 Edge/Function invocation은
 * 없고, events 장애·지연도 relay frame 전달을 막지 않는다.
 */
export async function GET(req: NextRequest) {
  if (!req.nextUrl.searchParams.get("gameId")) {
    return NextResponse.json(
      { error: "gameId is required" },
      { status: 400 },
    );
  }

  const include = parseInclude(req);
  const rawInclude = req.nextUrl.searchParams.get("include");
  const tasks: Array<{ channel: "relay" | "events" | "live" | "detail"; task: Promise<Response> }> = [
    { channel: "relay", task: getRelay(internalRequest(req, "/api/game-relay")) },
  ];
  if (rawInclude === null || include.has("events")) {
    tasks.push({ channel: "events", task: getEvents(internalRequest(req, "/api/game-events")) });
  }
  if (include.has("live")) {
    tasks.push({ channel: "live", task: getLive(internalRequest(req, "/api/game-live")) });
  }
  if (include.has("detail")) {
    tasks.push({ channel: "detail", task: getDetail(internalRequest(req, "/api/game-detail")) });
  }
  const stream = createLivePollStream(tasks);

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "private, no-store, max-age=0",
    },
  });
}
