import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EventStateRow } from '../src/lib/game-event-commit';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://events-state.test';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-only';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-only';

test('real GET uses conditional state write, and never returns a rejected late snapshot', async () => {
  const { NextRequest } = await import('next/server');
  const { GET } = await import('../src/app/api/game-events/route');
  const originalFetch = globalThis.fetch;
  const gameId = '20260901HTSS0';
  const db: { row: EventStateRow | null } = { row: null };
  let patches = 0;
  let inning = 2;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.endsWith('GetKboGameList')) return Response.json({ code: '100', game: [{
      G_ID: gameId, SR_ID: '0', GAME_STATE_SC: '2', CANCEL_SC_ID: '0',
      AWAY_NM: 'KIA', HOME_NM: '삼성', GAME_INN_NO: inning, GAME_TB_SC: 'T',
      T_SCORE_CN: '1', B_SCORE_CN: '3', OUT_CN: 0,
    }] });
    if (url.pathname.endsWith('GetBoxScore')) return Response.json({ tables: [[], [], [], [], []] });
    if (url.hostname === 'events-state.test' && url.pathname.endsWith('/game_event_state')) {
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      if (method === 'GET') return Response.json(db.row);
      const body = JSON.parse(String(init?.body));
      if (method === 'POST') { assert.equal(db.row, null); db.row = body; return new Response(null, { status: 201 }); }
      if (method === 'PATCH') {
        patches++;
        if (db.row!.prev_state!.revision) {
          assert.equal(url.searchParams.get('prev_state->>revision'), `eq.${db.row!.prev_state!.revision}`);
        } else {
          assert.equal(url.searchParams.get('prev_state->>revision'), 'is.null');
          assert.equal(url.searchParams.get('updated_at'), `eq.${db.row!.updated_at}`);
        }
        assert.equal(url.searchParams.has('prev_state'), false, 'full boxscore must not inflate URL');
        assert.ok(url.href.length < 500);
        db.row = { ...db.row, ...body };
        return Response.json([{ game_id: gameId }]);
      }
    }
    // Optional Naver fallback unavailable; no real network allowed.
    return new Response(null, { status: 503 });
  }) as typeof fetch;
  try {
    const request = () => GET(new NextRequest(`https://test.local/api/game-events?gameId=${gameId}`));
    const first = await request();
    assert.equal(first.status, 200);
    assert.equal(db.row!.prev_state!.live.inning, 2);
    const initialRevision = db.row!.prev_state!.revision;
    delete db.row!.prev_state!.revision; // Existing production row before rollout.
    await new Promise(resolve => setTimeout(resolve, 5));
    const second = await request();
    assert.equal(second.status, 200);
    assert.equal(patches, 1, 'even no-event observations persist the new baseline');
    assert.notEqual(db.row!.prev_state!.revision, initialRevision);
    // A late request must return the committed state, not old currentLive.
    db.row!.prev_state!.observedAt = Date.now() + 60_000;
    db.row!.prev_state!.live.awayScore = 2;
    inning = 1;
    const late = await (await request()).json();
    assert.equal(late.currentState.awayScore, 2);
    assert.equal(patches, 1);
  } finally { globalThis.fetch = originalFetch; }
});
