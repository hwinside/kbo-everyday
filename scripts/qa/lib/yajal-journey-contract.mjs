import { createHash } from 'node:crypto';
export const BOT_ID = '45ae7419-6a9a-4c6b-9101-8d65df7e242e';
export function readConfig(env, receipt) {
  const required = ['QA_BASE_URL', 'QA_EXPECTED_SHA', 'QA_TEST_USER_ID', 'QA_EMAIL', 'QA_PASSWORD', 'QA_OUT', 'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'];
  for (const key of required) if (!env[key]) throw new Error(`missing ${key}`);
  const base = new URL(env.QA_BASE_URL);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('QA_BASE_URL must be a bare origin');
  if (!/^qa-[a-z0-9+-]+@keubo\.fan$/i.test(env.QA_EMAIL)) throw new Error('dedicated qa- account required');
  if (!/^[0-9a-f]{40}$/.test(env.QA_EXPECTED_SHA)) throw new Error('exact app SHA required');
  if (receipt?.sha !== env.QA_EXPECTED_SHA || receipt?.origin !== base.origin || !receipt?.evidence || !receipt?.checkedBy) throw new Error('deployment receipt must bind origin, exact app SHA, evidence and reviewer');
  const age = Date.now() - Date.parse(receipt.observedAt);
  if (!Number.isFinite(age) || age < 0 || age > 30 * 60_000) throw new Error('deployment receipt must be observed within 30 minutes');
  const timeoutMs = Number(env.QA_REPLY_TIMEOUT_MS ?? 120000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 180000) throw new Error('reply timeout must be 1000..180000ms');
  return { origin: base.origin, appSha: env.QA_EXPECTED_SHA, userId: env.QA_TEST_USER_ID, timeoutMs, question: env.QA_QUESTION || '희생번트는 타수에 들어가?' };
}
export function fingerprint(value) { return createHash('sha256').update(value).digest('hex'); }
// Preserve the question FK: a later unrelated bot message is not this answer.
export function repliesTo(rows, questionId) {
  return rows.filter(row => row.sender_id === BOT_ID && String(row.payload?.question_message_id) === String(questionId));
}
