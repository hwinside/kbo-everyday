import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { fetchNaverGames } from "@/lib/crawler/naver-games";
import { toDeltaResponse } from "@/lib/game/relay-delta";
import type { GameRelayResponse } from "@/app/api/game-relay/route";
import type { LivePollEnvelope } from "@/lib/game/live-poll-stream";

/**
 * 크관 relay Realtime 퍼블리셔 코어 (B안, 2026-08-25).
 *
 * 역할: 라이브 경기마다 기존 route handler(GET /api/game-relay 등)를 프로세스
 * 내부에서 호출해(공용 self-fetch 없음 — game-relay-events 와 동일 패턴) 결과를
 * `game_relay_frames` 테이블에 INSERT 한다. Supabase Realtime(postgres_changes)이
 * 구독 클라이언트에 전파하므로, 클라이언트 3초 폴링이 사라진다.
 *
 * 변경 감지 계약: 프레임은 **내용이 바뀐 tick 에만** 쓴다. 폴링과 달리 fanout
 * 비용(메시지 수 × 구독자)이 write 횟수에 비례하므로, 무변경 tick 의 INSERT 는
 * 그대로 낭비가 된다. 해시는 응답 data 전체(JSON canonical stringify)로 잡는다.
 * cron 인보케이션 경계(1분)마다 메모리가 초기화되어 최대 1프레임/분/채널의
 * 중복이 생길 수 있다 — 폴링(20/분) 대비 여전히 1/20 이며, 클라이언트 병합은
 * 멱등이라(동일 innings 병합) 무해하다.
 *
 * full/delta 계약: relay 는 기본 delta(since = currentInning-1, toDeltaResponse —
 * 폴링 경로와 동일 함수)로 쓰고, ①이 경기의 첫 발행 ②FULL_EVERY 번째 변경마다
 * 'relay-full' 을 쓴다. 클라이언트 mount 는 최신 relay-full + 이후 delta 를
 * PostgREST 로 읽어 폴링의 첫 full 로드와 동일한 상태에서 시작한다.
 *
 * 크기 가드: payload 가 MAX_PAYLOAD_BYTES 를 넘으면 INSERT 를 건너뛴다(
 * postgres_changes max_record_bytes 초과 시 빈 payload 로 전파되는 것을
 * fail-close). 건너뛴 채널은 클라이언트 폴링 폴백이 자연 커버한다.
 */

export const RELAY_FRAME_FULL_EVERY = 20;
export const MAX_PAYLOAD_BYTES = 250_000;
/** tick 간격(ms). 폴링 시절 클라이언트 cadence 와 동일. */
export const TICK_INTERVAL_MS = 3_000;

export type FrameKind = "relay-full" | "relay-delta" | "events" | "live" | "detail";

export interface FrameRow {
  game_id: string;
  seq: number;
  kind: FrameKind;
  payload: LivePollEnvelope;
}

export interface PublisherGameState {
  /** 채널별 마지막 발행 해시 (relay 는 full 응답 기준) */
  lastHash: Map<string, string>;
  /** relay 변경 횟수 (FULL_EVERY 판정) */
  relayChanges: number;
  /** 경기 단위 frame seq (단조증가) */
  seq: number;
  /** 이번 런에서 relay-full 을 이미 발행했는가 */
  publishedFull: boolean;
}

export function newGameState(): PublisherGameState {
  return { lastHash: new Map(), relayChanges: 0, seq: 0, publishedFull: false };
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

export function frameHash(data: unknown): string {
  return createHash("sha256").update(JSON.stringify(data)).digest("hex");
}

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
}

export interface TickResult {
  inserted: number;
  skippedUnchanged: number;
  skippedOversize: number;
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

/**
 * 한 경기의 한 tick 을 처리한다: 해당 tick 의 채널들을 내부 호출 → 변경 감지 →
 * INSERT. 실패는 결과에 집계하고 throw 하지 않는다(다른 경기·채널 비차단).
 */
export async function publishGameTick(
  deps: TickDeps,
  state: PublisherGameState,
  gameId: string,
  tickIndex: number,
): Promise<TickResult> {
  const result: TickResult = { inserted: 0, skippedUnchanged: 0, skippedOversize: 0, errors: [] };
  const channels = channelsForTick(tickIndex);

  const tasks: Array<{ channel: LivePollEnvelope["channel"]; promise: Promise<LivePollEnvelope | null> }> = [];
  for (const channel of channels) {
    const params: Record<string, string> = { gameId };
    if (channel === "live") params.date = deps.date;
    const req = internalGetRequest(`/api/game-${channel === "relay" ? "relay" : channel === "events" ? "events" : channel === "live" ? "live" : "detail"}`, params);
    const handler = deps.handlers[channel === "relay" ? "relay" : channel === "events" ? "events" : channel === "live" ? "live" : "detail"];
    tasks.push({ channel, promise: envelopeFrom(channel, handler(req)) });
  }

  for (const { channel, promise } of tasks) {
    const envelope = await promise;
    if (!envelope) {
      result.errors.push(`${gameId}:${channel}:fetch-failed`);
      continue;
    }

    const hash = frameHash(envelope.data);
    if (state.lastHash.get(channel) === hash) {
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
      // 해시는 INSERT 성공 후에만 갱신 — 실패 시 다음 tick 재시도(fail-closed retry)
      state.lastHash.set(channel, hash);
      if (kind === "relay-full") state.publishedFull = true;
      result.inserted += 1;
    } else {
      result.errors.push(`${gameId}:${channel}:insert-failed`);
    }
  }

  return result;
}
