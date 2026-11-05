/** Production intent parser; shared by serving and offline evaluation. */
export function parseStatIntentToken(rawText: string): "record" | "narrative" | "rule_term" | null {
  let row: Record<string, unknown>;
  try {
    row = JSON.parse(rawText.trim()) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!row || typeof row !== "object" || typeof row.answer !== "string") return null;
  // 삼순 2026-08-14 결속 ②: status 까지 exact 결속 — 프롬프트 계약과 다른 응답
  // (NOT_BASEBALL 로 토큰만 내보내는 등)은 의도로 인정하지 않고 되묻기 fail-close.
  if (row.status !== "BASEBALL_RULE_TERM") return null;
  const token = row.answer.trim();
  if (token === "RECORD") return "record";
  if (token === "NARRATIVE") return "narrative";
  if (token === "RULE_TERM") return "rule_term";
  return null;
}
