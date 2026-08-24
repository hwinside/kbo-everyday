import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { fetchNaverGames } from "@/lib/crawler/naver-games";
import { toDeltaResponse } from "@/lib/game/relay-delta";
import type { GameRelayResponse } from "@/app/api/game-relay/route";
import type { LivePollEnvelope } from "@/lib/game/live-poll-stream";

/**
 * 크관 relay Realtime 퍼블리셔 코어 (B안, 2026-08-25 · 삼순 NO-GO 반영 v2).
 *
 * 역할: 라이브 경기마다 기존 route handler(GET /api/game-relay 등)를 프로세스
 * 내부에서 호출해(공용 self-fetch 없음 — game-relay-events 와 동일 패턴) 결과를
 * `game_relay_frames` 테이블에 INSERT 한다. Supabase Realtime(postgres_changes)이
 * 구독 클라이언트에 전파하므로, 클라이언트 3초 폴링이 사라진다.
 *
 * 변경 감지 (P1 반영): 프레임은 **내용이 바뀐 tick 에만** 쓴다. 그리고 채널별
 * lastHash·seq·relayChanges 를 **Redis 에 지속**시켜 1분 cron 인보케이션 경계를
 * 넘어 재사용한다 — 예전엔 매 인보케이션 newGameState() 로 hash 가 0부터 리셋돼
 * 무변경이어도 첫 tick 의 4채널이 매분 재발행됐다(삼순 P1). 지속 상태로 그 재발행이
 * 0 이 된다.
 *
 * heartbeat (P0-2 반영): 억제 기준이 '마지막 내용변경 +10초' 였을 때는 투구 사이
 * 무변경이 10초를 넘으면 클라 폴링이 재개돼 절감 계약이 깨졌다. 이제 수집기는
 * 무변경이어도 HEARTBEAT_INTERVAL_MS 마다 경량 'heartbeat' 프레임을 발행한다.
 * 클라는 heartbeat 신선도로 '수집기 건강'을 알고 무변경 2분에도 poll=0 을 유지한다.
 * heartbeat payload 는 상수라 realtime 메시지 크기가 최소다.
 *
 * full/delta 계약: relay 는 기본 delta(toDeltaResponse — 폴링 경로와 동일 함수)로
 * 쓰고, ①이 경기의 첫 발행 ②FULL_EVERY 번째 변경마다 'relay-full' 을 쓴다.
 *
 * 크기 가드: payload 가 MAX_PAYLOAD_BYTES 를 넘으면 INSERT 를 건너뛴다
 * (postgres_changes max_record_bytes 초과 시 빈 payload 전파 fail-close).
 */

export const RELAY_FRAME_FULL_EVERY = 20;
export const MAX_PAYLOAD_BYTES = 250_000;
/** tick 간격(ms). 폴링 시절 클라이언트 cadence 와 동일. */
export const TICK_INTERVAL_MS = 3_000;
/** 무변경이어도 이 간격마다 heartbeat 프레임을 발행 → 클라 poll 억제 유지. */
export const HEARTBEAT_INTERVAL_MS = 10_000;
/** Redis 지속 상태 키 접두어 + TTL(라이브 종료 후 자연 소멸). */
export const STATE_KEY_PREFIX = "kbo:relay:publisher:state:v1:";
export const STATE_TTL_SECONDS = 6 * 3_600;

export type FrameKind = "relay-full" | "relay-delta" | "events" | "live" | "detail" | "heartbeat";

/**
 * Realtime 메시지 월 비용 적분 추정 (삼순 2차 P0 비용 게이트).
 * DB change 는 listener 1명당 1 메시지이므로 월 메시지 ≈
 *   (발행 프레임/분) × (평균 CCU) × (경기일 라이브 분/월) × (동시 경기 수).
 * canonical hash 로 무변경 tick 이 INSERT 0 이 되면 발행은 사실상 변경 프레임+
 * heartbeat(무변경 구간 6/분)만 남는다.
 */
export function estimateMonthlyRealtimeMessages(params: {
  framesPerMinutePerGame: number;
  avgConcurrentViewers: number;
  liveMinutesPerDayPerGame: number;
  gamesPerDay: number;
  daysPerMonth?: number;
}): number {
  const { framesPerMinutePerGame, avgConcurrentViewers, liveMinutesPerDayPerGame, gamesPerDay } = params;
  const days = params.daysPerMonth ?? 30;
  return (
    framesPerMinutePerGame *
    avgConcurrentViewers *
    liveMinutesPerDayPerGame *
    gamesPerDay *
    days
  );
}

export interface FrameRow {
  game_id: string;
  seq: number;
  kind: FrameKind;
  payload: LivePollEnvelope;
}

