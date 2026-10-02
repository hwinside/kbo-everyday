/** Summarize observations only. No automatic semantic PASS classifier. */
import fs from 'node:fs';
const paths = process.argv.slice(2);
if (paths.length !== 2) throw new Error('two paths: baseline candidate');
const files = paths.map(p => JSON.parse(fs.readFileSync(p,'utf8')));
const [base,cand] = files;
if (base.mode !== 'production-read-only' || cand.mode !== 'contextual-selection-experiment'
  || base.suite !== cand.suite || base.reps !== cand.reps
  || JSON.stringify(base.questions) !== JSON.stringify(cand.questions)
  || JSON.stringify(base.previousTurn) !== JSON.stringify(cand.previousTurn)
  || base.plannedRuns !== cand.plannedRuns || files.some(f => f.runs.length !== f.plannedRuns)) throw new Error('incomplete or unequal replay budgets/context');
const pct = (xs,p) => xs.length ? [...xs].sort((a,b)=>a-b)[Math.max(0,Math.ceil(xs.length*p)-1)] : null;
const count = xs => xs.reduce((a,k) => { a[k]=(a[k]??0)+1; return a; },{});
console.log(JSON.stringify(files.map(f => {
  const traces = f.runs.flatMap(r=>r.trace);
  const selections = traces.filter(t=>t.stage==='evidence-selection');
  const generation = traces.filter(t=>['official-generation','generic-generation'].includes(t.stage));
  const costs = [...selections,...generation.map(t=>t.raw)];
  const tokenSum = name => costs.filter(c=>Number.isFinite(c?.[name])).reduce((n,c)=>n+c[name],0);
  const elapsed = f.runs.map(r=>r.elapsedMs).filter(Number.isFinite);
  return {suite:f.suite,mode:f.mode,runs:f.runs.length,
    errors:f.runs.filter(r=>r.error).length,sources:count(f.runs.map(r=>r.result?.source ?? 'error')),
    selectionCalls:selections.filter(t=>t.reason!=='no-eligible-candidates' && t.reason!=='missing-credential').length,
    selectorOutcomes:count(selections.map(t=>t.outcome)),fallbackReasons:count(selections.filter(t=>t.outcome==='baseline-fallback').map(t=>t.reason)),
    generationCalls:generation.length,observedInputTokens:tokenSum('inputTokens'),observedOutputTokens:tokenSum('outputTokens'),
    missingTokenMeasurements:costs.filter(c=>!Number.isFinite(c?.inputTokens)||!Number.isFinite(c?.outputTokens)).length,
    latency:{observations:elapsed.length,p50:pct(elapsed,.5),p95:pct(elapsed,.95)},
    selectedEvidenceCounts:count(traces.filter(t=>t.stage==='official-generation').map(t=>t.evidence.length)),
    note:'Tokens cover selector and answer generation only; shared normalizer/mapper calls are not instrumented. Semantic correctness requires human review.'};
}),null,2));
