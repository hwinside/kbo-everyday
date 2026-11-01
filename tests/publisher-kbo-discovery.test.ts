import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NextRequest } from 'next/server';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://publisher.test';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-only';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-only';

import type { FrameRow, TickDeps } from '../src/lib/game/relay-live-publisher';

// Imports hoist above the env assignments above, and the publisher module
// transitively constructs the Supabase admin client at import time. Load it
// lazily so the test env is already in place.
const publisher = () => import('../src/lib/game/relay-live-publisher');

// Regular-season date: filterNeededPostseasonGames short-circuits, so the only
// upstream this test needs to stub is the KBO scoreboard.
const DATE = '20260901';
const LIVE_ID = '20260901HTSS0';

function kboGame(overrides: Record<string, string>) {
  return {
    G_ID: LIVE_ID, SR_ID: '0', GAME_STATE_SC: '2', CANCEL_SC_ID: '0',
    AWAY_NM: 'KIA', HOME_NM: '삼성', ...overrides,
  };
}

/**
 * 삼식 요청(2026-10-28): 퍼블리셔가 KBO 경로로 경기를 찾았을 때 프레임 INSERT까지
 * 실제로 도달하는지. 경기 탐색(listLiveGameIds)만 통과하고 INSERT가 0건이면
 * Realtime 경로가 죽은 것이므로, 두 단계를 한 테스트에서 이어서 확인한다.
 */
test('KBO discovery feeds a real frame INSERT', async () => {
  const original = globalThis.fetch;
  let naverCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('naver')) { naverCalls++; throw new Error('naver must not be needed'); }
    if (url.includes('GetKboGameList')) {
      return Response.json({ code: '100', game: [
        kboGame({}),
        kboGame({ G_ID: '20260901LTOB0', GAME_STATE_SC: '1' }),
        kboGame({ G_ID: '20260901WOSK0', CANCEL_SC_ID: '1' }),
      ] });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  try {
    const { listLiveGameIds, publishGameTick, newGameState } = await publisher();
    const ids = await listLiveGameIds(DATE);
    assert.deepEqual(ids, [LIVE_ID], 'only the live, non-cancelled KBO game is published');
    assert.equal(naverCalls, 0, 'a healthy KBO response must not fall back to Naver');

    const relayBody = {
      gameId: LIVE_ID, source: 'kbo', currentInning: 3, updatedAt: '2026-09-01T10:00:00.000Z',
      innings: [{ inning: 3, half: 'top', teamName: 'KIA', plays: [{ batterName: '김도영', result: '안타', type: 'hit' }] }],
    };
    const inserted: FrameRow[] = [];
    const handler = async () => Response.json(relayBody);
    const deps: TickDeps = {
      handlers: { relay: handler as unknown as (req: NextRequest) => Promise<Response>, events: handler as never, live: handler as never, detail: handler as never },
      insertFrame: async (row: FrameRow) => { inserted.push(row); return 'inserted'; },
      epoch: 7,
      date: DATE,
    };

    // tickIndex 1 publishes the relay channel only — the minimum path that must reach the table.
    const result = await publishGameTick(deps, newGameState(), ids[0], 1);

    assert.equal(result.inserted, 1, 'discovery must end in a committed frame, not just a found game');
    assert.deepEqual(result.errors, []);
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0].game_id, LIVE_ID, 'the inserted frame carries the discovered gameId');
    assert.equal(inserted[0].channel, 'relay');
    assert.equal(inserted[0].kind, 'relay-full', 'a KBO-sourced relay frame is published in full');
    assert.equal(inserted[0].epoch, 7);
    assert.equal((inserted[0].payload.data as { gameId: string }).gameId, LIVE_ID);
  } finally {
    globalThis.fetch = original;
  }
});

test('a failed KBO discovery throws instead of silently publishing nothing', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ code: '500' }, { status: 500 })) as typeof fetch;
  try {
    const { listLiveGameIds } = await publisher();
    await assert.rejects(listLiveGameIds(DATE), /publisher game discovery failed/);
  } finally {
    globalThis.fetch = original;
  }
});
