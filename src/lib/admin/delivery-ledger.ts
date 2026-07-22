export interface DeliveryLedgerCounts {
  expected: number;
  selected: number;
  tokens: number;
  sent: number;
  failed: number;
  infrastructureOk: boolean;
}

export interface DeliveryLedgerResult extends DeliveryLedgerCounts {
  status: "completed" | "completed_with_failures";
  lastError: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * userIds 필드가 없을 때만 전체 발송이다. 명시 필드가 빈 배열/잘못된 값이면
 * 전체 발송으로 승격하지 않고 400 처리하도록 예외를 던진다.
 */
export function normalizeManualPushTargets(
  value: unknown,
  fieldPresent: boolean,
): string[] | null {
  if (!fieldPresent) return null;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("userIds must be a non-empty UUID array when provided");
  }
  if (value.some((id) => typeof id !== "string" || !UUID_RE.test(id))) {
    throw new Error("userIds must contain only UUID strings");
  }
  return [...new Set(value as string[])];
}

function assertCount(name: string, value: number) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
}

/**
 * 수동 push 원장의 expected → selected → token → sent/failed 연쇄를 검증한다.
 * 어느 단계든 수가 맞지 않으면 성공 원장을 쓰지 못하게 fail-closed 한다.
 */
export function reconcileDeliveryLedger(counts: DeliveryLedgerCounts): DeliveryLedgerResult {
  assertCount("expected", counts.expected);
  assertCount("selected", counts.selected);
  assertCount("tokens", counts.tokens);
  assertCount("sent", counts.sent);
  assertCount("failed", counts.failed);

  if (counts.expected !== counts.selected) {
    throw new Error(`target mismatch: expected ${counts.expected}, selected ${counts.selected}`);
  }
  if (counts.infrastructureOk && counts.tokens !== counts.sent + counts.failed) {
    throw new Error(
      `delivery mismatch: tokens ${counts.tokens}, sent ${counts.sent}, failed ${counts.failed}`,
    );
  }

  const completed = counts.infrastructureOk && counts.failed === 0;
  return {
    ...counts,
    status: completed ? "completed" : "completed_with_failures",
    lastError: counts.infrastructureOk ? null : "fcm_infrastructure_failure",
  };
}
