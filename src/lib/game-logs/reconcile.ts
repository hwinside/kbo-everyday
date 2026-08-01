/**
 * 직관 다이어리 통계 S1a — stale player-log key reconciliation (순수 판정 helper).
 *
 * 배경: `player_game_logs` 는 `(kbo_id, player_type, game_id)` upsert 라서
 * 선수 식별자가 재해석되면(예: 2026-07-04 LG전 투수 `56709|pitcher` → `52731|pitcher`)
 * 구 key 행이 남아 37행 기대에 38행이 되고, canonical hash mismatch 로 영원히 incomplete 된다.
 *
 * 다만 "기대 집합에 없으면 지운다" 는 위험하다 — 공급자가 선수 1명을 빠뜨린
 * 부분 응답도 `missingFields=0` 일 수 있고, 그 경우 멀쩡한 과거 행이 삭제된 뒤
 * 줄어든 집합끼리 아귀가 맞아 `complete` 로 오판된다(삼순 P0-1).
 * 이 함수는 백필뿐 아니라 정기 game-logs cron 도 공용으로 쓰므로 더더욱 좁혀야 한다.
 *
 * 그래서 삭제는 **rekey 로 설명되는 짝** 이 있을 때만 허용한다. 두 경로를 순서대로 둔다:
 *
 *  (A) 지문 1:1 — stale ↔ added 가 `kbo_id` 만 다르고 나머지 canonical 필드가 전부
 *      exact 일치하며 그 짝이 양방향 유일할 때. (가장 좀고 가장 안전)
 *
 *  (B) 경기별 승인표 — 원천 대조로 확인한 `(game_id, player_type, stale_id, expected_id)`
 *      한 줄과 정확히 일치할 때만 허용한다.
 *
 * 이름은 신원이 아니므로 동명이인 자동 추정은 금지한다. 장기적으로는 공급자 source ID를
 * ledger identity까지 보존해야 하며, 그 전까지 승인표 밖 사례는 모두 fail-close한다.
 */
import { CANONICAL_ROW_FIELDS, type CanonicalRowInput } from "@/lib/game-logs/completeness";

/** canonical 정렬키와 동일한 (kbo_id, player_type) 쌍. */
export function rowKey(row: CanonicalRowInput): string {
  return `${String(row.kbo_id)}\u0000${String(row.player_type)}`;
}

/** kbo_id 를 제외한 나머지 canonical 필드 — rekey 짝 판정의 지문. */
const IDENTITY_FIELDS = CANONICAL_ROW_FIELDS.filter((f) => f !== "kbo_id");

function fingerprint(row: CanonicalRowInput): string {
  return IDENTITY_FIELDS.map((f) => {
    const v = row[f];
    return v === null || v === undefined ? "\u2205" : String(v);
  }).join(",");
}

const APPROVED_REKEYS = new Set([
  "20260430SSOB0\u0000pitcher\u000065040\u000062360",
  "20260505WOSS0\u0000pitcher\u000065040\u000062360",
  "20260512SSLG0\u0000pitcher\u000065040\u000062360",
  "20260517HTSS0\u0000pitcher\u000065040\u000062360",
]);

/**
 * 승인표로 설명되는 후보 행.
 *
 * ⚠️ candidate 는 **같은 경기 · 같은 player_type** 이어야 한다(삼순 P0).
 * 승인표 key 에는 stale 쪽의 game_id/player_type 만 들어 있어서, candidate 쪽을 검증하지 않으면
 *   · stale `65040|pitcher` + expected `62360|batter` 만 있어도 pitcher 행이 삭제되고
 *   · 전혀 다른 경기의 `62360` 행이 섞여 있어도 삭제가 통과한다
 * 둘 다 재현 확인했다. 승인한 것은 "그 경기의 그 역할에서 65040이 62360으로 재식별"이지
 * "62360 이라는 ID 가 어디에든 있으면 삭제"가 아니다.
 */
function approvedCounterparts(row: CanonicalRowInput, added: CanonicalRowInput[]): CanonicalRowInput[] {
  return added.filter((candidate) => {
    if (String(candidate.game_id) !== String(row.game_id)) return false;
    if (String(candidate.player_type) !== String(row.player_type)) return false;
    return APPROVED_REKEYS.has([
      String(row.game_id),
      String(row.player_type),
      String(row.kbo_id),
      String(candidate.kbo_id),
    ].join("\u0000"));
  });
}

export type ReconcileRefusalReason =
  /** 이번 실행에 unresolved 선수가 있어 기대 집합을 신뢰할 수 없음 */
  | "unresolved_present"
  /** 지워야 할 행에 대응하는 신규 key 가 없음 — 공급자 부분 응답 의심 */
  | "no_rekey_counterpart"
  /** 짝 후보가 둘 이상이라 어느 쪽이 같은 선수인지 확정 불가 */
  | "ambiguous_rekey_counterpart"
  /** 기대 집합이 비었거나 기존 행 전부를 지우게 됨 */
  | "suspicious_full_delete";

