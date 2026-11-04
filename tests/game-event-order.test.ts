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

test('half-inning transition preserves delayed changes on both teams and emits adjacent multi-change sequence', () => {
  const previous = state({ inning: 6, isTop: true });
  previous.boxScore!.awayPitchers = box(['올러']).homePitchers;
  const nextBox = box(['후라도', '이승민', '원태인']);
  nextBox.awayPitchers = box(['올러', '양현종']).homePitchers;
  const result = generateEvents(id, previous, live({ inning: 6, isTop: false }), nextBox);
  const changes = result.events.filter(e => e.type === 'pitching_change');
  assert.deepEqual(changes.map(e => [e.detail.team, e.detail.playerOut, e.detail.playerIn]),
    [['삼성', '후라도', '이승민'], ['삼성', '이승민', '원태인'], ['KIA', '올러', '양현종']]);
  assert.equal(new Set(changes.map(e => e.id)).size, 3);
  assert.ok(changes.every(e => e.detail.timing === 'observed' && e.text.includes('교체 이닝 미확인')));
  const again = generateEvents(id, result.nextState, live({ inning: 7, isTop: true }), nextBox);
  assert.equal(again.events.filter(e => e.type === 'pitching_change').length, 0);
});

test('same roster extension has inning-independent identities; corrupt and empty baselines never invent chains', () => {
  const a = generateEvents(id, state(), live({inning: 2}), box(['후라도','이승민','원태인']));
  const b = generateEvents(id, state(), live({inning: 3}), box(['후라도','이승민','원태인']));
  assert.deepEqual(a.events.filter(e=>e.type==='pitching_change').map(e=>e.id), b.events.filter(e=>e.type==='pitching_change').map(e=>e.id));
  for (const names of [['후라도','후라도','이승민'],['후라도','','이승민'],['후라도','올러','후라도']]) {
    assert.equal(generateEvents(id,state(),live(),box(names)).events.filter(e=>e.type==='pitching_change').length,0);
  }
  const empty = state();empty.boxScore=box([]);
  assert.equal(generateEvents(id,empty,live(),box(['후라도','이승민'])).events.filter(e=>e.type==='pitching_change').length,0);
});

const changes = (result: ReturnType<typeof generateEvents>) => result.events.filter(e => e.type === 'pitching_change');
const emptyBox = () => box([]);

test('empty tables preserve evidence without freezing score, outs or half-inning events', () => {
  const previous = state({inning: 8});
  const result = generateEvents(id, previous, live({inning: 8, awayScore: 1, outs: 1}), emptyBox());
  assert.deepEqual(result.nextState.boxScore, previous.boxScore);
  assert.ok(result.events.some(e => e.type === 'run_scored'));
  assert.ok(result.events.some(e => e.type === 'at_bat_out'));
  assert.equal(result.nextState.live.outs, 1);
  const next = generateEvents(id, result.nextState, live({inning:8,isTop:false,awayScore:1}), emptyBox());
  assert.ok(next.events.some(e => e.type === 'inning_start'));
});

test('live-only change requires stable name with game progress; outgoing pitcher is unknown', () => {
  const first = generateEvents(id, state(), live({currentPitcher:'이승민'}), emptyBox());
  assert.equal(changes(first).length, 0);
  const cached = generateEvents(id, first.nextState, live({currentPitcher:'이승민'}), emptyBox());
  assert.equal(changes(cached).length, 0);
  const confirmed = generateEvents(id, cached.nextState, live({currentPitcher:'이승민',balls:1}), emptyBox());
  assert.equal(changes(confirmed).length, 1);
  assert.equal(changes(confirmed)[0].detail.playerOut, undefined);
  assert.equal(changes(confirmed)[0].detail.team, '삼성');
  assert.match(changes(confirmed)[0].text, /교체 이닝 미확인/);
  assert.equal(changes(generateEvents(id, confirmed.nextState, live({currentPitcher:'이승민',balls:2}), emptyBox())).length, 0);
});

test('restored roster emits missed intermediate change but not previously live-confirmed incoming pitcher', () => {
  const first = generateEvents(id,state(),live({currentPitcher:'원태인'}),emptyBox());
  const second = generateEvents(id,first.nextState,live({currentPitcher:'원태인',strikes:1}),emptyBox());
  assert.equal(changes(second).length,1);
  const restored = generateEvents(id,second.nextState,live({currentPitcher:'원태인',strikes:1}),box(['후라도','이승민','원태인']));
  assert.deepEqual(changes(restored).map(e=>[e.detail.playerOut,e.detail.playerIn]),[['후라도','이승민']]);
  const again = generateEvents(id,restored.nextState,live({currentPitcher:'원태인',strikes:2}),emptyBox());
  assert.equal(changes(again).length,0);
});

