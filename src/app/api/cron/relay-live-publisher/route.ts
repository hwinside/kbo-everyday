import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { GET as getRelay } from "@/app/api/game-relay/route";
import { GET as getEvents } from "@/app/api/game-events/route";
import { GET as getLive } from "@/app/api/game-live/route";
import { GET as getDetail } from "@/app/api/game-detail/route";
import { resolveGameLiveDate } from "@/lib/game-live-date";
import {
  deserializeState,
  listLiveGameIds,
  publishGameTick,
  serializeState,
  stateKey,
  STATE_TTL_SECONDS,
  TICK_INTERVAL_MS,
  type FrameRow,
  type PersistedGameState,
  type TickResult,
} from "@/lib/game/relay-live-publisher";

const CRON_SECRET = process.env.CRON_SECRET || "";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 크관 relay Realtime 퍼블리셔 cron (1분 주기 · B안 v2, 2026-08-25 삼순 NO-GO 반영).
 *
 * 1분 인보케이션 안에서 3초 tick 루프(~50초)를 돌며 라이브 경기의 relay/events/
 * live/detail 프레임을 `game_relay_frames` 에 쓴다(content-only: 무변경 tick 발행 0).
 * 클라이언트는 postgres_changes 구독으로 받아 3초 Vercel 폴링을 watchdog(30~60초)로
 * 낮춘다(폴링은 폴백으로 유지).
 *
 * 단일 실행 (P1 반영): Upstash `SET NX PX` 로 토큰 락을 잡고, loop 중간마다 **소유
 * 토큰이 여전히 내 것일 때만** PEXPIRE 로 renew 한다. 인보케이션 종료 시 Lua
 * compare-delete 로 **내 토큰일 때만** 해제해, 만료 후 다른 인보케이션이 잡은 락을
 * 실수로 지우지 않는다. Redis 미설정/락 실패는 **fail-close**(발행 안 함) — 다중
 * writer 로 인한 중복·seq 충돌을 원천 차단한다.
 *
 * 상태 지속 (P1 반영): 채널별 lastHash·seq·relayChanges 를 인보케이션 시작에
 * Redis 에서 로드하고 종료에 저장한다. cron 경계를 넘어 hash 가 유지되므로
 * 무변경 tick 은 매분 재발행되지 않는다.
 *
 * 실패 계약: 스케줄 조회 실패 등 구조적 실패는 5xx(cron 실패 집계 노출).
 * 개별 경기·채널 실패는 결과에 집계하고 나머지를 계속한다. 이 cron 이 통째로
 * 죽어도 클라이언트는 기존 폴링 폴백으로 동작한다(가용성 회귀 없음).
 */

const LOCK_KEY = "kbo:relay:publisher:lock:v1";
const LOCK_TTL_MS = 20_000;
const LOCK_RENEW_EVERY_MS = 8_000;
const LOOP_BUDGET_MS = 50_000;
// 단일 tick(모든 라이브 경기 채널)의 handler 상한. 업스트림 hang 이 이 값을 넘으면
// tick 을 실패 집계로 끊어 loop 가 TTL·maxDuration 을 넘기지 않게 한다(삼순 3차 lease).
const TICK_TIMEOUT_MS = 15_000;
const FRAME_RETENTION_HOURS = 24;

function redisConfig(): { url: string; token: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL?.replace(/\/+$/, "");
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}

