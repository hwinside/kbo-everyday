import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { GET as getRelay } from "@/app/api/game-relay/route";
import { GET as getEvents } from "@/app/api/game-events/route";
import { GET as getLive } from "@/app/api/game-live/route";
import { GET as getDetail } from "@/app/api/game-detail/route";
import { resolveGameLiveDate } from "@/lib/game-live-date";
import {
  listLiveGameIds,
  newGameState,
  publishGameTick,
  TICK_INTERVAL_MS,
  type FrameRow,
  type PublisherGameState,
} from "@/lib/game/relay-live-publisher";

const CRON_SECRET = process.env.CRON_SECRET || "";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 크관 relay Realtime 퍼블리셔 cron (1분 주기 · B안, 2026-08-25).
 *
 * 1분 인보케이션 안에서 3초 tick 루프(~50초)를 돌며 라이브 경기의 relay/events/
 * live/detail 프레임을 `game_relay_frames` 에 쓴다. 클라이언트는 postgres_changes
 * 구독으로 받아 3초 Vercel 폴링을 대체한다(폴링 코드는 폴백으로 유지).
 *
 * 단일 실행 보장: Upstash `SET NX PX` 락. cron 재시도·중복 스케줄이 겹쳐도
 * 한 인보케이션만 발행한다. 락 획득 실패는 정상 종료(200 {skipped:true}) —
 * 이미 다른 인스턴스가 발행 중이라는 뜻이다.
 *
 * 라이브 경기 0 이면 즉시 종료(비라이브 시간대 비용 ≈ 0). GC(24h 초과 프레임
 * 삭제)는 라이브 경기 유무와 무관하게 인보케이션당 1회 수행한다.
 *
 * 실패 계약: 스케줄 조회 실패 등 구조적 실패는 5xx(cron 실패 집계 노출).
 * 개별 경기·채널 실패는 결과에 집계하고 나머지를 계속한다. 이 cron 이 통째로
 * 죽어도 클라이언트는 기존 폴링 폴백으로 동작한다(가용성 회귀 없음).
 */

const LOCK_KEY = "kbo:relay-live-publisher:lock:v1";
const LOCK_TTL_MS = 55_000;
const LOOP_BUDGET_MS = 50_000;
const FRAME_RETENTION_HOURS = 24;

async function redisCommand(args: Array<string | number>): Promise<unknown | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL?.replace(/\/+$/, "");
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
      cache: "no-store",
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { result?: unknown; error?: unknown };
    if (payload.error !== undefined || !("result" in payload)) return null;
    return payload.result;
  } catch {
    return null;
  }
}

/** true = 락 획득. Redis 미설정/실패면 락 없이 진행(발행 중복은 클라이언트 병합이 멱등). */
async function acquireLock(): Promise<boolean | "no-redis"> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  if (!url) return "no-redis";
  const result = await redisCommand(["SET", LOCK_KEY, String(Date.now()), "NX", "PX", LOCK_TTL_MS]);
  return result === "OK";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRole) {
    return NextResponse.json({ error: "Supabase env 미설정" }, { status: 503 });
  }
  const supabase = createClient(supabaseUrl, serviceRole, {
    auth: { persistSession: false },
  });

  const lock = await acquireLock();
  if (lock === false) {
    return NextResponse.json({ skipped: true, reason: "lock-held" });
  }

  const date = resolveGameLiveDate();

  // GC: 보존 창 밖 프레임 삭제 (인보케이션당 1회, 라이브 유무 무관)
  const gcCutoff = new Date(Date.now() - FRAME_RETENTION_HOURS * 3_600_000).toISOString();
  const { error: gcError } = await supabase
    .from("game_relay_frames")
    .delete()
    .lt("created_at", gcCutoff);

  let gameIds: string[];
  try {
    gameIds = await listLiveGameIds(date);
  } catch (e) {
    return NextResponse.json(
      { error: "live-games-fetch-failed", detail: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }

  if (gameIds.length === 0) {
    return NextResponse.json({
      ok: true,
      liveGames: 0,
      gc: gcError ? `error:${gcError.message}` : "ok",
    });
  }

  const insertFrame = async (row: FrameRow): Promise<boolean> => {
    const { error } = await supabase.from("game_relay_frames").insert(row);
    return !error;
  };

  const deps = {
    handlers: { relay: getRelay, events: getEvents, live: getLive, detail: getDetail },
    insertFrame,
    date,
  };

  const states = new Map<string, PublisherGameState>();
  for (const gameId of gameIds) states.set(gameId, newGameState());

  const totals = { inserted: 0, skippedUnchanged: 0, skippedOversize: 0, errors: [] as string[], ticks: 0 };
  const startedAt = Date.now();

  for (let tickIndex = 0; Date.now() - startedAt < LOOP_BUDGET_MS; tickIndex++) {
    const tickStartedAt = Date.now();
    const results = await Promise.all(
      gameIds.map((gameId) =>
        publishGameTick(deps, states.get(gameId)!, gameId, tickIndex),
      ),
    );
    for (const r of results) {
      totals.inserted += r.inserted;
      totals.skippedUnchanged += r.skippedUnchanged;
      totals.skippedOversize += r.skippedOversize;
      totals.errors.push(...r.errors);
    }
    totals.ticks += 1;

    const elapsed = Date.now() - tickStartedAt;
    const remaining = LOOP_BUDGET_MS - (Date.now() - startedAt);
    if (remaining <= TICK_INTERVAL_MS) break;
    if (elapsed < TICK_INTERVAL_MS) await sleep(TICK_INTERVAL_MS - elapsed);
  }

  return NextResponse.json({
    ok: true,
    liveGames: gameIds.length,
    lock: lock === "no-redis" ? "no-redis" : "acquired",
    gc: gcError ? `error:${gcError.message}` : "ok",
    ...totals,
    errors: totals.errors.slice(0, 20),
  });
}
