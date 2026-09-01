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
 * content-only (B2, 삼순 3차 에스컬레이션 반영): heartbeat 를 폐기했다. heartbeat 는
 * (a) 무변경이어도 listener 1명당 1 메시지를 발행해 CCU × 시간 적분으로 realtime
 * 메시지가 폭증하고(비용 게이트 RED), (b) '건강' 신호가 tick 단위라 채널 실패를 가려
 * 폴백을 억제하는 역전 위험이 있었다. 이제 수집기는 **내용이 바뀐 tick 에만** 발행한다.
 * 무변경 구간엔 프레임이 아예 없고, 클라는 watchdog poll(30~60초)로 신선도를 스스로
 * 상한화한다 — 수집기가 멎어도 최악 watchdog 주기 안에 poll 이 self-heal 한다.
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
/** Redis 지속 상태 키 접두어 + TTL(라이브 종료 후 자연 소멸). */
export const STATE_KEY_PREFIX = "kbo:relay:publisher:state:v1:";
export const STATE_TTL_SECONDS = 6 * 3_600;

export type FrameKind = "relay-full" | "relay-delta" | "events" | "live" | "detail";

/**
 * frames-stale 발현 임계(연속 무변경 relay tick 수). relay 채널은 매 tick(3초) fetch
 * 하므로 20틱 ≈ 60초. 이닝 교대·투수 교체 같은 정상 무변경 구간도 이 임계를 넘을 수
 * 있으므로 이 마커는 **판독용 관측**이지 장애 단정이 아니다 — streak 값과 경기 맥락을
 * 함께 읽는다(2026-09-01 LG:OB 볼카운트 고착 조사: fetch 성공+무변경(stale-equal)이
 * 발현 마커 집합에 없어 mode B 를 원리적으로 관측 못 하던 맹점의 해소).
 */
export const FRAMES_STALE_THRESHOLD_TICKS = 20;

/**
 * frames-stale 마커를 이 streak 에서 발행할지(순수). 임계 도달 시점 + 이후 배증
 * 시점(20, 40, 80, …)에만 true — 임계 초과 구간에서 틱마다 행을 쌓지 않도록 상한.
 */
export function shouldEmitFramesStale(
  streak: number,
  threshold: number = FRAMES_STALE_THRESHOLD_TICKS,
): boolean {
  if (!Number.isFinite(streak) || streak < threshold) return false;
  let mark = threshold;
  while (mark < streak) mark *= 2;
  return mark === streak;
}

/**
 * Realtime 메시지 월 비용 적분 추정 (B2 비용 게이트).
 * DB change 는 listener 1명당 1 메시지이므로 월 메시지 ≈
 *   (변경 프레임/분) × (평균 CCU) × (경기일 라이브 분/월) × (동시 경기 수) × 일수.
 * content-only(heartbeat 폐기)라 무변경 tick 은 INSERT 0 → 발행은 실제 변경 프레임만
 * 남는다. 이 추정은 shadow 계측으로 framesPerMinutePerGame·avgConcurrentViewers 를
 * 실측 대입해 손익분기(BREAK_EVEN) 대비 판정한다.
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
  /** cursor 키: relay-full/relay-delta 는 둘 다 'relay' 로 묶인다(삼순 3-1). */
  channel: string;
  /** 인보케이션 단조 epoch(reserve_relay_epoch). 순서 상위 좌표. */
  epoch: number;
  /** epoch 내 단조 ordinal(= mySeq). 순서 하위 좌표. */
  ordinal: number;
  payload: LivePollEnvelope;
}

/** frame kind → cursor channel. relay-full/relay-delta 는 같은 'relay' 채널로 묶인다. */
export function channelForKind(kind: FrameKind): string {
  return kind === "relay-full" || kind === "relay-delta" ? "relay" : kind;
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
  /**
   * relay 채널 연속 무변경(fetch 성공 + hash 동일) tick 수 — frames-stale 관측 전용.
   * inserted 에서만 0 리셋. fetch 실패·abort·insert 거부(stale/lock_busy/error)는
   * "무변경 관측"이 아니므로 증가도 리셋도 하지 않는다.
   */
  relayUnchangedStreak: number;
}

