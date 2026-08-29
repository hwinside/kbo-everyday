/**
 * ⓕ warmup enrichObs DB 적재 (삼순 2026-08-28 19:26 하린아빠 수용 스코프).
 *
 * 배경: warmup cron 틱의 응답 body 는 Vercel 이 저장하지 않아 응답 JSON 판독은
 * 수동 GET 한 요청만 보는 스팟 표본(경기 3시간 180틱 중 ~1.5%)이었다. 발현 틱을
 * DB 에 1줄씩 남기면 cron 180틱이 전수로 남아 mode B(stale-equal) 확정/기각이
 * 표본 논쟁 없이 끝난다.
 *
 * 설계 주문(삼순):
 * - **발현 틱만 기록** — score-src=schedule·score-src=frames·relay-failed·deadline-cut
 *   이 있는 틱만. 정상 relay 틱(score-src=relay)은 쓰지 않는다("무발현 = 행 없음").
 * - **쓰기가 발송을 막지 않게** — broadcast critical path 밖에서 fire-and-forget,
 *   실패는 삼킨다(반환 객체로만 관측).
 */

/** 발현 마커 — obs 엔트리 형식 `${gameId}:<marker>` 의 marker 부. */
export const EMERGENT_OBS_MARKERS: ReadonlySet<string> = new Set([
  "score-src=schedule",
  "score-src=frames",
  "relay-failed",
  "deadline-cut",
]);

export type WarmupEnrichObsTick = {
  /** trace.fetchedAtMs — 그 라운드의 관측 시각. */
  atMs: number;
  tickKind: "initial" | "subtick";
  liveSource: string;
  liveStage: string;
  obs: string[];
};

function obsMarker(entry: string): string {
  const sep = entry.indexOf(":");
  return sep >= 0 ? entry.slice(sep + 1) : entry;
}

/** 발현 틱 선별(순수) — obs 에 발현 마커가 하나라도 있는 틱만 남긴다. */
export function selectEmergentObsTicks(
  ticks: WarmupEnrichObsTick[],
): WarmupEnrichObsTick[] {
  return ticks.filter((tick) =>
    tick.obs.some((entry) => EMERGENT_OBS_MARKERS.has(obsMarker(entry))),
  );
}

/** 보존 창 — 판독은 경기일 단위라 14일이면 충분. GC 는 정시(분==0) 틱에서만 기회적으로. */
export const WARMUP_ENRICH_OBS_RETENTION_MS = 14 * 24 * 3_600_000;

export type PersistWarmupEnrichObsResult =
  | { persisted: number }
  | { error: string };

/**
 * 발현 틱을 warmup_enrich_obs 에 적재한다. 어떤 실패도 throw 하지 않는다(fire-and-forget).
 * supabase admin 은 호출 시점 dynamic import — 게이트가 이 모듈을 env 스텁 없이 import 해도
 * 싱글톤이 당겨지지 않는다.
 */
export async function persistWarmupEnrichObs(
  ticks: WarmupEnrichObsTick[],
  nowMs: number = Date.now(),
): Promise<PersistWarmupEnrichObsResult> {
  try {
    const emergent = selectEmergentObsTicks(ticks);
    if (emergent.length === 0) return { persisted: 0 };
    const { getSupabaseAdmin } = await import("@/lib/supabase/admin");
    const admin = getSupabaseAdmin();
    const rows = emergent.map((tick) => ({
      tick_at_ms: tick.atMs,
      tick_kind: tick.tickKind,
      live_source: tick.liveSource,
      live_stage: tick.liveStage,
      obs: tick.obs,
    }));
    const { error } = await admin.from("warmup_enrich_obs").insert(rows);
    if (error) return { error: error.message };
    // 기회적 GC — 정시 틱에서만 1회(경기당 수 행 규모라 부하 무시 가능, 인덱스 있는 observed_at).
    if (new Date(nowMs).getUTCMinutes() === 0) {
      await admin
        .from("warmup_enrich_obs")
        .delete()
        .lt(
          "observed_at",
          new Date(nowMs - WARMUP_ENRICH_OBS_RETENTION_MS).toISOString(),
        );
    }
    return { persisted: rows.length };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "persist_failed" };
  }
}
