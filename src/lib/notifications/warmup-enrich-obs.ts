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

/**
 * 값이 붙는 발현 마커 접두사 — `frames-stale=<streak>` (relay 퍼블리셔의 stale-equal 관측,
 * 2026-09-01 LG:OB 볼카운트 고착 조사 후속). exact 집합으로는 가변 suffix 를 못 묶으므로
 * prefix 로 판정한다.
 */
export const EMERGENT_OBS_MARKER_PREFIXES: readonly string[] = ["frames-stale="];

export type WarmupEnrichObsTick = {
  /** trace.fetchedAtMs — 그 라운드의 관측 시각. */
  atMs: number;
  /** 'publisher' = relay-live-publisher 인보케이션 단위 관측(frames-stale). */
  tickKind: "initial" | "subtick" | "publisher";
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
    tick.obs.some((entry) => {
      const marker = obsMarker(entry);
      return (
        EMERGENT_OBS_MARKERS.has(marker) ||
        EMERGENT_OBS_MARKER_PREFIXES.some((prefix) => marker.startsWith(prefix))
      );
    }),
  );
}

/** 보존 창 — 판독은 경기일 단위라 14일이면 충분. GC 는 정시(분==0) 틱에서만 기회적으로. */
export const WARMUP_ENRICH_OBS_RETENTION_MS = 14 * 24 * 3_600_000;

export type PersistWarmupEnrichObsResult =
  | { persisted: number }
  | { error: string };

/** persist 가 쓰는 최소 admin 표면 — 게이트 회귀 테스트가 주입해 동일 seam 을 태운다. */
export type WarmupObsAdminLike = {
  from(table: string): {
    insert(rows: unknown[]): PromiseLike<{ error: { message: string } | null }>;
    delete(): { lt(column: string, value: string): PromiseLike<unknown> };
  };
};

/**
 * 발현 틱을 warmup_enrich_obs 에 적재한다. 어떤 실패도 throw 하지 않는다(fire-and-forget).
 * supabase admin 은 호출 시점 dynamic import — 게이트가 이 모듈을 env 스텁 없이 import 해도
 * 싱글톤이 당겨지지 않는다.
 */
export async function persistWarmupEnrichObs(
  ticks: WarmupEnrichObsTick[],
  nowMs: number = Date.now(),
  getAdmin?: () => WarmupObsAdminLike,
): Promise<PersistWarmupEnrichObsResult> {
  try {
    const emergent = selectEmergentObsTicks(ticks);
    // 기회적 GC 는 발현 유무와 **분리**해 정시(분==0)면 항상 시도한다(삼순 NO-GO 2026-08-30).
    // 정상 relay 만 나오는 날엔 발현 0건 조기 return 이 GC 를 영영 막아 행이 무기한 누적된다.
    const gcDue = new Date(nowMs).getUTCMinutes() === 0;
    if (emergent.length === 0 && !gcDue) return { persisted: 0 };
    const admin: WarmupObsAdminLike = getAdmin
      ? getAdmin()
      : (await import("@/lib/supabase/admin")).getSupabaseAdmin();
    // GC 먼저 — insert 오류 return 경로가 GC 를 건너뛰지 못하게 순서로 독립성 보장.
    // delete 실패는 supabase 가 throw 하지 않으므로 삼킨다(다음 정시에 재시도).
    if (gcDue) {
      await admin
        .from("warmup_enrich_obs")
        .delete()
        .lt(
          "observed_at",
          new Date(nowMs - WARMUP_ENRICH_OBS_RETENTION_MS).toISOString(),
        );
    }
    if (emergent.length === 0) return { persisted: 0 };
    const rows = emergent.map((tick) => ({
      tick_at_ms: tick.atMs,
      tick_kind: tick.tickKind,
      live_source: tick.liveSource,
      live_stage: tick.liveStage,
      obs: tick.obs,
    }));
    const { error } = await admin.from("warmup_enrich_obs").insert(rows);
    if (error) return { error: error.message };
    return { persisted: rows.length };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "persist_failed" };
  }
}