async function redisCommand(args: Array<string | number>): Promise<unknown | null> {
  const cfg = redisConfig();
  if (!cfg) return null;
  try {
    const response = await fetch(cfg.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
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

/** 토큰 락 획득. 성공 시 토큰 문자열, 실패 시 null. */
async function acquireLock(token: string): Promise<boolean> {
  const result = await redisCommand(["SET", LOCK_KEY, token, "NX", "PX", LOCK_TTL_MS]);
  return result === "OK";
}

/**
 * 내 토큰일 때만 TTL 연장. 연장 성공 시 true. 토큰 불일치(다른 writer 가 잡음)·
 * 키 소멸·Redis 오류는 false — 호출자는 즉시 중단해야 한다(삼순 2차 P1 lease).
 */
async function renewLock(token: string): Promise<boolean> {
  // GET 후 일치 시 PEXPIRE — Upstash EVAL 로 원자화. 성공 시 pexpire 가 1 반환.
  const result = await redisCommand([
    "EVAL",
    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end",
    "1",
    LOCK_KEY,
    token,
    LOCK_TTL_MS,
  ]);
  return result === 1;
}

/** 내 토큰일 때만 해제(compare-delete). */
async function releaseLock(token: string): Promise<void> {
  await redisCommand([
    "EVAL",
    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
    "1",
    LOCK_KEY,
    token,
  ]);
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

  // P1: Redis 필수 — 락·상태 지속 없이는 다중 writer 중복이 나므로 fail-close.
  if (!redisConfig()) {
    return NextResponse.json({ error: "Redis 미설정 — 단일 writer 보장 불가(fail-close)" }, { status: 503 });
  }

  const token = randomUUID();
  const locked = await acquireLock(token);
  if (!locked) {
    return NextResponse.json({ skipped: true, reason: "lock-held" });
  }

  try {
    const supabase = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false } });
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
      return NextResponse.json({ ok: true, liveGames: 0, gc: gcError ? `error:${gcError.message}` : "ok" });
    }

    // 락 상실(독립 renewal 타이머가 감지) 후에는 INSERT·state 저장을 전부 중단한다
    // → old writer 가 새 owner 의 프레임/상태를 덮어쓰지 못하게 한다(삼순 3차 lease).
    let lockLost = false;
    const insertFrame = async (row: FrameRow): Promise<boolean> => {
      if (lockLost) return false;
      const { error } = await supabase.from("game_relay_frames").insert(row);
      return !error;
    };

    const deps = {
      handlers: { relay: getRelay, events: getEvents, live: getLive, detail: getDetail },
      insertFrame,
      date,
    };

    // 상태 로드 (cron 경계 지속) — 채널별 hash·seq 를 이어받아 무변경 재발행을 막는다.
    const states = new Map<string, PersistedGameState>();
    await Promise.all(
      gameIds.map(async (gameId) => {
        const raw = await redisCommand(["GET", stateKey(gameId)]);
        states.set(gameId, deserializeState(raw));
      }),
    );

    const totals = {
      inserted: 0,
      skippedUnchanged: 0,
      skippedOversize: 0,
      errors: [] as string[],
      ticks: 0,
    };
    const startedAt = Date.now();

    // 독립 renewal 타이머(삼순 3차 lease): tick 진행과 무관하게 LOCK_RENEW_EVERY_MS 마다
    // 내 토큰일 때만 TTL 을 연장한다. 실패(토큰 불일치·키 소멸·Redis 오류)면 lockLost 를
    // 올려 이후 INSERT·state 저장을 전부 막는다. 긴 tick·pre-loop 중 만료도 여기서 감지.
    let renewInFlight = false;
    const renewTimer = setInterval(() => {
      if (renewInFlight || lockLost) return;
      renewInFlight = true;
      renewLock(token)
        .then((ok) => { if (!ok) lockLost = true; })
        .catch(() => { lockLost = true; })
        .finally(() => { renewInFlight = false; });
    }, LOCK_RENEW_EVERY_MS);

    try {
      for (let tickIndex = 0; Date.now() - startedAt < LOOP_BUDGET_MS; tickIndex++) {
        const tickStartedAt = Date.now();
        if (lockLost) break; // 독립 타이머가 락 상실 감지 → 즉시 중단

        // handler timeout: 한 tick 이 TICK_TIMEOUT_MS 를 넘으면 실패 집계로 끊는다.
        // (insertFrame 은 lockLost 시 no-op 이라 늦게 끝난 tick 이 새 owner 를 못 덮는다.)
        const tickResults = await Promise.all(
          gameIds.map((gameId) =>
            Promise.race<TickResult>([
              publishGameTick(deps, states.get(gameId)!, gameId, tickIndex),
              new Promise<TickResult>((resolve) =>
                setTimeout(
                  () => resolve({ inserted: 0, skippedUnchanged: 0, skippedOversize: 0, errors: [`${gameId}:tick-timeout`] }),
                  TICK_TIMEOUT_MS,
                ),
              ),
            ]),
          ),
        );
        for (const r of tickResults) {
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
    } finally {
      clearInterval(renewTimer);
    }

    // 상태 저장 (다음 인보케이션이 이어받음). 저장 직전 소유권을 한 번 더 재확인해
    // 내 토큰일 때만 저장한다 — 새 writer 의 최신 state 를 stale 값으로 덮어쓰지 않기
    // 위함(삼순 3차 lease: 저장 직전 소유권 재확인).
    const stillOwner = !lockLost && (await renewLock(token));
    if (stillOwner) {
      await Promise.all(
        gameIds.map((gameId) =>
          redisCommand(["SET", stateKey(gameId), serializeState(states.get(gameId)!), "EX", STATE_TTL_SECONDS]),
        ),
      );
    } else {
      lockLost = true;
    }

    return NextResponse.json({
      ok: true,
      liveGames: gameIds.length,
      lockLost,
      gc: gcError ? `error:${gcError.message}` : "ok",
      ...totals,
      errors: totals.errors.slice(0, 20),
    });
  } finally {
    await releaseLock(token);
  }
}