/** cron 인보케이션 경계를 넘어 Redis 에 지속되는 경기 상태. */
export interface PersistedGameState {
  /** 채널별 마지막 발행 해시 (relay 는 full 응답 기준) */
  lastHash: Record<string, string>;
  /** relay 변경 횟수 (FULL_EVERY 판정) */
  relayChanges: number;
  /** 경기 단위 frame seq (단조증가) */
  seq: number;
  /** relay-full 을 이미 한 번이라도 발행했는가 */
  publishedFull: boolean;
  /** 마지막으로 어떤 프레임(heartbeat 포함)이든 발행한 시각 */
  lastFrameAtMs: number;
}

export function newGameState(): PersistedGameState {
  return { lastHash: {}, relayChanges: 0, seq: 0, publishedFull: false, lastFrameAtMs: 0 };
}

export function serializeState(state: PersistedGameState): string {
  return JSON.stringify(state);
}

export function deserializeState(raw: unknown): PersistedGameState {
  if (typeof raw !== "string") return newGameState();
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedGameState>;
    return {
      lastHash: parsed.lastHash && typeof parsed.lastHash === "object" ? parsed.lastHash : {},
      relayChanges: typeof parsed.relayChanges === "number" ? parsed.relayChanges : 0,
      seq: typeof parsed.seq === "number" ? parsed.seq : 0,
      publishedFull: parsed.publishedFull === true,
      lastFrameAtMs: typeof parsed.lastFrameAtMs === "number" ? parsed.lastFrameAtMs : 0,
    };
  } catch {
    return newGameState();
  }
}

export function stateKey(gameId: string): string {
  return `${STATE_KEY_PREFIX}${gameId}`;
}

/** 오늘 라이브 상태인 경기 gameId 목록. 실패는 그대로 throw (cron 이 5xx 로 노출). */
export async function listLiveGameIds(date: string): Promise<string[]> {
  const games = await fetchNaverGames(date);
  return games.filter((g) => g.status === "live").map((g) => g.gameId);
}

