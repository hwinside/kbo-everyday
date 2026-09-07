// Reviewer-run regression. In-memory PostgreSQL 17 only; no production connection.
// Runs the original poll guard and actual count-trigger migrations, demonstrates
// the broken comment INSERT, then applies the fix and checks preserved contracts.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const migration = (name) => readFile(new URL(`../../supabase/migrations/${name}`, import.meta.url), "utf8");
const db = new PGlite();
const checks = [];
async function pass(name, run) {
  await run();
  checks.push(name);
}
async function rejects(sql, code, name) {
  await pass(name, async () => {
    await assert.rejects(db.query(sql), (error) => error.code === code);
  });
}
async function counts(commentCount, likeCount, popularity) {
  const { rows } = await db.query("SELECT comment_count, like_count, popularity FROM posts WHERE id=1");
  assert.deepEqual(rows[0], { comment_count: commentCount, like_count: likeCount, popularity });
}

try {
  const version = await db.query("SHOW server_version_num");
  assert.equal(Math.floor(Number(version.rows[0].server_version_num) / 10000), 17);
  await db.exec(`
    CREATE ROLE authenticated;
    CREATE ROLE anon;
    CREATE TABLE public.posts (
      id bigint PRIMARY KEY,
      author_id uuid NOT NULL DEFAULT '11111111-1111-1111-1111-111111111111',
      board_type text NOT NULL, board_id text NOT NULL,
      title text NOT NULL, content text,
      team_tags jsonb NOT NULL DEFAULT '["hanwha"]',
      image_urls jsonb NOT NULL DEFAULT '[]',
      report_count integer NOT NULL DEFAULT 0,
      is_hidden boolean NOT NULL DEFAULT false,
      click_view_count integer NOT NULL DEFAULT 0,
      impression_view_count integer NOT NULL DEFAULT 0,
      comment_count integer NOT NULL DEFAULT 0,
      like_count integer NOT NULL DEFAULT 0,
      popularity integer GENERATED ALWAYS AS
        (coalesce(like_count,0)+coalesce(comment_count,0)) STORED,
      updated_at timestamptz NOT NULL DEFAULT now(),
      future_immutable_field text NOT NULL DEFAULT 'protected'
    );
    CREATE TABLE public.poll_polls (post_id bigint PRIMARY KEY REFERENCES posts(id));
    CREATE TABLE public.comments (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      post_id bigint NOT NULL REFERENCES posts(id), content text NOT NULL,
      like_count integer NOT NULL DEFAULT 0
    );
    CREATE TABLE public.likes (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      post_id bigint NOT NULL REFERENCES posts(id)
    );
    INSERT INTO posts (id,board_type,board_id,title,content)
      VALUES (1,'poll','poll','라인업송 좋은팀',''), (2,'free','free','일반 글','');
    INSERT INTO poll_polls VALUES (1);
    GRANT SELECT ON posts TO authenticated;
    GRANT UPDATE ON posts TO authenticated;
  `);
  await db.exec(await migration("20260728_poll_edit_title_content.sql"));
  await db.exec(await migration("20260730_fix_count_trigger_search_path.sql"));
  await db.exec(`
    CREATE TRIGGER poll_posts_edit_lock_trg BEFORE INSERT OR UPDATE ON posts
      FOR EACH ROW EXECUTE FUNCTION poll_posts_edit_lock();
    CREATE TRIGGER on_comment_change AFTER INSERT OR DELETE ON comments
      FOR EACH ROW EXECUTE FUNCTION update_comment_count();
    CREATE TRIGGER on_like_change AFTER INSERT OR DELETE ON likes
      FOR EACH ROW EXECUTE FUNCTION update_like_count();
  `);

  await rejects("INSERT INTO comments(post_id,content) VALUES (1,'한화')", "23514", "unpatched poll comment reproduces lock failure");
  await rejects("INSERT INTO likes(post_id) VALUES (1)", "23514", "unpatched poll like reproduces lock failure");
  await rejects("UPDATE posts SET is_hidden=is_hidden WHERE id=1", "23514", "unpatched no-op update reproduces lock failure");
  await pass("failed comment and counter both roll back", async () => {
    assert.equal((await db.query("SELECT count(*)::int AS n FROM comments WHERE post_id=1")).rows[0].n, 0);
    await counts(0, 0, 0);
  });
  await pass("unpatched ordinary-post comment remains writable", async () => {
    await db.query("INSERT INTO comments(post_id,content) VALUES (2,'일반 댓글')");
    assert.equal((await db.query("SELECT comment_count FROM posts WHERE id=2")).rows[0].comment_count, 1);
  });

  const fix = await migration("20260907103000_poll_generated_popularity_guard.sql");
  await db.exec(fix);
  await pass("same poll comment persists with derived count", async () => {
    await db.query("INSERT INTO comments(post_id,content) VALUES (1,'한화')");
    await counts(1, 0, 1);
    assert.equal((await db.query("SELECT content FROM comments WHERE post_id=1")).rows[0].content, "한화");
  });
  await pass("second comment then delete stays consistent", async () => {
    await db.query("INSERT INTO comments(post_id,content) VALUES (1,'두 번째')");
    await counts(2, 0, 2);
    await db.query("DELETE FROM comments WHERE post_id=1 AND content='두 번째'");
    await counts(1, 0, 1);
  });
  await pass("like insertion and deletion recompute popularity", async () => {
    await db.query("INSERT INTO likes(post_id) VALUES (1)");
    await counts(1, 1, 2);
    await db.query("DELETE FROM likes WHERE post_id=1");
    await counts(1, 0, 1);
  });
  await pass("no-op and moderation updates preserve counters and edit time", async () => {
    const before = (await db.query("SELECT updated_at FROM posts WHERE id=1")).rows[0].updated_at;
    await db.query("UPDATE posts SET is_hidden=is_hidden WHERE id=1");
    await db.query("UPDATE posts SET report_count=report_count+1,is_hidden=true WHERE id=1");
    const after = (await db.query("SELECT report_count,is_hidden,updated_at FROM posts WHERE id=1")).rows[0];
    assert.equal(after.report_count, 1);
    assert.equal(after.is_hidden, true);
    assert.deepEqual(after.updated_at, before);
    await counts(1, 0, 1);
  });
  await pass("valid poll title/content editing remains allowed", async () => {
    await db.query("UPDATE posts SET title='수정한 질문',content='설명' WHERE id=1");
    assert.equal((await db.query("SELECT title FROM posts WHERE id=1")).rows[0].title, "수정한 질문");
  });
  await rejects("UPDATE posts SET title='' WHERE id=1", "23514", "empty question still rejected");
  await rejects("UPDATE posts SET title=repeat('가',201) WHERE id=1", "23514", "long question still rejected");
  await rejects("UPDATE posts SET content=repeat('가',2001) WHERE id=1", "23514", "long description still rejected");
  await rejects("UPDATE posts SET board_type='free' WHERE id=1", "23514", "poll type remains immutable");
  await rejects("UPDATE posts SET board_id='free' WHERE id=1", "23514", "poll board remains immutable");
  await rejects("UPDATE posts SET team_tags='[\"lg\"]' WHERE id=1", "23514", "team scope remains immutable");
  await rejects("UPDATE posts SET image_urls='[\"https://example.invalid/test.png\"]' WHERE id=1", "23514", "media remains immutable");
  await rejects("UPDATE posts SET future_immutable_field='changed' WHERE id=1", "23514", "unlisted future fields remain immutable");
  await rejects("UPDATE posts SET popularity=999 WHERE id=1", "428C9", "derived score cannot be forged");
  await db.exec("SET ROLE authenticated");
  try {
    await rejects("UPDATE posts SET comment_count=999 WHERE id=1", "42501", "authenticated direct counter edit remains forbidden");
    await rejects("UPDATE posts SET report_count=0 WHERE id=1", "42501", "authenticated direct report count edit remains forbidden");
    await rejects("UPDATE posts SET is_hidden=false WHERE id=1", "42501", "authenticated direct hidden state edit remains forbidden");
  } finally {
    await db.exec("RESET ROLE");
  }
  await pass("ordinary-post updates remain unaffected", async () => {
    await db.query("UPDATE posts SET future_immutable_field='allowed' WHERE id=2");
  });
  await pass("a future generated column does not break existing poll writes", async () => {
    await db.exec("ALTER TABLE posts ADD COLUMN future_generated_score integer GENERATED ALWAYS AS (comment_count * 2 + like_count) STORED");
    await db.query("INSERT INTO comments(post_id,content) VALUES (1,'생성 컬럼 회귀')");
    await counts(2, 0, 2);
    assert.equal((await db.query("SELECT future_generated_score FROM posts WHERE id=1")).rows[0].future_generated_score, 4);
    await db.query("DELETE FROM comments WHERE post_id=1 AND content='생성 컬럼 회귀'");
    await counts(1, 0, 1);
  });
  await rejects("UPDATE posts SET future_immutable_field='changed' WHERE id=1", "23514", "future ordinary fields stay locked after generated-column addition");
  await pass("migration reapplication and final deletion are safe", async () => {
    await db.exec(fix);
    await db.query("DELETE FROM comments WHERE post_id=1");
    await counts(0, 0, 0);
  });
  console.log(JSON.stringify({ backend: "PGlite PostgreSQL 17", passed: checks.length, checks }, null, 2));
} finally {
  await db.close();
}
