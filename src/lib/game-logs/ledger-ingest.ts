/**
 * 직관 다이어리 통계 S1a — 경기 1건 적재 + 완료 증거 ledger 기록 오케스트레이터.
 * spec: Notion "[기획] 직관 다이어리 통계 v1" rev5 §11 적재 순서.
 *
 * boxscore 전체 파싱 → 필수필드 검증(결측→0 강등 금지) → 모든 선수 resolve(1:1 가드) →
 * expected canonical payload hash 생성 → player_game_logs upsert → DB 재조회 actual hash 검증 →
 * 판정 후에야 ledger 1행 upsert. 완료행을 먼저 쓰지 않는다.
 *
 * cron(game-logs)·backfill(backfill-game-log-ledger.mts) 공용.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { KboGame } from "@/lib/crawler/kbo-api";
import { fetchGameBoxscore, type PlayerGameLogRow, type UnresolvedBoxScorePlayer } from "@/lib/game-logs/ingest";
import { planStaleReconciliation } from "@/lib/game-logs/reconcile";
import {
  CANONICAL_ROW_FIELDS,
  buildGameIngestion,
  canonicalPayloadHash,
  evaluateIngestion,
  type CanonicalRowInput,
  type IngestionFailureReason,
} from "@/lib/game-logs/completeness";

export interface LedgerIngestResult {
  gameId: string;
  status: "complete" | "incomplete";
  failureReason: IngestionFailureReason | null;
  rowsUpserted: number;
  unresolved: UnresolvedBoxScorePlayer[];
  /**
   * strict build 가 기대하지 않는 기존 `(kbo_id, player_type)` 행을 몇 개 지웠는지.
   * 선수 재해석(과거 오매핑) 이후 구 key 가 남아 row 수가 부풀면 hash mismatch 로
   * 영원히 incomplete 가 된다 — 그걸 정리한 개수다.
   */
  staleRowsRemoved: number;
}

