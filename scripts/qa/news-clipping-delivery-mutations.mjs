// Mutate SQL copies, never restore/reset a developer's worktree.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
const file='supabase/migrations/20260909110000_news_clipping_atomic_delivery.sql';
const source=fs.readFileSync(file,'utf8');
const dir=fs.mkdtempSync(path.join(process.env.OPENCLAW_REVIEW_ROOT||process.env.RUNNER_TEMP||os.tmpdir(),'clipping-sql-mutants-'));
const messageInsert=`    INSERT INTO public.dm_messages (conversation_id, sender_id, content, payload, created_at)
    VALUES (v_conversation, p_sender_id, p_content, v_payload, v_now);`;
const mutations=[
 ['server timeout removed', "SET statement_timeout = '15s'", ''],
 ['batch cap widened', 'p_limit NOT BETWEEN 1 AND 200', 'p_limit NOT BETWEEN 1 AND 400'],
 ['missing message',messageInsert,'    PERFORM 1;'],
 ['swallowed message failure',messageInsert,`    BEGIN
${messageInsert}
    EXCEPTION WHEN OTHERS THEN NULL;
    END;`],
 ['historical resend',"p_clip_date IS DISTINCT FROM (now() AT TIME ZONE 'Asia/Seoul')::date",'false'],
 ['opt-out ignored','      AND coalesce(n.news_clipping, true)','      AND true'],
 ['public RPC', 'FROM PUBLIC, anon, authenticated;', 'FROM anon, authenticated;'],
 ['idempotency conflict removed','    ON CONFLICT (clip_date, user_id) DO NOTHING;','    ;'],
];
const run=(sql,label)=>{
 const target=path.join(dir,label+'.sql');fs.writeFileSync(target,sql);
 const p=spawnSync(process.execPath,['node_modules/tsx/dist/cli.mjs','scripts/qa/news-clipping-delivery.ts'],{
   env:{...process.env,NEWS_CLIPPING_SQL_PATH:target},encoding:'utf8',timeout:120000,
 });
 fs.writeFileSync(path.join(dir,label+'.log'),(p.stdout||'')+(p.stderr||''));
 if(p.error||p.signal)throw new Error('Gate execution failed: '+label);
 return p.status;
};
if(run(source,'baseline')!==0)throw new Error('Baseline must pass before mutations; evidence '+dir);
let detected=0;
for(let i=0;i<mutations.length;i++){
 const [label,from,to]=mutations[i];
 if(source.split(from).length!==2)throw new Error('Missing or ambiguous mutation anchor: '+label);
 const exit=run(source.replace(from,to),'m'+(i+1));
 if(exit===0)throw new Error('Undetected mutation: '+label+'; evidence '+dir);
 detected++;console.log('RED '+label);
}
console.log(`Atomic clipping SQL mutations detected ${detected}/${mutations.length}; logs ${dir}`);
