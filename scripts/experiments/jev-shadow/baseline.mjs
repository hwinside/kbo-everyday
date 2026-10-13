// Incumbent classifier replay only. No server.ts imports, DB writes, caches or user replies.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import incumbent from '../../../src/lib/baseball-qa/gemini-request.ts';
const { BASEBALL_QA_GEMINI_MODEL, BASEBALL_QA_SYSTEM_PROMPT, buildBaseballQaGeminiRequest } = incumbent;

const hash = (value) => createHash('sha256').update(value).digest('hex');
const { values } = parseArgs({ options: { input: { type: 'string' }, out: { type: 'string' }, live: { type: 'boolean', default: false }, task: { type: 'string' } } });
async function main() {
  if (!values.input || !values.out) throw Error('INPUT_OUT_REQUIRED');
  const bytes = readFileSync(values.input);
  const rows = bytes.toString().trim().split('\n').map(line => JSON.parse(line)).filter(r => ['baseball_scope', 'stat_intent'].includes(r.task) && (!values.task || r.task === values.task));
  if (!rows.length || rows.length > 400) throw Error('INVALID_ROUTING_CASE_COUNT');
  const requests = rows.map(row => {
    if (!/^case-[a-z0-9-]+$/.test(row.case_id) || typeof row.question !== 'string' || !Array.isArray(row.prior_turns) || row.prior_turns.length > 2) throw Error('INVALID_CASE');
    // Same question + all supplied prior turns as Jev. Prior pairs are data;
    // production's pure request builder supplies the unchanged system prompt/config.
    const request = buildBaseballQaGeminiRequest(row.question, BASEBALL_QA_SYSTEM_PROMPT, undefined, undefined, row.task === 'stat_intent');
    const prior = row.prior_turns.flatMap((turn) => {
      if (typeof turn !== 'string' || !turn.startsWith('사용자: ')) throw Error('INVALID_PRIOR_FORMAT');
      const split = turn.indexOf('\n답변: ');
      if (split < 0) return [{ role: 'user', parts: [{ text: turn.slice(5) }] }];
      return [{ role: 'user', parts: [{ text: turn.slice(5, split) }] }, { role: 'model', parts: [{ text: turn.slice(split + 5) }] }];
    });
    request.contents = [...prior, ...request.contents];
    return request;
  });
  const meta = { model: BASEBALL_QA_GEMINI_MODEL, input_sha256: hash(bytes), system_prompt_sha256: hash(BASEBALL_QA_SYSTEM_PROMPT), request_hashes_sha256: hash(JSON.stringify(requests.map(r => hash(JSON.stringify(r))))), cases: rows.length,
    note: 'Incumbent LLM classifier component replay, NOT end-to-end production route replay; max2 reconstructed prior pairs, no roster snapshot. Native RULE_TERM remains unmapped.' };
  if (!values.live) { console.log(JSON.stringify({ ...meta, mode: 'validate-only' })); return; }
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw Error('GEMINI_AUTH_MISSING');
  writeFileSync(values.out, '', { flag: 'wx', mode: 0o600 });
  writeFileSync(values.out + '.meta.json', JSON.stringify(meta, null, 2), { flag: 'wx', mode: 0o600 });
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i], start = performance.now();
    let prediction = null, native_prediction = null, error_code = null;
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${BASEBALL_QA_GEMINI_MODEL}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(requests[i]), signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw Error('HTTP_' + response.status);
      const data = await response.json();
      const candidate = data.candidates?.[0];
      if (candidate?.finishReason !== 'STOP') throw Error('INCOMPLETE_GENERATION');
      const text = candidate.content?.parts?.filter((p) => !p.thought).map((p) => p.text ?? '').join('');
      const parsed = JSON.parse(text);
      if (row.task === 'baseball_scope') {
        const map = { BASEBALL_RULE_TERM: 'BASEBALL', NOT_BASEBALL: 'NON_BASEBALL', UNSURE: 'AMBIGUOUS' };
        if (!Object.hasOwn(map, parsed.status)) throw Error('INVALID_STATUS');
        native_prediction = parsed.status; prediction = map[parsed.status];
      } else {
        if (['NOT_BASEBALL','UNSURE'].includes(parsed.status)) {
          native_prediction = parsed.status; prediction = 'NA';
        } else if (parsed.status === 'BASEBALL_RULE_TERM' && ['RECORD','NARRATIVE','RULE_TERM'].includes(parsed.answer?.trim())) {
          native_prediction = parsed.answer.trim(); prediction = native_prediction === 'RULE_TERM' ? null : native_prediction;
        } else { native_prediction = 'INVALID_OUTPUT'; throw Error('INVALID_INTENT'); }
      }
    } catch (error) {
      const e = error;
      error_code = /^HTTP_\d+$|^INCOMPLETE_GENERATION$|^INVALID_STATUS$|^INVALID_INTENT$/.test(e.message) ? e.message : e.name === 'TimeoutError' ? 'TIMEOUT' : 'PROVIDER_OR_SCHEMA_ERROR';
    }
    appendFileSync(values.out, JSON.stringify({ case_id: row.case_id, prediction, native_prediction, latency_ms: performance.now() - start, provider_status: error_code ? 'error' : 'ok', error_code }) + '\n');
    if (error_code && !['INVALID_INTENT','INVALID_STATUS','INCOMPLETE_GENERATION','PROVIDER_OR_SCHEMA_ERROR'].includes(error_code)) throw Error('BASELINE_INCOMPLETE_STOPPED');
  }
  console.log(JSON.stringify({ status: 'COMPLETE_NOT_QUALITY_GO', calls: rows.length }));
}
main().catch(error => { console.error(/^[A-Z0-9_]+$/.test(error.message) ? error.message : 'BASELINE_FAILED'); process.exitCode = 1; });
