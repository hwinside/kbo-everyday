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
    return { gameId: game.gameId, status: "incomplete", failureReason: reason, rowsUpserted, unresolved };
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

  // §11: DB 재조회로 actual canonical payload hash 검증 (upsert 결과를 신뢰하지 않는다).
  // query-guard: bounded -- game_id 단위 선수 행, 경기당 최대 ~60행 (양팀 타자+투수)
  const { data: persisted, error: selectError } = await client
    .from("player_game_logs")
    .select(CANONICAL_ROW_FIELDS.join(","))
    .eq("game_id", game.gameId);
  if (selectError) throw new Error(`player_game_logs 재조회 실패 (${game.gameId}): ${selectError.message}`);

  const persistedRows = (persisted ?? []) as unknown as CanonicalRowInput[];
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
  };
}

export type { PlayerGameLogRow };
