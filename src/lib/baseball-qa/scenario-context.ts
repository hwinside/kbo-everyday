/** Application-owned scenario topic. Never treat a reference rank as a forecast. */
export interface ScenarioContext { version: 1; question: string }
export function readScenarioContext(value: unknown): ScenarioContext | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (row.version !== 1 || typeof row.question !== "string" || !row.question.trim() || row.question.length > 1000) return undefined;
  return { version: 1, question: row.question };
}