test('both teams keep independent live-only observations across inning transitions', () => {
  const previous=state();previous.boxScore!.awayPitchers=box(['올러']).homePitchers;
  const a=generateEvents(id,previous,live({currentPitcher:'이승민'}),emptyBox());
  const b=generateEvents(id,a.nextState,live({currentPitcher:'이승민',balls:1}),emptyBox());
  const c=generateEvents(id,b.nextState,live({isTop:false,currentPitcher:'양현종'}),emptyBox());
  assert.equal(changes(c).length,0);
  const d=generateEvents(id,c.nextState,live({isTop:false,currentPitcher:'양현종',balls:1}),emptyBox());
  assert.equal(changes(d).length,0);
  const e=generateEvents(id,d.nextState,live({isTop:false,currentPitcher:'양현종',balls:2}),emptyBox());
  assert.equal(changes(e)[0]?.detail.team,'KIA');
  assert.deepEqual(e.nextState.livePitchers,{home:['이승민'],away:['양현종']});
});

test('single name flip, opposing pitcher, current batter and retired pitcher never announce changes', () => {
  for(const name of ['올러','김도영','후라도']) {
    const a=generateEvents(id,state(),live({currentPitcher:name}),emptyBox());
    assert.equal(changes(generateEvents(id,a.nextState,live({currentPitcher:name,balls:1}),emptyBox())).length,0);
  }
  const a=generateEvents(id,state(),live({currentPitcher:'이승민'}),emptyBox());
  const b=generateEvents(id,a.nextState,live({currentPitcher:'후라도',balls:1}),emptyBox());
  const c=generateEvents(id,b.nextState,live({currentPitcher:'이승민',balls:2}),emptyBox());
  assert.equal(changes(c).length,0);
});

test('missing roster at cold start does not manufacture a substitution from names alone', () => {
  const a=generateEvents(id,null,live(),emptyBox());
  const b=generateEvents(id,a.nextState,live({currentPitcher:'이승민'}),emptyBox());
  const c=generateEvents(id,b.nextState,live({currentPitcher:'이승민',balls:1}),emptyBox());
  assert.equal(changes(c).length,0);
});

test('missing box score reaches degraded detection through CAS and survives persisted JSON state', async () => {
  const mem=memoryStore({prev_state:{...state(),observedAt:1},event_history:[]});
  await commitGameEventObservation(mem.store,id,live({currentPitcher:'이승민'}),null,2,new AbortController().signal);
  const persisted=JSON.parse(JSON.stringify(mem.get()));
  const resumed=memoryStore(persisted);
  await Promise.all([3,4].map(observedAt=>commitGameEventObservation(resumed.store,id,
    live({currentPitcher:'이승민',balls:1}),null,observedAt,new AbortController().signal)));
  assert.equal(resumed.get()?.event_history?.filter(e=>e.type==='pitching_change').length,1);
  assert.deepEqual(resumed.get()?.prev_state?.boxScore,box());
});

test('empty batter table does not reset accumulated stats and replay hits on recovery', () => {
  const previous=state();
  previous.boxScore!.awayBatters=[{name:'김도영',hits:1,hr:0,h2b:0,h3b:0,bb:0,so:0,atBats:1} as never];
  const empty=generateEvents(id,previous,live(),emptyBox());
  const recovered=generateEvents(id,empty.nextState,live(),previous.boxScore);
  assert.equal(recovered.events.filter(e=>e.type.startsWith('at_bat')).length,0);
});

test('multiple live-only substitutions remain distinct and recovered roster does not duplicate either', () => {
  let prev=state();
  for(const [name,balls] of [['손동현',0],['손동현',1],['박영현',0],['박영현',1]] as const) {
    const result=generateEvents(id,prev,live({currentPitcher:name,balls}),emptyBox());
    assert.equal(changes(result).length,balls === 1 ? 1 : 0);
    prev=result.nextState;
  }
  const recovered=generateEvents(id,prev,live({currentPitcher:'박영현',balls:2}),box(['후라도','손동현','박영현']));
  assert.equal(changes(recovered).length,0);
});

test('opposing team live-confirmed pitcher cannot be mistaken for own replacement', () => {
  const prev=state();prev.livePitchers={away:['양현종']};
  const a=generateEvents(id,prev,live({currentPitcher:'양현종'}),emptyBox());
  const b=generateEvents(id,a.nextState,live({currentPitcher:'양현종',balls:1}),emptyBox());
  assert.equal(changes(b).length,0);
});
