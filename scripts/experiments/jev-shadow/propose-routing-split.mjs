// Proposal only: reviewer must audit/freeze before labels or holdout inspection.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { validateCases, validateManifest } from './runner.mjs';
const { values } = parseArgs({ options: { dir: { type: 'string' }, out: { type: 'string' } } });
if (!values.dir || !values.out) throw Error('DIR_OUT_REQUIRED');
const load = name => readFileSync(resolve(values.dir, name), 'utf8').trim().split('\n').map(line => JSON.parse(line));
const rows = load('candidate-pool.jsonl').filter(r => ['baseball_scope', 'stat_intent'].includes(r.task));
const baseline = new Map(load('baseline.jsonl').map(r => [r.case_id, r]));
const groups = new Map(load('groups.jsonl').map(r => [r.case_id, r.group_id]));
const counts = new Map();
for (const row of rows) counts.set(groups.get(row.case_id), (counts.get(groups.get(row.case_id)) ?? 0) + 1);
const largest = [...counts].sort((a,b) => b[1]-a[1] || a[0].localeCompare(b[0]))[0][0];
const rank = row => (baseline.get(row.case_id).stratum.includes('failure_boundary') ? 4 : 0) + ([...row.question.trim()].length <= 6 ? 2 : 0) + (row.prior_turns.length ? 1 : 0);
const seedRank = row => createHash('sha256').update('20260919:' + JSON.stringify({ task:row.task, question:row.question, prior_turns:row.prior_turns })).digest('hex');
const selected = [], assignments = [];
for (const task of ['baseball_scope', 'stat_intent']) for (const split of ['tune', 'holdout']) {
  const pool = rows.filter(r => r.task === task && ((groups.get(r.case_id) === largest) === (split === 'tune')))
    .sort((a,b) => rank(b)-rank(a) || seedRank(a).localeCompare(seedRank(b)));
  const requiredShort = split === 'tune' ? pool.filter(r => [...r.question.trim()].length <= 6).slice(0,25) : [];
  const chosen = new Set(requiredShort.map(r => r.case_id));
  const part = [...requiredShort, ...pool.filter(r => !chosen.has(r.case_id))].slice(0,50);
  if (part.length !== 50) throw Error('INSUFFICIENT_GROUP_DISJOINT_POOL');
  selected.push(...part);
  assignments.push(...part.map(r => ({ case_id:r.case_id, group_id:groups.get(r.case_id), split })));
}
const selectedBaseline = selected.map(r => baseline.get(r.case_id));
const manifest = { seed:20260919, cases:assignments };
validateCases(selected); validateManifest(selected, manifest, selectedBaseline);
mkdirSync(values.out, { mode:0o700 });
const save = (name, data) => writeFileSync(resolve(values.out,name),data,{mode:0o600,flag:'wx'});
const lines = data => data.map(r=>JSON.stringify(r)).join('\n')+'\n';
save('cases.jsonl',lines(selected)); save('baseline.jsonl',lines(selectedBaseline)); save('split.json',JSON.stringify(manifest,null,2));
const selectedIds = new Set(selected.map(r => r.case_id));
const unselected = rows.filter(r => !selectedIds.has(r.case_id)).map(r => ({case_id:r.case_id,reason:groups.get(r.case_id)===largest?'LARGE_GROUP_TUNE_CAP_50':'HOLDOUT_CAP_50'}));
save('unselected.jsonl',lines(unselected));
const strata = [];
for(const task of ['baseball_scope','stat_intent']) for(const split of ['tune','holdout']) {
 const ids = new Set(assignments.filter(r=>r.split===split).map(r=>r.case_id));
 const part = selected.filter(r=>r.task===task && ids.has(r.case_id));
 strata.push({task,split,count:part.length,short:part.filter(r=>[...r.question.trim()].length<=6).length,multi_turn:part.filter(r=>r.prior_turns.length>0).length,failure_boundary:part.filter(r=>baseline.get(r.case_id).stratum.includes('failure_boundary')).length});
}
save('proposal.json',JSON.stringify({strata,unselected_count:unselected.length,status:'REVIEW_REQUIRED_NOT_FROZEN',seed:20260919,tasks:['baseball_scope','stat_intent'],cases:200,method:'Largest intact connected component contributes 50/task to tune; 50/task from other intact groups to holdout. Candidate rows not selected are excluded, not split across groups. Both splits are failure/short/context enriched; population accuracy cannot be inferred.'},null,2));
console.log(JSON.stringify({status:'PROPOSAL_QUOTAS_VALID',cases:200,tune:100,holdout:100}));
