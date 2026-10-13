// Read-only production export. Raw DB identifiers never leave memory.
import { createHmac, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
const START = '2026-08-20T00:37:59.000Z';
const END = '2026-09-19T00:37:59.000Z';
const { values } = parseArgs({ options: { out: { type: 'string' }, 'diagnostic-only': { type: 'boolean', default: false }, 'excluded-out': { type: 'string' } } });
if (!values.out) throw Error('OUT_REQUIRED');
const out = resolve(values.out);
const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!base || !key) throw Error('DB_AUTH_MISSING');
const salt = randomBytes(32); // Destroyed at process end; never persisted or logged.
const pseudonym = (domain, value) => createHmac('sha256', salt).update(domain + ':' + value).digest('hex');
const stableRank = value => createHmac('sha256', '20260919').update(String(value)).digest('hex');
const clean = value => String(value ?? '')
  .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL]')
  .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[ID]')
  .replace(/https?:\/\/\S+/g, '[URL]')
  .replace(/(?:\+82[- .]?)?0?1[016789][- .]?\d{3,4}[- .]?\d{4}/g, '[PHONE]')
  .replace(/\b\d{6}[- ]?[1-4]\d{6}\b/g, '[ID]')
  .replace(/<@[^>]+>|@[a-z0-9_.-]+/gi, '[MENTION]')
  .replace(/\b(?:sk-|eyJ)[A-Za-z0-9_.-]{16,}\b/g, '[TOKEN]');