/** YYYYMMDD → YYYY-MM-DD */
function toIsoDate(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

interface LedgerUpsertRow {
  game_id: string;
  game_date: string;
  status: "complete" | "incomplete";
  expected_row_count: number | null;
  expected_payload_hash: string | null;
  persisted_row_count: number | null;
  unresolved_count: number;
  source_fetched_at: string;
  verified_at: string;
  failure_reason: IngestionFailureReason | null;
  updated_at: string;
}

async function upsertLedger(client: SupabaseClient, row: LedgerUpsertRow): Promise<void> {
  const { error } = await client
    .from("player_game_log_ingestions")
    .upsert(row, { onConflict: "game_id" });
  if (error) throw new Error(`ledger upsert 실패 (${row.game_id}): ${error.message}`);
}

/**
 * final 경기 1건: 박스스코어 페치 → strict 적재 → 검증 → ledger 기록.
 * 판정 불가(박스 없음·스코어 없음·필수필드 결측)도 incomplete ledger를 남긴다 —
 * ledger 없음=incomplete 이지만, 사유가 남아야 backfill/운영 진단이 가능.
 */
export async function ingestGameWithLedger(
  client: SupabaseClient,
  game: KboGame,
): Promise<LedgerIngestResult> {
  const gameDate = toIsoDate(game.date);
  const fetchedAt = new Date().toISOString();

  const incomplete = async (
    reason: IngestionFailureReason,
    extra?: Partial<Pick<LedgerUpsertRow, "expected_row_count" | "expected_payload_hash" | "persisted_row_count" | "unresolved_count">>,
    unresolved: UnresolvedBoxScorePlayer[] = [],
    rowsUpserted = 0,
  ): Promise<LedgerIngestResult> => {
    const now = new Date().toISOString();
    await upsertLedger(client, {
      game_id: game.gameId, game_date: gameDate, status: "incomplete",
      expected_row_count: extra?.expected_row_count ?? null,
      expected_payload_hash: extra?.expected_payload_hash ?? null,
      persisted_row_count: extra?.persisted_row_count ?? null,
      unresolved_count: extra?.unresolved_count ?? 0,
      source_fetched_at: fetchedAt, verified_at: now, failure_reason: reason, updated_at: now,
    });
    return { gameId: game.gameId, status: "incomplete", failureReason: reason, rowsUpserted, unresolved, staleRowsRemoved: 0 };
  };

  if (game.awayScore == null || game.homeScore == null) {
    return incomplete("score_unavailable");
  }

  const box = await fetchGameBoxscore(game.gameId);
  if (!box) {
    return incomplete("boxscore_unavailable");
  }

  const build = buildGameIngestion(game, box);

  // §12 fail-closed: 필수필드 결측이면 0 강등도, 부분 적재도 하지 않는다.
  if (build.missingFields.length > 0) {
    return incomplete("missing_required_field", { unresolved_count: build.unresolved.length }, build.unresolved);
  }

  const expectedRowCount = build.rows.length;
  const expectedPayloadHash = canonicalPayloadHash(build.rows);

  // §11: DB 재조회 helper (upsert/삭제 결과를 신뢰하지 않는다).
  // query-guard: bounded -- game_id 단위 선수 행, 경기당 최대 ~60행 (양팀 타자+투수)
  const reselect = async (): Promise<CanonicalRowInput[]> => {
    const { data, error } = await client
      .from("player_game_logs")
      .select(CANONICAL_ROW_FIELDS.join(","))
      .eq("game_id", game.gameId);
    if (error) throw new Error(`player_game_logs 재조회 실패 (${game.gameId}): ${error.message}`);
    return (data ?? []) as unknown as CanonicalRowInput[];
  };

  // rekey 판정에는 "upsert 전" 상태가 필요하다 — 여기 없던 key 만 이번에 새로 생긴 key 다.
  const beforeRows = await reselect();

  // ── preflight reconciliation (upsert 전에 판정한다) ────────────────────
  // upsert 를 먼저 하고 판정하면, 거부되더라도 신 key 가 DB 에 남는다.
  // 그럼 다음 정상 실행의 beforeRows 에 이미 신 key 가 있어 `added` 가 빈 배열이 되고,
  // 구 key 는 `no_rekey_counterpart` 로 분류되어 **재시도로도 영원히 복구 불가**가 된다.
  // (예: 1차에 rekey + 일시적 unresolved 가 같이 오는 경우 — 삼순 P0)
  //
  // 그래서 삭제 필요 여부를 **upsert 전 상태로 먼저 판정**하고, 거부되면
  // 쓰기 자체를 하지 않고 종료한다 — DB 를 직전 상태 그대로 남겨 다음 정상 실행이 복구할 수 있게 한다.
  const preflight = planStaleReconciliation(
    beforeRows,
    beforeRows,
    build.rows,
    build.unresolved.length,
  );
  if (preflight.refusal) {
    return incomplete(
      "row_count_mismatch",
      {
        expected_row_count: expectedRowCount,
        expected_payload_hash: expectedPayloadHash,
        persisted_row_count: beforeRows.length,
        unresolved_count: build.unresolved.length,
      },
      build.unresolved,
      0, // 쓰기 없음
    );
  }

  // resolve된 행은 unresolved가 있어도 upsert한다(로스터 보강 후 재적재로 complete 승격).
  let rowsUpserted = 0;
  for (let i = 0; i < build.rows.length; i += 500) {
    const chunk = build.rows.slice(i, i + 500);
    const { error } = await client
      .from("player_game_logs")
      .upsert(chunk, { onConflict: "kbo_id,player_type,game_id" });
    if (error) throw new Error(`player_game_logs upsert 실패 (${game.gameId} @${i}): ${error.message}`);
    rowsUpserted += chunk.length;
  }

  let persistedRows = await reselect();

  // ── stale key reconciliation ────────────────────────────────────────
  // upsert 는 새 key 를 넣기만 하고 구 key 를 지우지 않아, 선수 식별자가 재해석되면
  // (예: 7/4 LG전 `56709|pitcher` → `52731|pitcher`) 행이 부풀어 hash mismatch 로
  // 영원히 incomplete 된다. 다만 "기대에 없으면 지운다" 는 공급자 부분 응답 때
  // 멀쩡한 과거 행을 지우고 줄어든 집합끼리 아귀가 맞아 complete 로 오판된다.
  // 그래서 삭제는 rekey 로 설명되는 1:1 짝에만 허용한다(planStaleReconciliation).
  // preflight 에서 이미 거부 없음을 확인했고, 삭제 대상도 upsert 전 기준으로 확정됐다.
  // upsert 는 기대 행만 넣으므로 삭제 대상(구 key)은 그대로 유효하다.
  let staleRowsRemoved = 0;
  const plan = preflight;
  if (plan.deletions.length > 0) {
    for (const stale of plan.deletions) {
      const { error: deleteError } = await client
        .from("player_game_logs")
        .delete()
        .eq("game_id", game.gameId)
        .eq("kbo_id", stale.kbo_id as string)
        .eq("player_type", stale.player_type as string);
      // 삭제 실패는 조용히 넘기지 않는다 — 부분 상태를 complete 로 남기면 안 된다.
      if (deleteError) {
        throw new Error(
          `stale row 삭제 실패 (${game.gameId} ${String(stale.kbo_id)}/${String(stale.player_type)}): ${deleteError.message}`,
        );
      }
      staleRowsRemoved += 1;
    }
    // 삭제 후 다시 읽어 actual 상태를 갱신한다(삭제 결과도 신뢰하지 않는다).
    persistedRows = await reselect();
  }

  const actualPayloadHash = canonicalPayloadHash(persistedRows);

  const verdict = evaluateIngestion({
    rawRowCount: build.rawRowCount,
    resolvedRowCount: build.resolvedRowCount,
    persistedRowCount: persistedRows.length,
    unresolvedCount: build.unresolved.length,
    missingFieldCount: 0,
    expectedRowCount,
    expectedPayloadHash,
    actualPayloadHash,
  });

  const now = new Date().toISOString();
  await upsertLedger(client, {
    game_id: game.gameId, game_date: gameDate, status: verdict.status,
    expected_row_count: expectedRowCount,
    expected_payload_hash: expectedPayloadHash,
    persisted_row_count: persistedRows.length,
    unresolved_count: build.unresolved.length,
    source_fetched_at: fetchedAt, verified_at: now,
    failure_reason: verdict.failureReason, updated_at: now,
  });

  return {
    gameId: game.gameId,
    status: verdict.status,
    failureReason: verdict.failureReason,
    rowsUpserted,
    unresolved: build.unresolved,
    staleRowsRemoved,
  };
}

export type { PlayerGameLogRow };
