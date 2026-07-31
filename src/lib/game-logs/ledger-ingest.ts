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
  type PlayerResolver,
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
  /**
   * 테스트 seam — 기본값은 production 경로(실제 boxscore 페치 + 로스터 resolver).
   * 회귀에서 이 오케스트레이터를 그대로 태우기 위해서만 주입한다.
   */
  deps: { fetchBoxscore?: typeof fetchGameBoxscore; resolver?: PlayerResolver } = {},
): Promise<LedgerIngestResult> {
  const fetchBoxscore = deps.fetchBoxscore ?? fetchGameBoxscore;
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

  const box = await fetchBoxscore(game.gameId);
  if (!box) {
    return incomplete("boxscore_unavailable");
  }

  const build = deps.resolver
    ? buildGameIngestion(game, box, deps.resolver)
    : buildGameIngestion(game, box);

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

  // ── 쓰기: 삭제 + upsert 를 하나의 트랜잭션으로 원자화 ─────────────────────
  // 두 요청으로 나누면 중간 실패 때 선수 행이 실제로 사라진다. 그 구간은 조용하지 않다 —
  // `/api/player-game-logs`, team-card 주간 집계, venue-attendance 는 ledger 를 보지 않고
  // player_game_logs 를 직접 읽으므로 누락값을 그대로 노출한다(삼순 P0).
  // (venue-stats 만 runtime hash 로 fail-close 한다.)
  //
  // 그래서 `reconcile_player_game_logs` RPC 로 묶는다 — 함수 본문이 단일 트랜잭션이라
  // 중간 실패 시 삭제도 함께 롤백되고, 외부 소비자는 "구 key 만" 또는 "신 key 만" 중
  // 하나의 일관된 상태만 관측한다.
  //
  // 삭제 대상은 preflight 가 upsert 전 상태로 확정했고(rekey 1:1 짝), 거부 없음도 확인했다.
  const deleteKeys = preflight.deletions.map((row) => ({
    kboId: String(row.kbo_id),
    playerType: String(row.player_type),
  }));

  // query-guard: bounded -- 단일 game_id 적재 RPC. 반환은 {deleted, upserted} 스칼라 jsonb 1객체로
  // 행 집합이 아니고, 쓰기 범위도 경기 1건 박스스코어로 상한이 고정된다
  // (양팀 타자+투수 = 최대 ~60행; delete_keys ⊆ 기존 경기행). 유저·시간 증가 무관.
  const { data: reconcileData, error: reconcileError } = await client.rpc(
    "reconcile_player_game_logs",
    {
      p_game_id: game.gameId,
      p_delete_keys: deleteKeys,
      p_rows: build.rows,
    },
  );
  // 실패는 조용히 넘기지 않는다 — 부분 상태를 complete 로 남기면 안 된다.
  if (reconcileError) {
    throw new Error(
      `player_game_logs reconcile 실패 (${game.gameId}): ${reconcileError.message}`,
    );
  }
  const reconciled = (reconcileData ?? {}) as { deleted?: number; upserted?: number };
  const staleRowsRemoved = reconciled.deleted ?? 0;
  const rowsUpserted = reconciled.upserted ?? 0;

  // 쓰기 결과를 신뢰하지 않고 재조회해 actual canonical payload hash 를 검증한다.
  const persistedRows = await reselect();
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
