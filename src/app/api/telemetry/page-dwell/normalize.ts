// page-dwell payload 정규화 — 순수 모듈 (route.ts에서 분리, #1323 삼순 회귀 요구).
// QA 게이트(scripts/qa/dwell-batch-identity-smoke.ts)가 node에서 직접 import해
// legacy 단건·batch 상한·invalid event·30분 cap 계약을 production seam 그대로
// 검증한다 (route에 남겨두면 supabase env 없이는 실행 불가).

// Sub-second hits are noise; cap a single interval to guard against an
// idle-but-visible tab inflating the mean (the client already pauses on hide).
export const MIN_DWELL_MS = 1000;
export const MAX_DWELL_MS = 30 * 60 * 1000;
// Batch bound: the client caps its queue at 20; anything larger is abuse or a
// bug — excess entries are dropped, never inserted.
export const MAX_EVENTS = 20;

export interface RawDwellEvent {
  path?: unknown;
  dwellMs?: unknown;
}

export interface NormalizedDwellEvent {
  path: string;
  /** Already clamped to MAX_DWELL_MS. */
  dwellMs: number;
}

/** Normalize a request payload into insertable events. New clients send
 * `events[]`; legacy clients a single path/dwellMs pair. Per-event validation
 * mirrors the original single-event rules (MIN 1s, MAX 30m cap, path ≤512). */
export function normalizeDwellEvents(payload: {
  path?: unknown;
  dwellMs?: unknown;
  events?: unknown;
}): NormalizedDwellEvent[] {
  const raw: RawDwellEvent[] = Array.isArray(payload.events)
    ? (payload.events as RawDwellEvent[]).slice(0, MAX_EVENTS)
    : [{ path: payload.path, dwellMs: payload.dwellMs }];

  const out: NormalizedDwellEvent[] = [];
  for (const e of raw) {
    const path =
      typeof e?.path === "string" && e.path ? e.path.slice(0, 512) : null;
    const dwellMs =
      typeof e?.dwellMs === "number" && Number.isFinite(e.dwellMs)
        ? Math.round(e.dwellMs)
        : NaN;
    if (path == null || !Number.isFinite(dwellMs) || dwellMs < MIN_DWELL_MS) {
      continue;
    }
    out.push({ path, dwellMs: Math.min(dwellMs, MAX_DWELL_MS) });
  }
  return out;
}
