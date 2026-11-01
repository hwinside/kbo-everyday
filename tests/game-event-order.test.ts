import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateEvents, type PrevGameState } from '../src/lib/event-generator';
import { commitGameEventObservation, type EventStateRow, type EventStateStore } from '../src/lib/game-event-commit';
import type { LiveGameData } from '../src/lib/hooks/useLiveGame';

const id = '20261101HTSS0';
const live = (patch: Partial<LiveGameData> = {}): LiveGameData => ({
  gameId: id, awayName: 'KIA', homeName: '삼성', awayScore: 0, homeScore: 0,
  inning: 1, isTop: true, balls: 0, strikes: 0, outs: 0,
  runner1b: false, runner2b: false, runner3b: false,
  runner1bName: null, runner2bName: null, runner3bName: null,
  currentBatter: '김도영', currentPitcher: '후라도', currentInning: '1회초',
  stadium: '대구', status: 'live', isLive: true, awayStarterName: '올러', homeStarterName: '후라도',
  ...patch,
});
const box = (names = ['후라도']): NonNullable<PrevGameState['boxScore']> => ({
  awayBatters: [], homeBatters: [], awayPitchers: [],
  homePitchers: names.map(name => ({ name, inningsPitched: '1', decision: '', battersFaced: 0,
    pitchCount: 0, atBats: 0, hits: 0, hr: 0, walks: 0, strikeouts: 0, runs: 0, earnedRuns: 0, era: '0.00' })),
});
const state = (patch: Partial<LiveGameData> = {}): PrevGameState => ({ live: live(patch), boxScore: box() });

test('PO5 half-inning reversal cannot emit or replace baseline; legitimate advance works', () => {
  const previous = state({ isTop: false });
  const reversed = generateEvents(id, previous, live(), box());
  assert.equal(reversed.nextState, previous);
  assert.deepEqual(reversed.events, []);
  const advanced = generateEvents(id, previous, live({ inning: 2 }), box());
  assert.deepEqual(advanced.events.filter(e => e.type.startsWith('inning_')).map(e => e.type), ['inning_end', 'inning_start']);
});

test('live name flips cannot invent substitution; ordered same-team roster extension can', () => {
  assert.equal(generateEvents(id, state(), live({ currentPitcher: '올러' }), box()).events.some(e => e.type === 'pitching_change'), false);
  const next = generateEvents(id, state(), live({ currentPitcher: '이승민' }), box(['후라도', '이승민']));
  assert.equal(next.events.filter(e => e.type === 'pitching_change').length, 1);
  const reverse = generateEvents(id, next.nextState, live({ currentPitcher: '후라도' }), box(['후라도', '이승민']));
  assert.equal(reverse.events.some(e => e.type === 'pitching_change'), false);
  const staleRoster = generateEvents(id, next.nextState, live(), box());
  assert.equal(staleRoster.nextState, next.nextState);
  assert.equal(generateEvents(id, state(), live({ currentPitcher: '이승민' }), box(['올러', '이승민'])).events.some(e => e.type === 'pitching_change'), false);
});

test('PO5 third out does not attribute retired batter to stale previous currentBatter', () => {
  const result = generateEvents(id, state({ outs: 2 }), live({ outs: 3, currentBatter: '카스트로' }), box());
  const out = result.events.find(e => e.type === 'at_bat_out');
  assert.ok(out);
  assert.equal(out.detail.batter, undefined);
  assert.equal(out.text.includes('김도영'), false);
});

test('final state cannot reopen, while official score correction is accepted', () => {
  const previous = state({ status: 'final', isLive: false, inning: 9 });
  assert.equal(generateEvents(id, previous, live({ inning: 9 }), box()).nextState, previous);
  const corrected = generateEvents(id, state({ awayScore: 1 }), live({ awayScore: 0 }), box());
  assert.equal(corrected.nextState.live.awayScore, 0);
});

function memoryStore(initial: EventStateRow | null) {
  let row = initial;
  const store: EventStateStore = {
    async read() { return structuredClone(row); },
    async replace(expected, next) {
      if (JSON.stringify(expected?.prev_state ?? null) !== JSON.stringify(row?.prev_state ?? null)) return false;
      // Yielding reads above let multiple writers race with the same baseline.
      row = structuredClone(next);
      return true;
    },
  };
  return { store, get: () => row };
}

test('concurrent writers recompute on CAS conflict; late response cannot revert history or state', async () => {
  const mem = memoryStore({ prev_state: { ...state(), observedAt: 1 }, event_history: [] });
  await Promise.all([
    commitGameEventObservation(mem.store, id, live({ outs: 1 }), box(), 2, new AbortController().signal),
    commitGameEventObservation(mem.store, id, live({ outs: 2 }), box(), 3, new AbortController().signal),
  ]);
  assert.equal(mem.get()?.prev_state?.live.outs, 2);
  assert.equal(mem.get()?.event_history?.length, 2);
  const before = structuredClone(mem.get());
  await commitGameEventObservation(mem.store, id, live(), box(), 2, new AbortController().signal);
  assert.deepEqual(mem.get(), before);
});

test('no-event observations advance baseline and missing box score does not erase evidence', async () => {
  const mem = memoryStore({ prev_state: { ...state(), observedAt: 1 }, event_history: [] });
  const result = await commitGameEventObservation(mem.store, id, live({ balls: 1 }), null, 2, new AbortController().signal);
  assert.equal(result.prev_state?.live.balls, 1);
  assert.deepEqual(result.prev_state?.boxScore, box());
  assert.equal(result.prev_state?.observedAt, 2);
});

test('write failure cannot return uncommitted events as success', async () => {
  const mem = memoryStore({ prev_state: state(), event_history: [] });
  mem.store.replace = async () => { throw new Error('storage unavailable'); };
  await assert.rejects(commitGameEventObservation(mem.store, id, live({ outs: 1 }), box(), 2, new AbortController().signal), /storage unavailable/);
  assert.deepEqual(mem.get()?.event_history, []);
});


test('box-score-before-live pitcher update emits once, not permanently lost', () => {
  const first = generateEvents(id, state(), live(), box(['후라도', '이승민']));
  const change = first.events.filter(e => e.type === 'pitching_change');
  assert.equal(change.length, 1);
  assert.equal(change[0].detail.playerOut, '후라도');
  assert.equal(change[0].detail.playerIn, '이승민');
  assert.equal(change[0].snapshot.pitcher, '이승민');
  const second = generateEvents(id, first.nextState, live({currentPitcher:'이승민'}), box(['후라도','이승민']));
  assert.equal(second.events.filter(e => e.type === 'pitching_change').length, 0);
});
