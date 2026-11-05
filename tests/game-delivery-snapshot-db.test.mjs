import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

test('durable snapshots: isolation, monotonic fences, rejection and final archive', async () => {
  const db = new PGlite();
  const id = '20261103SSKT0';
  try {
    await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;');
    const sql = readFileSync('supabase/migrations/20261101130000_game_delivery_snapshots.sql', 'utf8');
    await db.exec(sql); await db.exec(sql);
    const now = Date.now();
    async function write(channel, payload, epoch=1, ordinal=1, at=now) {
      const result = await db.query('select publish_game_delivery_snapshot($1,$2,$3,$4,$5,$6) as ok',
        [id,channel,JSON.stringify(payload),new Date(at).toISOString(),epoch,ordinal]);
      return result.rows[0].ok;
    }
    const linescore={away:{R:1},home:{R:6}};
    const relay = { gameId:id, innings:[{inning:1}],linescore };
    assert.equal(await write('relay',relay), true);
    assert.equal(await write('relay',{...relay,bad:true},1,1), false);
    assert.equal(await write('relay',{...relay,bad:true},0,999), false);
    assert.equal(await write('relay',{...relay,bad:true},2,1,now-1000), false);
    assert.equal(await write('relay',{...relay,degraded:true},2,1), false);
    assert.equal(await write('relay',{...relay,partial:true},2,1), false);
    assert.equal(await write('relay',{...relay,gameId:'20261104SSKT0'},2,1), false);
    assert.equal(await write('relay',relay,2,1,now+60000), false);
    assert.equal(await write('events',{events:[],currentState:null}), false);
    assert.equal(await write('events',{events:[{gameId:'20261104SSKT0'}],currentState:{inning:9,awayScore:1,homeScore:6}}), false);
    assert.equal(await write('events',{events:[{gameId:id}],currentState:{inning:9,awayScore:1,homeScore:6}}), true);
    assert.equal(await write('live',{games:[{gameId:'20261104SSKT0'}]}), false);
    assert.equal(await write('live',{games:[{gameId:id,status:'final',awayScore:1,homeScore:6,linescore,boxScore:{}}]}), true);
    assert.equal(await write('detail',{gameId:id,status:'final',awayScore:1,homeScore:6,linescore,boxScore:{}}), true);
    const archive = async () => (await db.query('select archive_game_delivery_snapshot($1) as ok',[id])).rows[0].ok;
    assert.equal(await archive(), false, 'no premature final archive');
    await db.query("update game_delivery_snapshots set final_seen_at = now() - interval '11 minutes' where channel='detail'");
    await db.query("update game_delivery_snapshots set observed_at = now() - interval '12 minutes' where channel='events'");
    assert.equal(await archive(), false, 'all channels must have final observations');
    await db.query("update game_delivery_snapshots set observed_at = now() where channel='events'");
    await db.query(`update game_delivery_snapshots set payload=jsonb_set(payload,'{currentState,homeScore}','5') where channel='events'`);
    assert.equal(await archive(),false,'conflicting final scores must not archive');
    await db.query(`update game_delivery_snapshots set payload=jsonb_set(payload,'{currentState,homeScore}','6') where channel='events'`);
    assert.equal(await archive(), true);
    assert.equal((await db.query('select count(*)::int n from game_delivery_snapshots where archived_at is not null')).rows[0].n,4);
    assert.equal(await archive(),true,'idempotent archive');
    await db.exec('SET ROLE anon');
    await assert.rejects(db.query('select * from game_delivery_snapshots'), /permission denied/);
    await assert.rejects(db.query('select archive_game_delivery_snapshot($1)',[id]), /permission denied/);
    await db.exec('RESET ROLE; SET ROLE service_role');
    assert.equal((await db.query('select count(*)::int n from game_delivery_snapshots')).rows[0].n,4);
  } finally { await db.close(); }
});
