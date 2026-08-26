import type { LivePollEnvelope } from "@/lib/game/live-poll-stream";

/**
 * 크관 relay Realtime 프레임 — 클라이언트 소비 계약 (B안 v2, 2026-08-25 삼순 NO-GO 반영).
 *
 * `game_relay_frames` INSERT(postgres_changes)로 도착한 row 를 검증·해석하는
 * 순수 계층. useGameRelay 는 여기서 통과한 프레임만 기존 폴링 경로와 동일한
 * 병합 코드(mergeDeltaInnings 등)에 태운다.
 */

export type RelayFrameKind =
  | "relay-full"
  | "relay-delta"
  | "events"
  | "live"
  | "detail";

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
 * - content-only(B2): 모든 kind 가 payload.data 를 요구한다(heartbeat 폐기).
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

/**
 * watchdog poll 주기(ms). content-only Realtime(B2)에서 클라는 마지막 성공 relay
 * 데이터가 이 창 안에 있으면 3초 tick 을 억제하고, 창을 넘기면 poll 한 번을 허용해
 * self-heal 한다. 무변경 구간엔 publisher 가 프레임을 안 보내므로 watchdog 주기마다
 * poll 1회가 신선도를 갱신 → idle edge 비용이 (라이브분/watchdog분)으로 상한 고정된다.
 * 30~60초 범위(삼순 3차 권고).
 */
export const RELAY_WATCHDOG_MS = 45_000;

/**
 * 폴링 억제 판정 (B2 watchdog).
 * - 성공한 relay baseline 이 없으면(초기 로드·초기 fetch 실패) 항상 폴링한다 —
 *   heartbeat 가 빈 화면/retry 를 가리던 문제 제거(삼순 3차: "성공 relay baseline 보유").
 * - baseline 이후엔 마지막 성공 relay 데이터(poll 또는 Realtime relay frame)가
 *   RELAY_WATCHDOG_MS 안에 있으면 억제, 지나면 watchdog poll 로 재개한다.
 *   content-only 라 무변경 구간에도 watchdog poll 이 신선도를 갱신해 edge 비용을
 *   명확히 상한화한다(폴백 역전·영구 억제 위험 소멸).
 */
export function shouldSuppressPoll(params: {
  lastRelayFreshAtMs: number | null;
  nowMs: number;
  hasRelayBaseline: boolean;
}): boolean {
  const { lastRelayFreshAtMs, nowMs, hasRelayBaseline } = params;
  if (!hasRelayBaseline) return false;
  if (lastRelayFreshAtMs === null) return false;
  return nowMs - lastRelayFreshAtMs < RELAY_WATCHDOG_MS;
}

/**
 * 프레임 순서 가드 — 전역 단조 id 기준. 늦게 도착한 과거 프레임(재연결 replay 등)은
 * 적용하지 않는다.
 */
export function shouldApplyFrame(lastAppliedId: number, frameId: number): boolean {
  return frameId > lastAppliedId;
}

/**
 * 최신성 소유권 fence (P0-3 반영). poll 응답과 Realtime 적용이 공유하는 단조
 * generation. Realtime 이 최신 프레임을 적용하면 generation 을 올리고, 그보다
 * 먼저 시작해 늦게 끝난 poll 응답은 자신의 generation 이 최신이 아니면 버려진다
 * → 느린 poll 이 최신 Realtime 값을 과거로 덮는 역행이 원천 차단된다.
 */
export function shouldApplyPollResponse(pollGeneration: number, currentGeneration: number): boolean {
  return pollGeneration >= currentGeneration;
}