export function newGameState(): PersistedGameState {
  return { lastHash: {}, relayChanges: 0, seq: 0, publishedFull: false, relayUnchangedStreak: 0 };
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
      relayUnchangedStreak:
        typeof parsed.relayUnchangedStreak === "number" && parsed.relayUnchangedStreak >= 0
          ? parsed.relayUnchangedStreak
          : 0,
    };
  } catch {
    return newGameState();
  }
}

export function stateKey(gameId: string): string {
  return `${STATE_KEY_PREFIX}${gameId}`;
}

/**
 * obs 적재 허용 마커 선별(순수) — 삼순 #1331 NO-GO ②.
 *
 * streak 의 SSOT 는 Redis 에 저장된 state 다. 적재만 되고 state 저장이 안 되면(락 상실·
 * SET 실패) 다음 인보케이션이 같은 streak 을 재생산해 임계 행(20)이 반복 적재되고
 * 배증 상한이 깨진다. 계약: **owner 확인 → state SET 성공 검증 → obs 적재** 순서로,
 * 폐기되는 streak 의 마커는 함께 폐기한다(마커↔state 원자적 동반).
 * 마커 형식 `<gameId>:frames-stale=<streak>` 의 gameId 로 state SET 결과와 결속.
 */
export function selectPersistableStaleMarkers(params: {
  markers: string[];
  lockLost: boolean;
  stillOwner: boolean;
  stateSetOk: (gameId: string) => boolean;
}): string[] {
  const { markers, lockLost, stillOwner, stateSetOk } = params;
  if (lockLost || !stillOwner) return [];
  return markers.filter((marker) => {
    const sep = marker.indexOf(":");
    if (sep <= 0) return false;
    return stateSetOk(marker.slice(0, sep)) === true;
  });
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
  signal?: AbortSignal,
): NextRequest {
  const url = new URL(`https://internal.local${pathname}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  // 삼순 4차 ③: signal 을 handler 요청에 전달 — timeout abort 시 진행 중인 upstream fetch 가
  // 이 신호를 상속해 끊릴 수 있다(handler 가 req.signal 을 존중하는 경우).
  return signal ? new NextRequest(url, { signal }) : new NextRequest(url);
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
  "updatedAt",
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
  /** INSERT 실행기. 성공 시 true. signal 이 abort 되면 커밋하지 않고 false (삼순 5차). */
  insertFrame: (row: FrameRow, signal?: AbortSignal) => Promise<RelayInsertOutcome>;
  /** 이 인보케이션이 선예약한 단조 epoch(reserve_relay_epoch). 모든 프레임이 공유. */
  epoch: number;
  date: string;
}

/**
 * publish_relay_frame RPC 의 원자 결과. durable ordering 은 DB(RPC)가 권위이며,
 * 이 outcome 은 route/게이트 관측성 전용이다(삼순 4축 게이트 "lock_busy bounded" 검증).
 * - inserted : 커밋 성공(유일하게 lastHash/publishedFull 갱신)
 * - stale    : (epoch, ordinal) <= cursor 원자 거부(이미 더 최신이 커밋됨) — 정상
 * - lock_busy: pg_try_advisory_xact_lock 실패(다른 인보케이션이 경기 락 보유) — 정상
 * - skipped  : RPC 앞단 게이트(lockLost/abort/ownsLock 실패)로 호출 자체 안 함
 * - error    : RPC 오류(네트워크/제약 위반 등) — 다음 tick 재시도
 */
export type RelayInsertOutcome = "inserted" | "stale" | "lock_busy" | "skipped" | "error";

export interface TickResult {
  inserted: number;
  skippedUnchanged: number;
  skippedOversize: number;
  /**
   * frames-stale 발현 streak — relay 채널이 이 tick 에서 발현 지점(임계·배증)에 도달했으면
   * 그 streak 값, 아니면 null. route 가 `${gameId}:frames-stale=<streak>` 마커로 적재한다.
   */
  framesStaleStreak: number | null;
  /** RPC 가 stale 로 원자 거부한 프레임 수(정상 — 이미 더 최신 커밋). */
  stale: number;
  /** advisory xact lock 경합으로 거부된 프레임 수(정상 — 다른 인보케이션이 씀). */
  lockBusy: number;
  errors: string[];
}

/**
 * degraded 신호 헤더 — game-relay 가 일부 이닝 실패 시 last-good 을 섞은 200 에 붙인다.
 * frames-stale 은 "완전 fresh 200 + 내용 동일"만 stale-equal 증거로 센다(삼순 #1331 ①).
 */
export const RELAY_DEGRADED_HEADER = "x-kbo-relay-degraded";

async function envelopeFrom(
  channel: LivePollEnvelope["channel"],
  task: Promise<Response>,
): Promise<{ envelope: LivePollEnvelope; degraded: boolean } | null> {
  try {
    const response = await task;
    if (!response.ok) return null; // 실패 프레임은 쓰지 않는다 — 클라이언트 last-good 유지 계약과 동일
    const data: unknown = await response.json();
    return {
      envelope: { channel, ok: true, status: response.status, data },
      degraded: response.headers.get(RELAY_DEGRADED_HEADER) === "1",
    };
  } catch {
    return null;
  }
}

/**
 * 한 경기의 한 tick 을 처리한다: 해당 tick 의 채널들을 내부 호출 → 변경 감지 →
 * INSERT. content-only(B2): 내용이 바뀐 tick 에만 발행하고 heartbeat 는 발행하지 않는다
 * — 무변경 신선도는 클라의 watchdog poll 이 담당한다.
 * 실패는 결과에 집계하고 throw 하지 않는다(다른 경기·채널 비차단).
 * state 는 in-place 로 갱신된다(호출자가 인보케이션 종료 시 Redis 에 저장).
 */
export async function publishGameTick(
  deps: TickDeps,
  state: PersistedGameState,
  gameId: string,
  tickIndex: number,
  signal?: AbortSignal,
): Promise<TickResult> {
  const result: TickResult = {
    inserted: 0,
    skippedUnchanged: 0,
    skippedOversize: 0,
    framesStaleStreak: null,
    stale: 0,
    lockBusy: 0,
    errors: [],
  };
  const channels = channelsForTick(tickIndex);

  const tasks = channels.map((channel) => ({
    channel,
    promise: envelopeFrom(channel, deps.handlers[channel](internalGetRequest(
      CHANNEL_PATH[channel],
      channel === "live" ? { gameId, date: deps.date } : { gameId },
      signal,
    ))),
  }));

  for (const { channel, promise } of tasks) {
    // 삼순 4차 ③: abort 되면(timeout) 이후 어떤 INSERT 도 시도하지 않는다 — 늦게 끝난 tick 이
    // 다음 tick 과 같은 state 를 동시 변경·INSERT 하는 것을 차단(fence).
    if (signal?.aborted) {
      result.errors.push(`${gameId}:${channel}:aborted`);
      continue;
    }
    const fetched = await promise;
    if (signal?.aborted) {
      result.errors.push(`${gameId}:${channel}:aborted`);
      continue;
    }
    if (!fetched) {
      result.errors.push(`${gameId}:${channel}:fetch-failed`);
      continue;
    }
    const { envelope, degraded } = fetched;

    const hash = frameHash(envelope.data);
    if (state.lastHash[channel] === hash) {
      result.skippedUnchanged += 1;
      // frames-stale 관측: relay 채널의 "**완전 fresh** fetch 성공 + 내용 동일"만 센다 —
      // 업스트림이 살아있는데 데이터가 멎은 stale-equal(mode B)의 직접 증거.
      // degraded 200(last-good 혼입 — 일부 이닝 fetch 실패)은 업스트림 실패 구간이므로
      // 불가산(삼순 #1331 NO-GO ①) — 단, 리셋도 안 한다(실패는 무변경 '관측'이 아님).
      // events/live/detail 은 cadence 가 달라 섞으면 streak 의미가 흐려진다.
      if (channel === "relay" && !degraded) {
        state.relayUnchangedStreak += 1;
        if (shouldEmitFramesStale(state.relayUnchangedStreak)) {
          result.framesStaleStreak = state.relayUnchangedStreak;
        }
      }
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

    // 삼순 5차: INSERT 직전 abort 재확인 — hash 계산 사이에 timeout 이 나면 INSERT 건너뛴.
    if (signal?.aborted) {
      result.errors.push(`${gameId}:${channel}:aborted`);
      continue;
    }
    // 삼순 5차: seq 는 **단조 증가만** 한다 — async 경계 뒤 `state.seq -= 1` 감산을 전면
    // 제거. 겹친 tick(A/B)이 공용 state 를 쓸 때 늦은 A 의 감산이 B 의 seq 를 되감아
    // 다음 tick 이 seq 를 중복 발급하는 경합을 원천 차단한다. 실패·abort 시 이 번호는
    // 버려지고(gap 허용) 다음 tick 이 더 큰 seq 로 재시도한다 — 클라이언트는 DB id 로
    // 순서를 판정하므로 seq gap 은 무해하다.
    const mySeq = ++state.seq;
    // 삼순 확정 설계: 순서 좌표는 (epoch, ordinal). epoch 는 인보케이션 단위 단조값,
    // ordinal 은 그 안에서 단조 증가하는 mySeq. cursor channel 은 루프 channel 과 동일
    // (relay 일 때 kind는 relay-full/delta → channelForKind 와 같음; 그 외엕 kind===channel).
    // RPC 가 (epoch, ordinal) <= cursor 를 원자 거부해 늦게 커밋된 이전 인보케이션 프레임
    // (작은 epoch)을 걸러낸다(durable ordering 근원 보장).
    // signal 을 insertFrame 으로 전달 — route 는 ownsLock 후 abort 재확인 + Supabase insert 에
    // abortSignal 을 걸어, abort 된 A 는 커밋되지 않는다(늦은 A row 가 최신 id 로 전파 ❌).
    const outcome = await deps.insertFrame(
      { game_id: gameId, seq: mySeq, kind, channel, epoch: deps.epoch, ordinal: mySeq, payload },
      signal,
    );
    // 삼순 6차: post-INSERT abort fence 복원 — INSERT 결과 대기 중 abort 가 나면 그 프레임은
    // 다음 tick 이 재발행하도록 lastHash/publishedFull 을 갱신하지 않는다. seq 감산은
    // 하지 않는다(단조 유지) — 이 번호는 gap 으로 버려진다. 단, 누락 감지를 위해 본
    // 번호의 commit 여부와 무관하게 상태만 멈춘다(durable ordering 은 route await-outstanding 이 보장).
    if (signal?.aborted) {
      result.errors.push(`${gameId}:${channel}:aborted`);
      continue;
    }
    if (outcome === "inserted") {
      // 해시는 INSERT 성공 후에만 갱신 — 실패 시 다음 tick 재시도(fail-closed retry). seq 는 불감.
      state.lastHash[channel] = hash;
      if (kind === "relay-full") state.publishedFull = true;
      if (channel === "relay") state.relayUnchangedStreak = 0;
      result.inserted += 1;
    } else if (outcome === "stale") {
      // RPC 원자 거부(이미 더 최신 커밋) — 정상 흐름. 해시 미갱신으로 다음 tick 재시도.
      result.stale += 1;
    } else if (outcome === "lock_busy") {
      // 다른 인보케이션이 경기 락 보유 — 정상 흐름. 그쪽이 쓴다. 해시 미갱신.
      result.lockBusy += 1;
    } else {
      // skipped(RPC 앞단 게이트) / error(RPC 오류) — 해시 미갱신으로 다음 tick 재시도.
      result.errors.push(`${gameId}:${channel}:insert-${outcome}`);
    }
  }

  return result;
}