export interface ReconcilePlan {
  /** 삭제해도 안전하다고 판정된 행 (rekey 1:1 짝이 확인된 것만). */
  deletions: CanonicalRowInput[];
  /** 삭제 거부 사유 — 값이 있으면 삭제 0 이고 호출부는 fail-closed 해야 한다. */
  refusal: ReconcileRefusalReason | null;
  /** 진단용: 거부를 유발한 stale 행 key 목록. */
  offendingKeys: string[];
}

/**
 * 삭제 계획을 세운다. DB 를 건드리지 않는 순수 함수 — 테스트가 실제 판정 로직을 그대로 태운다.
 *
 * @param beforeRows  upsert 직전의 DB 행 (여기 없던 key = 이번에 새로 생긴 key)
 * @param persistedRows upsert 직후의 DB 행 (삭제 후보 모집단)
 * @param expectedRows  strict build 가 산출한 기대 행
 * @param unresolvedCount 이번 빌드의 미해결 선수 수
 */
export function planStaleReconciliation(
  beforeRows: CanonicalRowInput[],
  persistedRows: CanonicalRowInput[],
  expectedRows: CanonicalRowInput[],
  unresolvedCount: number,
): ReconcilePlan {
  const none = (refusal: ReconcileRefusalReason | null, offendingKeys: string[] = []): ReconcilePlan => ({
    deletions: [],
    refusal,
    offendingKeys,
  });

  const expectedKeys = new Set(expectedRows.map(rowKey));
  const stale = persistedRows.filter((r) => !expectedKeys.has(rowKey(r)));
  if (stale.length === 0) return none(null);

  // 미해결 선수가 있으면 기대 집합 자체가 불완전하다 — 삭제 금지.
  if (unresolvedCount > 0) {
    return none("unresolved_present", stale.map(rowKey));
  }

  // 기대가 비었거나 기존 행을 통째로 지우는 상황은 입력 이상으로 본다.
  if (expectedKeys.size === 0 || stale.length >= persistedRows.length) {
    return none("suspicious_full_delete", stale.map(rowKey));
  }

  // 이번 실행에서 "새로 생긴" 기대 key 만 rekey 짝 후보가 될 수 있다.
  const beforeKeys = new Set(beforeRows.map(rowKey));
  const added = expectedRows.filter((r) => !beforeKeys.has(rowKey(r)));

  // stale ↔ added 를 지문으로 1:1 매칭. 양방향 유일할 때만 삭제한다.
  const addedByFingerprint = new Map<string, CanonicalRowInput[]>();
  for (const row of added) {
    const fp = fingerprint(row);
    const bucket = addedByFingerprint.get(fp);
    if (bucket) bucket.push(row);
    else addedByFingerprint.set(fp, [row]);
  }

  const staleByFingerprint = new Map<string, CanonicalRowInput[]>();
  for (const row of stale) {
    const fp = fingerprint(row);
    const bucket = staleByFingerprint.get(fp);
    if (bucket) bucket.push(row);
    else staleByFingerprint.set(fp, [row]);
  }

  const deletions: CanonicalRowInput[] = [];
  for (const row of stale) {
    const fp = fingerprint(row);
    const counterparts = addedByFingerprint.get(fp) ?? [];

    // (A) 원천 대조로 승인한 경기별 exact rekey — 가장 강한 근거이므로 먼저 본다.
    //
    // 지문 휴리스틱보다 앞에 두는 이유: 같은 경기에 기록이 같은 투수가 여럿이면
    // 지문이 여러 후보와 걸려 `ambiguous` 로 전체 reconcile 이 거부된다.
    // 그런데 승인표는 KBO raw `pcode` 를 사람이 직접 대조해 넣은 exact 항목이라
    // "기록이 같아서 모호하다"보다 상위 근거다.
    // (실측 20260505WOSS0: stale 65040|pitcher ipOuts=3 에 대해 62360·AQ003 두 투수가
    //  모두 ipOuts=3 → 지문 2건 → ambiguous. 그러나 원천 pcode 상 65040→62360 은 확정이다.)
    //
    // 이 순서 변경은 승인표에 있는 4줄 외에는 영향을 주지 않는다 — 승인표가 비면
    // 바로 (B) 지문 경로로 내려가 종전 판정 그대로다.
    const approved = approvedCounterparts(row, added);
    if (approved.length === 1) {
      deletions.push(row);
      continue;
    }
    if (approved.length > 1) return none("ambiguous_rekey_counterpart", [rowKey(row)]);

    // (B) 지문 1:1 — 종전 판정을 그대로 유지한다(모호하면 여전히 거부).
    if (counterparts.length === 0) {
      // 대응하는 신규 key 가 없다 = rekey 가 아니라 그냥 사라진 선수(부분 응답).
      return none("no_rekey_counterpart", [rowKey(row)]);
    }
    if (counterparts.length > 1 || (staleByFingerprint.get(fp)?.length ?? 0) > 1) {
      return none("ambiguous_rekey_counterpart", [rowKey(row)]);
    }
    if (String(counterparts[0].player_type) !== String(row.player_type)) {
      return none("no_rekey_counterpart", [rowKey(row)]);
    }
    deletions.push(row);
  }

  return { deletions, refusal: null, offendingKeys: [] };
}
