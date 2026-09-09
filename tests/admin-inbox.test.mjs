import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const system = '00000000-0000-4000-8000-000000000001';
const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('admin inbox projection and global read boundary (isolated PostgreSQL)', async () => {
  const db = new PGlite();
  const migration = readFileSync('supabase/migrations/20260909110000_admin_inbox_broadcast_read_all.sql', 'utf8');
  try {
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE profiles (id UUID PRIMARY KEY, nickname TEXT, team_id INT);
      CREATE TABLE dm_conversations (
        id UUID PRIMARY KEY, user1_id UUID, user2_id UUID, origin TEXT DEFAULT 'dm',
        last_message TEXT, last_message_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE TABLE dm_messages (
        id UUID PRIMARY KEY, conversation_id UUID REFERENCES dm_conversations(id),
        sender_id UUID, content TEXT, image_urls TEXT[] DEFAULT '{}',
        dedup_key TEXT, created_at TIMESTAMPTZ DEFAULT now(), is_read BOOLEAN DEFAULT FALSE
      );
    `);
    // Include the production unread function, not a test-side reimplementation.
    const old = readFileSync('supabase/migrations/20260727_auth_user_delete_cascades.sql', 'utf8');
    await db.exec(old.slice(old.indexOf('CREATE OR REPLACE FUNCTION public.admin_dm_unread_total('), old.indexOf('ALTER TABLE public.feedback')));
    await db.exec(migration);
    await db.exec(migration); // deployment retry must be safe
    let mid = 10000;
    async function conversation(id, user1, user2, origin = 'dm') {
      await db.query('INSERT INTO dm_conversations (id,user1_id,user2_id,origin,last_message,last_message_at) VALUES ($1,$2,$3,$4,$5,$6)',
        [uid(id), user1, user2, origin, 'broadcast shared preview', '2026-09-09T10:00:00Z']);
    }
    async function message(cid, sender, content, at, dedup = null, images = []) {
      const id = uid(mid++);
      await db.query('INSERT INTO dm_messages (id,conversation_id,sender_id,content,created_at,dedup_key,image_urls) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [id,uid(cid),sender,content,at,dedup,images]);
      return id;
    }
    const before = '2026-09-08T00:00:00Z';
    const broadcastAt = '2026-09-09T10:00:00Z';
    // 120 broadcast-only rows, including feedback origin, cannot consume a page slot.
    for (let i = 100; i < 220; i++) {
      await conversation(i, system, uid(i + 1000), i === 100 ? 'feedback' : 'dm');
      await message(i, system, 'announcement', broadcastAt, `admin-broadcast:job:${i}`);
    }
    // 65 mixed conversations across both user positions; identical times exercise UUID cursors.
    for (let i = 300; i < 365; i++) {
      await conversation(i, i % 2 ? uid(i + 1000) : system, i % 2 ? system : uid(i + 1000));
      await message(i, uid(i + 1000), `individual ${i}`, before);
      await message(i, system, 'announcement', broadcastAt, `admin-broadcast:job:${i}`);
    }
    await conversation(400, system, uid(1400), 'feedback');
    await message(400, system, 'feedback reply', before);
    await message(400, system, 'announcement', broadcastAt, 'admin-broadcast:job:400');
    // A later direct reply must remain visible; a photo-only message gets its proper preview.
    await message(301, system, 'personal reply', '2026-09-08T02:00:00Z');
    await message(302, uid(1302), '', '2026-09-08T03:00:00Z', null, ['https://example.test/image.png']);
    // Deleted-user messages keep their unread status and the deleted-user label.
    await conversation(401, null, system);
    await message(401, null, 'deleted user question', before);
    // Non-broadcast system notices must not be filtered by a content heuristic.
    await message(303, system, 'announcement', '2026-09-08T01:00:00Z', 'blind-notice:303');
    await conversation(500, uid(1500), uid(1501));
    const foreign = await message(500, uid(1500), 'private user conversation', before);
    const snapshots = await db.query('SELECT * FROM dm_conversations ORDER BY id');
    const outboundBefore = await db.query('SELECT id,is_read FROM dm_messages WHERE sender_id=$1 ORDER BY id', [system]);
    const totalBefore = Number((await db.query('SELECT admin_dm_unread_total($1) AS n', [system])).rows[0].n);
    assert.equal(totalBefore, 67);

    await db.exec('SET ROLE service_role');
    async function page(at = null, id = null, limit = 50) {
      return (await db.query('SELECT * FROM admin_dm_inbox_page($1,$2,$3,$4)', [system,at,id,limit])).rows;
    }
    const first = await page();
    assert.equal(first.length, 50);
    assert.equal(first[0].id, uid(302));
    assert.equal(first[0].last_message, '[사진]');
    assert.equal(first[1].last_message, 'personal reply');
    assert.equal(first[2].last_message, 'announcement');
    const tail = first.at(-1);
    const second = await page(tail.last_message_at, tail.id);
    const all = [...first, ...second];
    assert.equal(all.length, 67);
    assert.equal(new Set(all.map(row => row.id)).size, 67);
    assert.ok(all.every(row => !row.last_message.startsWith('broadcast')));
    assert.ok(all.every(row => Number(row.id.slice(-12)) >= 300));
    assert.equal(all.find(row => row.id === uid(401)).other_nickname, '탈퇴한 사용자');
    assert.equal(Number(all.find(row => row.id === uid(300)).sys_msg_count), 0);
    assert.equal(all.find(row => row.id === uid(400)).last_message, 'feedback reply');
    const updated = await db.query('SELECT admin_dm_mark_all_read($1) AS n', [system]);
    assert.equal(Number(updated.rows[0].n), 67);
    assert.equal(Number((await db.query('SELECT admin_dm_mark_all_read($1) AS n', [system])).rows[0].n), 0);
    assert.ok((await page(null,null,1000)).every(row => Number(row.unread_count) === 0));
    await db.exec('RESET ROLE');
    assert.equal(Number((await db.query('SELECT admin_dm_unread_total($1) AS n', [system])).rows[0].n), 0);
    assert.equal((await db.query('SELECT is_read FROM dm_messages WHERE id=$1', [foreign])).rows[0].is_read, false);
    assert.deepEqual((await db.query('SELECT id,is_read FROM dm_messages WHERE sender_id=$1 ORDER BY id', [system])).rows, outboundBefore.rows);
    assert.deepEqual((await db.query('SELECT * FROM dm_conversations ORDER BY id')).rows, snapshots.rows);
    // A message arriving after the bulk statement stays unread; no sticky conversation flag.
    await message(300, uid(1300), 'new arrival', '2026-09-09T11:00:00Z');
    assert.equal(Number((await db.query('SELECT admin_dm_unread_total($1) AS n', [system])).rows[0].n), 1);
    assert.equal((await page())[0].last_message, 'new arrival');
    await assert.rejects(db.query('SELECT admin_dm_mark_all_read(NULL)'), /missing system user/);
    // Actual non-superuser calls must fail, not only privilege metadata inspection.
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`SET ROLE ${role}`);
      await assert.rejects(db.query('SELECT admin_dm_mark_all_read($1)', [system]), /permission denied/);
      await assert.rejects(db.query('SELECT * FROM admin_dm_inbox_page($1)', [system]), /permission denied/);
      await db.exec('RESET ROLE');
    }
    // A forced database failure rolls the complete bulk update back.
    await message(301, uid(1301), 'fail sentinel', broadcastAt);
    await db.exec(`CREATE FUNCTION reject_read() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.content = 'fail sentinel' AND NEW.is_read THEN RAISE EXCEPTION 'forced failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_read BEFORE UPDATE ON dm_messages FOR EACH ROW EXECUTE FUNCTION reject_read();`);
    await assert.rejects(db.query('SELECT admin_dm_mark_all_read($1)', [system]), /forced failure/);
    assert.equal(Number((await db.query('SELECT admin_dm_unread_total($1) AS n', [system])).rows[0].n), 2);
    // No user-facing records, previews, recipients' reads, or broadcast copies were deleted.
    assert.equal(Number((await db.query("SELECT count(*) AS n FROM dm_messages WHERE dedup_key LIKE 'admin-broadcast:%'")).rows[0].n), 186);
  } finally {
    await db.close();
  }
});
