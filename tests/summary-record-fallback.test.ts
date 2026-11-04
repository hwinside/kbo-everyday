import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildRecordSummary, hasFalseShutoutClaim, hasFalsePitcherInnings, hasVerifiedPitcherClaims } from '../src/lib/game-summary/record-fallback';
import { hasUnsupportedPlayerInning } from '../src/lib/game-summary/inning-claims';
const facts = [{ name: '후라도', ip: '7', r: 1, er: 0 }];
test('PO5 1 run/0 earned is not a shutout, including MVP implied subject', () => {
  for (const summary of [{ insight: '후라도의 무실점 피칭' }, { mvpPitcher: { name: '후라도', reason: '단 1점도 내주지 않았다.' } }]) {
    assert.equal(hasFalseShutoutClaim(summary, facts), true);
  }
  assert.equal(hasFalseShutoutClaim({ insight: '후라도는 7이닝 1실점 0자책을 기록했다.' }, facts), false);
  assert.equal(hasFalseShutoutClaim({ insight: '후라도 무실점' }, [{ ...facts[0], r: 0 }]), false);
  assert.equal(hasVerifiedPitcherClaims({ insight: '후라도 무실점', _verifiedPitcherFacts: facts }), false);
});
test('record fallback uses team inning totals only, without player attribution or guessed cause', () => {
  const summary = buildRecordSummary({ awayTeam: 'KIA', homeTeam: '삼성', awayScore: 1, homeScore: 6,
    linescore: { away: { innings: [0,0,1,0,0,0,0,0,0] }, home: { innings: [1,3,0,0,0,2,0,0,null] } } });
  assert.equal(summary.headline, '삼성, KIA에 6:1 승리');
  assert.equal(hasUnsupportedPlayerInning(summary, ['후라도', '김지찬']), false);
  assert.match(JSON.stringify(summary), /4~6회 득점은 KIA 0점, 삼성 2점/);
  assert.equal(summary.mvpPitcher, undefined);
});

test('pitching innings and unnamed team pitching-change inning are not guessed', () => {
  assert.equal(hasFalsePitcherInnings({ mvpPitcher: { name: '후라도', stats: '6이닝 1실점' } }, facts), true);
  assert.equal(hasFalsePitcherInnings({ mvpPitcher: { name: '후라도', stats: '7이닝 1실점' } }, facts), false);
  assert.equal(hasUnsupportedPlayerInning({ gameFlow: { late: '삼성은 7회부터 마운드를 교체했다.' } }, ['후라도']), true);
});


test('extra-inning record preserves all runs and ignores unplayed trailing cells', () => {
  const summary = buildRecordSummary({ awayTeam: '삼성', homeTeam: 'KT', awayScore: 3, homeScore: 2,
    linescore: { away: { innings: [1,0,0,0,0,0,0,0,0,1,0,1,null] },
      home: { innings: [0,1,0,0,0,0,0,0,0,1,0,0,null] } } });
  const flow = summary.gameFlow as Record<string, string>;
  assert.equal(flow.extra, '10~12회 득점은 삼성 2점, KT 1점입니다.');
  assert.match(flow.early, /삼성 1점, KT 1점/);
  assert.equal(hasUnsupportedPlayerInning(summary, ['원태인']), false);
  assert.equal(hasUnsupportedPlayerInning({ headline: '연장 12회 삼성 승리' }, ['원태인']), false);
  assert.equal(hasUnsupportedPlayerInning({ headline: '연장 12회 원태인 결승타' }, ['원태인']), true);
});

test('regulation game has no extra phase; walkoff and scoreless extra innings remain visible', () => {
  const build = (away: (number|null)[], home: (number|null)[]) => buildRecordSummary({
    awayTeam: '삼성', homeTeam: 'KT', awayScore: 0, homeScore: 0,
    linescore: { away: { innings: away }, home: { innings: home } },
  }).gameFlow as Record<string,string>;
  assert.equal(build(Array(9).fill(0), [...Array(8).fill(0), null]).extra, undefined);
  assert.equal(build(Array(11).fill(0), Array(11).fill(0)).extra, '10~11회 득점은 삼성 0점, KT 0점입니다.');
  assert.equal(build(Array(10).fill(0), [...Array(9).fill(0), 1]).extra, '10~10회 득점은 삼성 0점, KT 1점입니다.');
});
