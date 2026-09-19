import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const runner = fileURLToPath(new URL('./baseline.mjs', import.meta.url));
const loader = fileURLToPath(new URL('./node_modules/tsx/dist/loader.mjs', import.meta.url));

function runMock(body) {
  const dir = mkdtempSync(join(tmpdir(), 'jev-baseline-selfcheck-'));
  try {
    const input = join(dir, 'cases.jsonl'), output = join(dir, 'result.jsonl'), mock = join(dir, 'mock.mjs');
    const row = { case_id:'case-synthetic-stat',task:'stat_intent',question:'희생플라이?',prior_turns:['사용자: 야구 규칙\n답변: 질문해주세요.'],current_label:'SHOULD_NOT_LEAK',stratum:['PRIVATE_BASELINE'] };
    writeFileSync(input,JSON.stringify(row)+'\n');
    writeFileSync(mock,`globalThis.fetch = async (_url, options) => { if(options.body.includes('SHOULD_NOT_LEAK') || options.body.includes('PRIVATE_BASELINE')) throw Error('LEAK'); ${body} };`);
    const child = spawnSync(process.execPath,['--import',loader,'--import',mock,runner,'--input',input,'--out',output,'--live'],{encoding:'utf8',env:{...process.env,GEMINI_API_KEY:'synthetic-not-a-real-key'}});
    const rows = readFileSync(output,'utf8').trim().split('\n').map(JSON.parse);
    return { child, rows };
  } finally { rmSync(dir,{recursive:true,force:true}); }
}

test('incumbent RULE_TERM remains native, not silently recoded as NA', () => {
  const { child, rows } = runMock(`return new Response(JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({status:'BASEBALL_RULE_TERM',answer:'RULE_TERM'})}]}}]}),{status:200});`);
  assert.equal(child.status,0,child.stderr);
  assert.equal(rows[0].native_prediction,'RULE_TERM');
  assert.equal(rows[0].prediction,null);
  assert.equal(rows[0].provider_status,'ok');
  assert.ok(!JSON.stringify(rows).includes('희생플라이'));
});

test('baseline HTTP failure is checkpointed, redacted, and stops without retries', () => {
  const { child, rows } = runMock(`return new Response('SECRET_SERVER_BODY',{status:429});`);
  assert.equal(child.status,1);
  assert.equal(rows[0].error_code,'HTTP_429');
  assert.equal(rows.length,1);
  assert.ok(!JSON.stringify(rows).includes('SECRET'));
  assert.ok(!child.stderr.includes('SECRET'));
});

test('native confusion matrix preserves RULE_TERM before any versioned mapping', async () => {
  const { confusionReport } = await import('./baseline-report.mjs');
  const cases=[{case_id:'case-test',task:'stat_intent'}];
  const b=[{case_id:'case-test',native_prediction:'RULE_TERM',provider_status:'ok'}];
  const gold=[{case_id:'case-test',gold_label:'NARRATIVE'}];
  const split={cases:[{case_id:'case-test',split:'holdout'}]};
  const result=confusionReport(cases,b,gold,split,{version:'unmapped-v1',maps:{stat_intent:{RULE_TERM:null}}});
  assert.equal(result.tasks['stat_intent:holdout'].native_confusion.NARRATIVE.RULE_TERM,1);
  assert.equal(result.tasks['stat_intent:holdout'].unmapped,1);
  assert.equal(result.mapping_version,'unmapped-v1');
  assert.throws(()=>confusionReport(cases,b,[],split,{version:'v1',maps:{}}),/INCOMPLETE_JOIN/);
});
