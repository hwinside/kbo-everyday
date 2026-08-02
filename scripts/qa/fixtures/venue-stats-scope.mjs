/**
 * 직관 통계 대시보드 공용 fixture (읽기 전용).
 *
 * `venue-stats-s2-browser` 와 `result-tone-gate` 가 같은 payload 를 쓰도록 여기로 뺐다.
 * 게이트마다 fixture 를 따로 적으면 한쪽만 낡아 "한 게이트에선 값이 뜨는데 다른 게이트에선
 * 빈 화면이라 통과" 같은 false-green 이 생긴다.
 */
const metricIds = [
  "A1","A2","A3","A4","A5","A6","B1","B2","B3","B4",
  "C1","C2","C4","C5","C6","D1","D5","D6","D7","E1","E2","E3","E4",
];
const envelope = (id, value, denominator = { finalGames: 8 }) => ({
  id, state: "ready", value, n: 8, denominator, coverage: {},
});
// qualityAvg = 경기 질 평균(하린아빠 2026-08-02: 대승·박빙패가 긍정 기여).
// 요정 지수 v2 는 순수 승률이 아니라 5축 합성이라, fixture 도 비교 근거(deltaPp)와
// 경기 질을 갖춰야 실제 지수가 산출된다.
const scope = (name, wins, rate, excessWin = .18, excessMargin = 1.4) => {
  const metrics = Object.fromEntries(metricIds.map((id) => [id, envelope(id, null)]));
  // 팀별 승률 리프트(%p) — 경기수 가중 평균이 (rate-.5)×100 이 되도록 대칭 분배.
  const liftPp = (rate - .5) * 100;
  metrics.A1 = {
    ...envelope("A1", {
      attendance: { w: wins, l: 8 - wins, d: 0, rate },
      teamComparable: null,
      deltaPp: null,
    }),
    state: "mixed_team",
    items: [
      { key:"1", state:"ready", value:{attendance:{w:3,l:1,d:0,rate:.75},teamComparable:null,deltaPp:liftPp + 5}, n:4, denominator:{} },
      { key:"9", state:"ready", value:{attendance:{w:2,l:2,d:0,rate:.5},teamComparable:null,deltaPp:liftPp - 5}, n:4, denominator:{} },
    ],
  };
  // 요정 지수 본체 = pregame 기대치 대비 초과성과(승률 아님).
  metrics.A1.value.excess = { winExcess: excessWin, marginExcess: excessMargin, games: 8 };
  const teamValues = {
    "1": {
      B1:{attendanceAvg:.286,seasonAvg:.263,delta:.023},
      B2:{attendanceEra:3.42,seasonEra:4.01,delta:-.59},
      B3:{runsPerGame:5.2,seasonRunsPerGame:4.6,delta:.6,totalRuns:21},
      B4:{hr:{attendancePerGame:1.3,seasonPerGame:1.0,delta:.3},hitsAllowed:null},
    },
    "9": {
      B1:{attendanceAvg:.251,seasonAvg:.244,delta:.007},
      B2:{attendanceEra:4.18,seasonEra:4.31,delta:-.13},
      B3:{runsPerGame:4.1,seasonRunsPerGame:4.4,delta:-.3,totalRuns:16},
      B4:{hr:{attendancePerGame:.8,seasonPerGame:.7,delta:.1},hitsAllowed:null},
    },
  };
  for (const id of ["B1","B2","B3","B4"]) {
    metrics[id] = {...envelope(id, null),state:"mixed_team",items:[
      {key:"1",state:"ready",value:teamValues["1"][id],n:4,denominator:{}},
      {key:"9",state:"ready",value:teamValues["9"][id],n:4,denominator:{}},
    ]};
  }
  metrics.C1 = envelope("C1", [
    {playerId:"53123",attendanceAvg:.333,seasonAvg:.278,deltaAvg:.055,attendanceHrPerGame:.2,seasonHrPerGame:.1,attendanceRbiPerGame:1,seasonRbiPerGame:.7,appearances:6,ab:21},
    {playerId:"p3",attendanceAvg:.310,seasonAvg:.270,deltaAvg:.040,attendanceHrPerGame:.1,seasonHrPerGame:.1,attendanceRbiPerGame:.8,seasonRbiPerGame:.6,appearances:5,ab:20},
    {playerId:"p4",attendanceAvg:.230,seasonAvg:.260,deltaAvg:-.030,attendanceHrPerGame:0,seasonHrPerGame:.1,attendanceRbiPerGame:.3,seasonRbiPerGame:.5,appearances:5,ab:20},
  ], {attendanceAB:61});
  metrics.C2 = envelope("C2", [
    {playerId:"p2",attendanceEra:2.71,seasonEra:3.88,eraImprovement:1.17,attendanceK9:9.2,seasonK9:8.1,k9Delta:1.1,appearances:4,outs:40},
    {playerId:"p5",attendanceEra:3.20,seasonEra:3.75,eraImprovement:.55,attendanceK9:8.7,seasonK9:8.0,k9Delta:.7,appearances:4,outs:36},
  ], {attendanceOuts:76});
  metrics.C4 = envelope("C4", [
    {playerId:"53123",homeRuns:2,appearanceGames:6,batter:{hits:9,rbi:7,homeRuns:2},pitcher:null},
    {playerId:"p2",homeRuns:0,appearanceGames:4,batter:null,pitcher:{strikeouts:12,zeroEarnedRunGames:2}},
    {playerId:"p3",homeRuns:1,appearanceGames:5,batter:{hits:6,rbi:4,homeRuns:1},pitcher:null},
    {playerId:"p4",homeRuns:0,appearanceGames:5,batter:{hits:5,rbi:3,homeRuns:0},pitcher:null},
    {playerId:"p5",homeRuns:0,appearanceGames:4,batter:null,pitcher:{strikeouts:9,zeroEarnedRunGames:1}},
  ]);
  metrics.C5 = envelope("C5", [{playerId:"53123",batterTop:{gameId:"g",date:"2026-07-12",ab:4,h:3,hr:1,rbi:3,bb:1}}]);
  metrics.C6 = envelope("C6", {
    batterRanking:[
      {playerId:"53123",boostPct:.1978417266},
      {playerId:"p3",boostPct:.1481481481},
      {playerId:"p4",boostPct:.1153846154},
    ],
    pitcherRanking:[
      {playerId:"p2",boostPct:.3015463918},
      {playerId:"p5",boostPct:.1466666667},
    ],
  });
  // 경기 질 q 평균: 대승 2 · 박빙패 2 섞인 여름상의 “볼 만했다” 분포.
  metrics.D1 = envelope("D1", {avgRunDiff:1.4,closeGameRate:.25,closeGames:2});
  metrics.D5 = envelope("D5", {cancelledCount:1});
  metrics.D6 = envelope("D6", {maxTeamRuns:{gameId:"g",date:"2026-07-12",runs:9},maxMarginWin:null});
  // D7 실책 — 기본 fixture 는 발암경기 과반(3/5) → `발암경기 인내형` 이 실제 DOM 에 떠야 한다.
  metrics.D7 = envelope("D7", {
    myTeamErrors: 8, opponentErrors: 2, errorProneGames: 3,
    myErrorsPerGame: 1.6, knownGames: 5,
    worstGame: { gameId: "20260725LGHH0", date: "2026-07-25", errors: 3 },
  });
  metrics.E1 = envelope("E1", {current:3,longest:5,perTeam:[]});
  metrics.E2 = envelope("E2", {seasonCount:8,monthly:[],avgPerActiveMonth:2});
  metrics.E3 = envelope("E3", {firstAttendanceDate:"2024-04-01",daysSinceFirst:842,totalGames:17});
  metrics.E4 = envelope("E4", {topStadium:{name:"잠실",count:6},mostSeenFavorites:[]});
  metrics.A2 = envelope("A2", [{opponentTeamId:2,w:3,l:1,d:0,rate:.75}]);
  // 원정 찐팬 태그 검증용 — 홈 잠실 + 원정 2개 구장 3경기(하린아빠 2026-08-02).
  metrics.A3 = envelope("A3", [
    {stadium:"잠실",homeAway:"home",w:3,l:2,d:0,rate:.6},
    {stadium:"대구",homeAway:"away",w:1,l:1,d:0,rate:.5},
    {stadium:"문학",homeAway:"away",w:1,l:0,d:0,rate:1},
  ]);
  metrics.A4 = envelope("A4", [{weekday:6,w:3,l:1,d:0,rate:.75}]);
  metrics.A5 = {
    ...envelope("A5", [{dayNight:"night",w:4,l:2,d:0,rate:.667},{dayNight:"day",w:2,l:0,d:0,rate:1}]),
    // 낮경기 "기회 대비 참석" 근거 — baseline 정상(시즌 낮경기 20/200 = 10%).
    coverage: { dayGameOpportunity: { attendanceDayGames: 2, attendanceTotal: 8, seasonDayGames: 20, seasonTotal: 200 } },
  };
  metrics.A6 = envelope("A6", [{month:7,w:3,l:1,d:0,rate:.75}]);
  return {
    state:"ready",
    filter:{scope:name,sources:name==="gps"?["story_geofence"]:["story_geofence","diary_manual"]},
    coverage:{attendanceGames:8,finalGames:8,cancelledGames:1,unavailableGames:0,dedupedRows:0,incompleteFinalGames:0,invalidSnapshot:[]},
    metrics,
  };
};
// 지수 sentinel 은 v2 산식 실측값(아래 주석) — 시즌/스코프 간 구분이 되어야 stale 검출이 가능하다.
// ⚠️ 하린아빠 2026-08-02 "신뢰도 구간은 경기수 기준을 너무 높게 잡지 마" 반영으로
//    수축 k=3 → k=1 로 낮아지면서 sentinel 이 이동했다(보정이 덜 깎으므로 양수는 ↑, 음수는 ↓).
//   overall 2026: 초과성과 win +.18 · margin +1.4 → 71
//   gps    2026: 초과성과 win -.12 · margin -1.1 → 37
//   overall 2025: 초과성과 win -.30 · margin -2.6 → 17
const payload = {
  season:2026,
  seasonSupport:{status:"supported",supportedSeason:2026},
  overall:scope("overall",5,.625,.18,1.4),
  gps:scope("gps",3,.375,-.12,-1.1),
};

export { metricIds, envelope, scope, payload };
