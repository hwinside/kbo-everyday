import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { LABELS } from './runner.mjs';

export function confusionReport(cases, baseline, labels, manifest, mapping) {
  if (!mapping?.version || !mapping.maps) throw Error('VERSIONED_MAPPING_REQUIRED');
  const index = rows => {
    const m = new Map(rows.map(r => [r.case_id,r]));
    if (m.size !== rows.length) throw Error('DUPLICATE_ID');
    return m;
  };
  const b = index(baseline), g = index(labels), splits = index(manifest.cases);
  index(cases);
  const result = { mapping_version:mapping.version, status:'HOLD_UNTIL_INDEPENDENT_VERDICT', tasks:{} };
  for (const c of cases) {
    if (!b.has(c.case_id) || !g.has(c.case_id) || !splits.has(c.case_id)) throw Error('INCOMPLETE_JOIN');
    const gold = g.get(c.case_id).gold_label, row = b.get(c.case_id), split=splits.get(c.case_id).split;
    if (!LABELS[c.task]?.includes(gold) || !['tune','holdout'].includes(split)) throw Error('INVALID_LABEL_OR_SPLIT');
    const k=c.task+':'+split;
    const bucket=result.tasks[k]??={native_confusion:{},mapped_confusion:{},cases:0,errors:0,unmapped:0};
    bucket.cases++;
    const raw=row.native_prediction??'__ERROR__';
    const mapped=row.provider_status==='ok'?(mapping.maps[c.task]?.[raw]??'__UNMAPPED__'):'__ERROR__';
    if(mapped!=='__UNMAPPED__' && mapped!=='__ERROR__' && !LABELS[c.task].includes(mapped)) throw Error('INVALID_MAPPING_LABEL');
    if(row.provider_status!=='ok') bucket.errors++;
    if(mapped==='__UNMAPPED__') bucket.unmapped++;
    for(const [key,pred] of [['native_confusion',raw],['mapped_confusion',mapped]]) {
      bucket[key][gold]??={}; bucket[key][gold][pred]=(bucket[key][gold][pred]??0)+1;
    }
  }
  return result;
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const {values:v}=parseArgs({options:Object.fromEntries(['cases','baseline','labels','manifest','mapping','out'].map(k=>[k,{type:'string'}]))});
    if(Object.keys(v).length!==6) throw Error('ALL_PATHS_REQUIRED');
    const read=p=>readFileSync(p,'utf8'); const lines=p=>read(p).trim().split('\n').map(JSON.parse);
    const output=confusionReport(lines(v.cases),lines(v.baseline),lines(v.labels),JSON.parse(read(v.manifest)),JSON.parse(read(v.mapping)));
    output.input_hashes=Object.fromEntries(['cases','baseline','labels','manifest','mapping'].map(k=>[k,createHash('sha256').update(read(v[k])).digest('hex')]));
    writeFileSync(v.out,JSON.stringify(output,null,2),{flag:'wx',mode:0o600});
    console.log('CONFUSION_REPORT_WRITTEN_NOT_QUALITY_GO');
  }catch {console.error('BASELINE_REPORT_FAILED');process.exitCode=1;}
}