/** route handler 를 내부 호출하기 위한 NextRequest (공용 self-fetch 없음). */
export function internalGetRequest(
  pathname: string,
  params: Record<string, string>,
): NextRequest {
  const url = new URL(`https://internal.local${pathname}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new NextRequest(url);
}

/**
 * 변경 감지 hash 에서 제거하는 volatile trace 키 (삼순 2차 P0 비용).
 * game-live/detail 응답은 매 호출 바뀌는 타임스탬프(sourceAtMs 등)를 싣는데,
 * 이를 그대로 hash 하면 내용이 같아도 무변경 tick 마다 INSERT 되어 realtime
 * 메시지 fanout 이 폭증한다. hash 는 이 키들을 재귀 제거한 canonical 형태로 잡는다.
 * (저장되는 payload 자체는 원본 그대로 — 클라이언트가 trace 를 쓸 수 있으므로.)
 */
export const VOLATILE_HASH_KEYS: ReadonlySet<string> = new Set([
  "sourceAtMs",
  "fetchedAtMs",
  "deadlineAtMs",
  "remainingMs",
  "servedAtMs",
  "checkedAt",
  "generatedAt",
  "ageMs",
  "latencyMs",
  "trace",
]);

/** volatile 키를 재귀 제거한 canonical 값. 배열 순서·객체 키 정렬로 안정 직렬화. */
export function canonicalizeForHash(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeForHash);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (VOLATILE_HASH_KEYS.has(key)) continue;
      out[key] = canonicalizeForHash((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function frameHash(data: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalizeForHash(data))).digest("hex");
}

const CHANNEL_PATH: Record<"relay" | "events" | "live" | "detail", string> = {
  relay: "/api/game-relay",
  events: "/api/game-events",
  live: "/api/game-live",
  detail: "/api/game-detail",
};

/** 3초 grid 에서 채널별 cadence — 폴링 시절 buildIncludeChannels 와 동일 배치. */
export function channelsForTick(tickIndex: number): Array<"relay" | "events" | "live" | "detail"> {
  const channels: Array<"relay" | "events" | "live" | "detail"> = ["relay"];
  if (tickIndex % 5 === 0) channels.push("events");
  if (tickIndex % 3 === 0) channels.push("live");
  if (tickIndex % 10 === 0) channels.push("detail");
  return channels;
}

export interface TickDeps {
  /** route handlers — 테스트에서 스텁 가능하도록 주입 */
  handlers: {
    relay: (req: NextRequest) => Promise<Response>;
    events: (req: NextRequest) => Promise<Response>;
    live: (req: NextRequest) => Promise<Response>;
    detail: (req: NextRequest) => Promise<Response>;
  };
  /** INSERT 실행기. 성공 시 true. */
  insertFrame: (row: FrameRow) => Promise<boolean>;
  date: string;
  /** 현재 시각 주입(테스트 결정론). 미주입 시 Date.now. */
  now?: () => number;
}

export interface TickResult {
  inserted: number;
  skippedUnchanged: number;
  skippedOversize: number;
  heartbeats: number;
  errors: string[];
}

async function envelopeFrom(
  channel: LivePollEnvelope["channel"],
  task: Promise<Response>,
): Promise<LivePollEnvelope | null> {
  try {
    const response = await task;
    if (!response.ok) return null; // 실패 프레임은 쓰지 않는다 — 클라이언트 last-good 유지 계약과 동일
    const data: unknown = await response.json();
    return { channel, ok: true, status: response.status, data };
  } catch {
    return null;
  }
}

export const HEARTBEAT_ENVELOPE: LivePollEnvelope = {
  channel: "relay",
  ok: true,
  status: 204,
  data: { heartbeat: true },
};

/**
 * 한 경기의 한 tick 을 처리한다: 해당 tick 의 채널들을 내부 호출 → 변경 감지 →
 * INSERT. 무변경이 HEARTBEAT_INTERVAL_MS 넘게 지속되면 heartbeat 프레임 1건 발행.
 * 실패는 결과에 집계하고 throw 하지 않는다(다른 경기·채널 비차단).
 * state 는 in-place 로 갱신된다(호출자가 인보케이션 종료 시 Redis 에 저장).
 */
export async function publishGameTick(
  deps: TickDeps,
  state: PersistedGameState,
  gameId: string,
  tickIndex: number,
): Promise<TickResult> {
  const now = deps.now ?? Date.now;
  const result: TickResult = {
    inserted: 0,
    skippedUnchanged: 0,
    skippedOversize: 0,
    heartbeats: 0,
    errors: [],
  };
  const channels = channelsForTick(tickIndex);

  const tasks = channels.map((channel) => ({
    channel,
    promise: envelopeFrom(channel, deps.handlers[channel](internalGetRequest(
      CHANNEL_PATH[channel],
      channel === "live" ? { gameId, date: deps.date } : { gameId },
    ))),
  }));

  for (const { channel, promise } of tasks) {
    const envelope = await promise;
    if (!envelope) {
      result.errors.push(`${gameId}:${channel}:fetch-failed`);
      continue;
    }

    const hash = frameHash(envelope.data);
    if (state.lastHash[channel] === hash) {
      result.skippedUnchanged += 1;
      continue;
    }

    let kind: FrameKind;
    let payload: LivePollEnvelope = envelope;
    if (channel === "relay") {
      state.relayChanges += 1;
      const wantFull = !state.publishedFull || state.relayChanges % RELAY_FRAME_FULL_EVERY === 1;
      if (wantFull) {
        kind = "relay-full";
      } else {
        kind = "relay-delta";
        const full = envelope.data as GameRelayResponse;
        const currentInning = Math.max(
          0,
          ...((full.innings ?? []).map((inn) => inn.inning)),
        );
        payload = {
          ...envelope,
          data: toDeltaResponse(full, Math.max(0, currentInning - 1)),
        };
      }
    } else {
      kind = channel as FrameKind;
    }

    const bytes = Buffer.byteLength(JSON.stringify(payload));
    if (bytes > MAX_PAYLOAD_BYTES) {
      result.skippedOversize += 1;
      continue;
    }

    state.seq += 1;
    const ok = await deps.insertFrame({ game_id: gameId, seq: state.seq, kind, payload });
    if (ok) {
      // 해시·seq 는 INSERT 성공 후에만 갱신 — 실패 시 다음 tick 재시도(fail-closed retry)
      state.lastHash[channel] = hash;
      state.lastFrameAtMs = now();
      if (kind === "relay-full") state.publishedFull = true;
      result.inserted += 1;
    } else {
      state.seq -= 1; // 실패한 seq 는 회수 — 다음 성공이 그 번호를 재사용
      result.errors.push(`${gameId}:${channel}:insert-failed`);
    }
  }

  // heartbeat: 이번 tick 이 **정상 무변경**(발행 0 · 실패 0 · oversize 0)이고 마지막
  // 발행 이후 HEARTBEAT_INTERVAL_MS 가 지났을 때만 '수집기 건강' 신호를 보낸다.
  // 삼순 2차 P0(폴백 역전): 반복 fetch 실패·250KB 초과 중에는 heartbeat 를 보내지
  // 않아야 클라 신선도가 끊기고 임계 경과에 폴링이 자동 재개된다. errors/oversize 가
  // 있는데 healthy 신호를 계속 보내면 poll 이 영구 억제된다.
  const healthyIdleTick =
    result.inserted === 0 && result.errors.length === 0 && result.skippedOversize === 0;
  if (healthyIdleTick && now() - state.lastFrameAtMs >= HEARTBEAT_INTERVAL_MS) {
    state.seq += 1;
    const ok = await deps.insertFrame({
      game_id: gameId,
      seq: state.seq,
      kind: "heartbeat",
      payload: HEARTBEAT_ENVELOPE,
    });
    if (ok) {
      state.lastFrameAtMs = now();
      result.heartbeats += 1;
    } else {
      state.seq -= 1;
      result.errors.push(`${gameId}:heartbeat:insert-failed`);
    }
  }

  return result;
}
