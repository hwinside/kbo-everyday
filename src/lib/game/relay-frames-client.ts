import type { LivePollEnvelope } from "@/lib/game/live-poll-stream";

/**
 * 크관 relay Realtime 프레임 — 클라이언트 소비 계약 (B안, 2026-08-25).
 *
 * `game_relay_frames` INSERT(postgres_changes)로 도착한 row 를 검증·해석하는
 * 순수 계층. useGameRelay 는 여기서 통과한 프레임만 기존 폴링 경로와 동일한
 * 병합 코드(mergeDeltaInnings 등)에 태운다.
 */

export type RelayFrameKind = "relay-full" | "relay-delta" | "events" | "live" | "detail";

export interface RelayFrameRow {
  id: number;
  game_id: string;
  seq: number;
  kind: RelayFrameKind;
  payload: LivePollEnvelope;
}

const FRAME_KINDS: ReadonlySet<string> = new Set([
  "relay-full",
  "relay-delta",
  "events",
  "live",
  "detail",
]);

/**
 * postgres_changes payload.new 를 fail-close 로 검증한다.
 * - 형상이 깨진 row(payload 없음·kind 미지·game_id 불일치)는 null — 조용히 적용하지 않는다.
 * - max_record_bytes 초과로 payload 가 비어 도착한 row 도 여기서 걸러진다.
 */
export function parseFrameRow(raw: unknown, expectedGameId: string): RelayFrameRow | null {
  if (typeof raw !== "object" || raw === null) return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.id !== "number" || !Number.isFinite(row.id)) return null;
  if (row.game_id !== expectedGameId) return null;
  if (typeof row.seq !== "number" || !Number.isFinite(row.seq)) return null;
  if (typeof row.kind !== "string" || !FRAME_KINDS.has(row.kind)) return null;
  const payload = row.payload;
  if (typeof payload !== "object" || payload === null) return null;
  const envelope = payload as Partial<LivePollEnvelope>;
  if (envelope.ok !== true) return null; // 실패 프레임은 발행 안 하지만, 이중 fail-close
  if (typeof envelope.channel !== "string") return null;
  if (!("data" in envelope) || envelope.data === null || envelope.data === undefined) return null;
  return {
    id: row.id,
    game_id: expectedGameId,
    seq: row.seq,
    kind: row.kind as RelayFrameKind,
    payload: envelope as LivePollEnvelope,
  };
}

/** Realtime 프레임이 이 시간 안에 왔으면 폴링 tick 을 건너뛴다. */
export const REALTIME_POLL_SUPPRESS_MS = 10_000;

/**
 * 폴링 억제 판정.
 * - 첫 로드(보유 이닝 0)는 항상 폴링한다 — mount 직후 realtime 프레임을 기다리며
 *   빈 화면을 보여주지 않는다(초기 상태는 즉시 fetch).
 * - 이후에는 realtime relay 프레임이 REALTIME_POLL_SUPPRESS_MS 안에 왔으면 억제.
 *   프레임이 끊기면(수집기 중단·재연결 지연) 자동으로 폴링이 재개된다 — 폴백은
 *   플래그가 아니라 신선도 자체로 협상한다.
 */
export function shouldSuppressPoll(params: {
  lastRealtimeRelayAtMs: number | null;
  nowMs: number;
  hasInnings: boolean;
}): boolean {
  const { lastRealtimeRelayAtMs, nowMs, hasInnings } = params;
  if (!hasInnings) return false;
  if (lastRealtimeRelayAtMs === null) return false;
  return nowMs - lastRealtimeRelayAtMs < REALTIME_POLL_SUPPRESS_MS;
}

/**
 * 프레임 순서 가드 — 전역 단조 id 기준. 늦게 도착한 과거 프레임(재연결 replay 등)은
 * 적용하지 않는다. delta 병합은 멱등이지만 linescore/currentInning 같은 라이브
 * 필드가 과거로 역행하는 것을 막는다.
 */
export function shouldApplyFrame(lastAppliedId: number, frameId: number): boolean {
  return frameId > lastAppliedId;
}