const norm = value => clean(value).normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\p{S}]/gu, '');
async function get(table, params) {
  const url = new URL('/rest/v1/' + table, base);
  for (const [k, v] of params) url.searchParams.append(k, v);
  const response = await fetch(url, { headers: { apikey: key, Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw Error('DB_HTTP_' + response.status);
  return response.json();
}
async function batched(table, fields, column, ids) {
  const result = [];
  for (let i = 0; i < ids.length; i += 100) result.push(...await get(table, [['select', fields], [column, 'in.(' + ids.slice(i, i + 100).join(',') + ')']]));
  return result;
}
async function main() {
  const logs = [];
  // Fixed inclusive time window, stable order; no user_id is requested.
  for (let offset = 0; ; offset += 500) {
    const batch = await get('genius_question_logs', [['select', 'id,question,question_norm,answer,match_path,created_at,question_message_id,rag_attempt_path,rag_discard_reason'], ['created_at', 'gte.' + START], ['created_at', 'lte.' + END], ['order', 'created_at.asc,id.asc'], ['limit', '500'], ['offset', String(offset)]]);
    logs.push(...batch); if (batch.length < 500) break;
    if (offset >= 100000) throw Error('EXPORT_LIMIT_REACHED');
  }
  const mids = [...new Set(logs.map(r => r.question_message_id).filter(v => v != null))];
  const jobs = await batched('genius_question_jobs', 'message_id,conversation_id,source,intent_verdict,llm_text', 'message_id', mids);
  const messages = await batched('dm_messages', 'id,conversation_id', 'id', mids);
  const jm = new Map(jobs.map(j => [String(j.message_id), j]));
  const mm = new Map(messages.map(m => [String(m.id), m]));
  const parent = logs.map((_, i) => i);
  const find = i => parent[i] === i ? i : (parent[i] = find(parent[i]));
  const union = (a, b) => { parent[find(b)] = find(a); };
  const byConversation = new Map(), byNorm = new Map();
  const counters = { duplicate_log_rows: 0, missing_question: 0, missing_conversation: 0, near_duplicate_links: 0 };
  const unique = [], messageSeen = new Set();
  // Group links are built across the full window, before task sampling.
  logs.forEach((r, i) => {
    const j = jm.get(String(r.question_message_id));
    r._job = j;
    r._conversation = mm.get(String(r.question_message_id))?.conversation_id ?? j?.conversation_id;
    const normalized = norm(r.question);
    if (byNorm.has(normalized)) union(i, byNorm.get(normalized)); else byNorm.set(normalized, i);
    if (r._conversation) {
      if (byConversation.has(r._conversation)) union(i, byConversation.get(r._conversation)); else byConversation.set(r._conversation, i);
    }
    r._index = i;
    if (!r.question?.trim()) { counters.missing_question++; return; }
    if (!r._conversation) { counters.missing_conversation++; return; }
    const duplicateKey = String(r.question_message_id);
    if (messageSeen.has(duplicateKey)) { counters.duplicate_log_rows++; return; }
    messageSeen.add(duplicateKey); unique.push(r);
  });
  // Conservative near-duplicate grouping: normalized character bigram Dice >=0.9.
  const entries = [...byNorm.entries()];
  const grams = s => new Set(Array.from({ length: Math.max(0, s.length - 1) }, (_, i) => s.slice(i, i + 2)));
  const sets = entries.map(([s]) => grams(s));
  for (let a = 0; a < entries.length; a++) for (let b = a + 1; b < entries.length; b++) {
    const x = entries[a][0], y = entries[b][0];
    if (x.length < 4 || y.length < 4 || Math.min(x.length, y.length) / Math.max(x.length, y.length) < 0.8) continue;
    const intersection = [...sets[a]].filter(g => sets[b].has(g)).length;
    if (2 * intersection / (sets[a].size + sets[b].size) >= 0.9) { union(entries[a][1], entries[b][1]); counters.near_duplicate_links++; }
  }
  const history = new Map();
  for (const r of unique) {
    const prior = history.get(r._conversation) ?? [];
    r._prior = prior.slice(-2).map(p => '사용자: ' + clean(p.question) + (p.answer ? '\n답변: ' + clean(p.answer) : ''));
    prior.push(r); history.set(r._conversation, prior);
    r._group = 'group-' + pseudonym('group', find(r._index));
  }
  const intent = r => {
    let raw; try { raw = JSON.parse(r._job?.llm_text ?? 'null'); } catch { return null; }
    if (raw?.status === 'BASEBALL_RULE_TERM' && ['RECORD', 'NARRATIVE'].includes(raw?.answer?.trim())) return raw.answer.trim();
    return null;
  };
  const pools = {
    baseball_scope: unique,
    stat_intent: unique.filter(r => intent(r) || r.match_path === 'stat_clarify' || /타율|홈런|타점|방어율|평균자책|출루율|장타율|성적|기록|안타|삼진|도루|승률|ops|war/i.test(r.question)),
    citation: unique.filter(r => r.rag_attempt_path || /rag/.test(r.match_path)),
  };
  const groupDetails = new Map();
  const candidates = [], baseline = [], groups = [], report = { window: { min: START, max: END }, read_count: logs.length, ...counters, tasks: {} };
  for (const [task, pool] of Object.entries(pools)) {
    // Prioritize observed failures/boundaries, then short/context cases, then seeded rank.
    const failure = r => ['blocked', 'unsure', 'error', 'context_missing', 'needs_clarification', 'stat_clarify'].includes(r.match_path) || Boolean(r.rag_discard_reason);
    const rank = r => (failure(r) ? 4 : 0) + ([...r.question.trim()].length <= 6 ? 2 : 0) + (r._prior.length ? 1 : 0);
    const selected = [...pool].sort((a, b) => rank(b) - rank(a) || stableRank(a.id).localeCompare(stableRank(b.id))).slice(0, 200);
    for (const r of selected) {
      const case_id = 'case-' + pseudonym(task, r.id).slice(0, 32);
      const item = { case_id, task, question: clean(r.question), prior_turns: r._prior };
      if (task === 'citation' && r.answer) item.candidate_answer = clean(r.answer);
      // Historical evidence is NOT persisted in question logs. Omit, don't invent []
      // and don't substitute today's retrieval for the historical evidence snapshot.
      candidates.push(item);
      const stratum = [];
      if ([...r.question.trim()].length <= 6) stratum.push('short');
      if (failure(r)) stratum.push('failure_boundary');
      if (r._prior.length) stratum.push('multi_turn');
      if (!stratum.length) stratum.push('ordinary');
      baseline.push({ case_id, current_label: task === 'stat_intent' ? intent(r) : null, stratum,
        observed_match_path: r.match_path, observed_intent_verdict: r._job?.intent_verdict ?? null,
        missing_historical_evidence: task === 'citation', missing_current_label: task !== 'stat_intent' || !intent(r) });
      groups.push({ case_id, group_id: r._group });
      if (!groupDetails.has(r._group)) groupDetails.set(r._group, { cases: 0, conversations: new Set(), missing_conversation: 0 });
      const detail = groupDetails.get(r._group); detail.cases++;
      if (r._conversation) detail.conversations.add(r._conversation); else detail.missing_conversation++;
    }
    const times = selected.map(r => r.created_at).sort();
    report.tasks[task] = { available: pool.length, exported: selected.length, min: times[0] ?? null, max: times.at(-1) ?? null,
      missing_answer: selected.filter(r => !r.answer).length, missing_historical_evidence: task === 'citation' ? selected.length : 0,
      missing_current_label: baseline.filter(r => selected.some(s => r.case_id === 'case-' + pseudonym(task, s.id).slice(0, 32)) && r.missing_current_label).length,
      duplicate_normalized_questions: selected.length - new Set(selected.map(r => norm(r.question))).size };
  }
  const excludedAudit = logs.filter(r => !r._conversation && r.question?.trim()).map(r => ({ case_id: 'case-' + pseudonym('excluded', r.id).slice(0,32), question: clean(r.question), prior_turns: [], group_id: 'group-' + pseudonym('group', find(r._index)), exclusion_reason: 'MISSING_CONVERSATION', candidate_tasks: ['baseball_scope', ...((r.match_path === 'stat_clarify' || /타율|홈런|타점|방어율|평균자책|출루율|장타율|성적|기록|안타|삼진|도루|승률|ops|war/i.test(r.question)) ? ['stat_intent'] : []), ...((r.rag_attempt_path || /rag/.test(r.match_path)) ? ['citation'] : [])], stratum: [...([...r.question.trim()].length <= 6 ? ['short'] : []), ...(['blocked','unsure','error','context_missing','needs_clarification','stat_clarify'].includes(r.match_path) || r.rag_discard_reason ? ['failure_boundary'] : [])], multi_turn_status: 'UNKNOWN_MISSING_CONVERSATION', observed_match_path: r.match_path }));
  if (values['excluded-out']) writeFileSync(resolve(values['excluded-out']), excludedAudit.map(r => JSON.stringify(r)).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
  if (values['diagnostic-only']) {
    const diagnostics = [...groupDetails.values()].map(g => ({ cases: g.cases, distinct_valid_conversations: g.conversations.size, missing_conversation: g.missing_conversation })).sort((a,b)=>b.cases-a.cases);
    console.log(JSON.stringify({ source_missing_conversations_excluded: counters.missing_conversation, selected_largest_groups: diagnostics.slice(0,5) })); return;
  }
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const save = (name, value) => writeFileSync(resolve(out, name), value, { mode: 0o600, flag: 'wx' });
  save('candidate-pool.jsonl', candidates.map(r => JSON.stringify(r)).join('\n') + '\n');
  save('baseline.jsonl', baseline.map(r => JSON.stringify(r)).join('\n') + '\n');
  save('excluded-conversation-audit.jsonl', excludedAudit.map(r => JSON.stringify(r)).join('\n') + '\n');
  save('groups.jsonl', groups.map(r => JSON.stringify(r)).join('\n') + '\n');
  save('extraction-report.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
main().catch(() => { console.error('READ_ONLY_EXPORT_FAILED_NO_RAW_ERROR_LOGGED'); process.exitCode = 1; });
