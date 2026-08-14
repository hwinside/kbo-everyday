import assert from "node:assert/strict";
import {
  APPROVED_INTERVIEW_CHANNELS,
  isPostgameInterviewTitle,
  matchPostgameInterview,
  nextPostgameInterviewCollectionAt,
  titleMatchesGameDate,
  titleMatchesMatchupAndScore,
  type InterviewChannel,
  type InterviewMatchContext,
} from "../../src/lib/video/postgame-interviews";
import {
  contextFromStoredJob,
  doubleheaderGameIds,
  interviewPlayerLinks,
} from "../../src/lib/video/postgame-interviews-route-policy";

const minute = 60_000;
const hour = 60 * minute;
const endedAt = Date.parse("2026-07-30T13:00:00.000Z");

assert.equal(nextPostgameInterviewCollectionAt(endedAt, endedAt), endedAt + 30 * minute);
assert.equal(nextPostgameInterviewCollectionAt(endedAt, endedAt + 30 * minute), endedAt + 45 * minute);
assert.equal(nextPostgameInterviewCollectionAt(endedAt, endedAt + 3 * hour), endedAt + 3.5 * hour);
assert.equal(nextPostgameInterviewCollectionAt(endedAt, endedAt + 8 * hour), endedAt + 9 * hour);
assert.equal(nextPostgameInterviewCollectionAt(endedAt, endedAt + 24 * hour), null);

assert.equal(isPostgameInterviewTitle("임찬규 인터뷰"), true);
assert.equal(isPostgameInterviewTitle("임찬규 승리 소감"), false);
assert.equal(titleMatchesGameDate("인터뷰 | 2026 KBO리그 (26.07.30)", "2026-07-30"), true);
assert.equal(titleMatchesGameDate("아이러브베이스볼 (07.30)", "2026-07-30"), true);
assert.equal(titleMatchesGameDate("7월 30일 수훈선수", "2026-07-30"), true);
assert.equal(titleMatchesGameDate("LG 2 vs 두산 4 | 260731", "2026-07-31"), true);
assert.equal(titleMatchesGameDate("0811 | 카라스코 수훈선수 인터뷰", "2026-08-11"), true);
assert.equal(titleMatchesGameDate("KIA 4 vs. NC 10 | 07/31/26", "2026-07-31"), true);
assert.equal(titleMatchesGameDate("LG 2 vs 두산 4 | 260730", "2026-07-31"), false);
assert.equal(titleMatchesGameDate("0810 | 카라스코 수훈선수 인터뷰", "2026-08-11"), false);
assert.equal(titleMatchesGameDate("7월 29일 수훈선수", "2026-07-30"), false);

const channel: InterviewChannel = {
  channelId: "official",
  name: "공식",
  sourceKind: "broadcaster",
  teamId: null,
};
const base: InterviewMatchContext = {
  gameId: "20260730WOLG0",
  gameDate: "2026-07-30",
  awayTeamName: "키움",
  homeTeamName: "LG",
  awayScore: 3,
  homeScore: 5,
  winnerTeamId: 1,
  winnerPlayerNames: ["임찬규", "송찬의"],
  isDoubleheader: false,
  endedAt: "2026-07-30T13:00:00.000Z",
  expiresAt: "2026-07-31T13:00:00.000Z",
};
const entry = {
  title: "접니다^^ 10승 선점 투수 임찬규 인터뷰｜키움 VS LG｜2026 아이러브베이스볼 (07.30)",
  published_at: "2026-07-30T14:00:00.000Z",
};

assert.deepEqual(matchPostgameInterview(entry, channel, [base]), {
  gameId: base.gameId,
  playerNames: ["임찬규"],
});
assert.equal(
  matchPostgameInterview(entry, channel, [
    base,
    { ...base, gameId: "20260730WOLG1" },
  ]),
  null,
  "더블헤더 후보는 fail-closed",
);
assert.equal(
  matchPostgameInterview(entry, channel, [{ ...base, isDoubleheader: true }]),
  null,
  "더블헤더는 선수 후보가 유일해도 fail-closed",
);
assert.equal(
  matchPostgameInterview(
    { ...entry, title: "임찬규 승리 소감 (07.30)" },
    channel,
    [base],
  ),
  null,
);

const winningTwinsChannel = APPROVED_INTERVIEW_CHANNELS.find(
  (candidate) => candidate.channelId === "UCYKUMtgU-lfM7PnclPkFXfQ",
);
assert.ok(winningTwinsChannel, "위닝트윈스 승인 채널 등록");
assert.deepEqual(
  matchPostgameInterview(
    {
      title: "0811 | 10이닝 퍼펙트! KBO 데뷔 첫 승! | 카라스코 수훈선수 인터뷰",
      published_at: "2026-08-11T13:44:55.000Z",
    },
    winningTwinsChannel,
    [{
      ...base,
      gameId: "20260811LGWO0",
      gameDate: "2026-08-11",
      awayTeamName: "LG",
      homeTeamName: "키움",
      awayScore: 3,
      homeScore: 1,
      winnerTeamId: 1,
      winnerPlayerNames: ["카라스코"],
      endedAt: "2026-08-11T13:20:35.538Z",
      expiresAt: "2026-08-12T13:20:35.538Z",
    }],
  ),
  { gameId: "20260811LGWO0", playerNames: ["카라스코"] },
  "실제 누락 영상이 MMDD·선수명·승리팀·업로드 창으로 매핑",
);
assert.equal(
  matchPostgameInterview(
    {
      title: "0811 | 카라스코 수훈선수 인터뷰",
      published_at: "2026-08-11T13:44:55.000Z",
    },
    winningTwinsChannel,
    [{
      ...base,
      gameId: "20260811HHOB0",
      gameDate: "2026-08-11",
      winnerTeamId: 2,
      winnerPlayerNames: ["카라스코"],
      endedAt: "2026-08-11T13:01:29.390Z",
      expiresAt: "2026-08-12T13:01:29.390Z",
    }],
  ),
  null,
  "LG 전용 채널은 타 구단 승리 경기와 매핑하지 않는다",
);

const curatedInterviewChannel: InterviewChannel = {
  channelId: "UCUB0bLq2AIOzE9EX9oyokTQ",
  name: "[크보인터뷰]",
  sourceKind: "curated",
  teamId: null,
  dedicatedInterviewChannel: true,
};
const kimDaeHanContext = contextFromStoredJob({
  game_id: "20260731LGOB0",
  game_date: "2026-07-31",
  away_team_name: "LG",
  home_team_name: "두산",
  away_score: 2,
  home_score: 4,
  winner_team_id: 2,
  is_doubleheader: false,
  ended_at: "2026-07-31T12:25:15.000Z",
  expires_at: "2026-08-01T12:25:15.000Z",
}, ["김대한", "김택연"]);
assert.deepEqual(
  matchPostgameInterview(
    {
      title: "[두산베어스] 김대한 선수 | 개인 통산 첫 2홈런 경기! LG 2 vs 두산 4 | 260731",
      published_at: "2026-07-31T12:51:16.000Z",
    },
    curatedInterviewChannel,
    [kimDaeHanContext],
  ),
  { gameId: kimDaeHanContext.gameId, playerNames: ["김대한"] },
  "인터뷰 전용 검증 채널은 제목 키워드 없이도 YYMMDD·선수·경기 조건으로 매핑",
);
assert.equal(
  titleMatchesMatchupAndScore(
    "[두산베어스] 김대한 선수 | LG 2 vs 두산 4 | 260731",
    kimDaeHanContext,
  ),
  true,
);
for (const wrongHomeScore of ["40", "400"]) {
  assert.equal(
    titleMatchesMatchupAndScore(
      `[두산베어스] 김대한 선수 | LG 2 vs 두산 ${wrongHomeScore} | 260731`,
      kimDaeHanContext,
    ),
    false,
    `home score ${wrongHomeScore}은 score 4로 prefix 매칭하지 않는다`,
  );
}
const ktLgContext = {
  ...kimDaeHanContext,
  awayTeamName: "KT",
  homeTeamName: "LG",
  awayScore: 5,
  homeScore: 4,
};
assert.equal(
  titleMatchesMatchupAndScore("KT 5 vs LG 4", ktLgContext),
  true,
  "영문 약칭 대진 정상 매칭",
);
for (const prefixedAwayTeam of ["SKT", "XKT", "한KT"]) {
  assert.equal(
    titleMatchesMatchupAndScore(`${prefixedAwayTeam} 5 vs LG 4`, ktLgContext),
    false,
    `${prefixedAwayTeam} 안의 KT substring은 away team으로 매칭하지 않는다`,
  );
}
assert.equal(
  matchPostgameInterview(
    {
      title: "[두산베어스] 김대한 선수 | 한화 2 vs 두산 4 | 260731",
      published_at: "2026-07-31T12:51:16.000Z",
    },
    curatedInterviewChannel,
    [kimDaeHanContext],
  ),
  null,
  "curated 영상의 대진 불일치는 미노출",
);
assert.equal(
  matchPostgameInterview(
    {
      title: "[두산베어스] 김대한 선수 | LG 9 vs 두산 0 | 260731",
      published_at: "2026-07-31T12:51:16.000Z",
    },
    curatedInterviewChannel,
    [kimDaeHanContext],
  ),
  null,
  "curated 영상의 최종스코어 불일치는 미노출",
);
assert.equal(
  matchPostgameInterview(
    {
      title: "[두산베어스] 김대한 선수 | 개인 통산 첫 2홈런 경기! LG 2 vs 두산 4 | 260730",
      published_at: "2026-07-31T12:51:16.000Z",
    },
    curatedInterviewChannel,
    [kimDaeHanContext],
  ),
  null,
  "전용 채널이어도 경기일 불일치는 미노출",
);

// route seed 회귀: 1차전 final + 2차전 live여도 당일 전체 일정에서 두 game_id 모두
// doubleheader로 분류되어 seed row의 is_doubleheader가 true가 된다.
const doubleheaders = doubleheaderGameIds([
  { gameId: "20260730WOLG0", date: "20260730", awayTeamId: 7, homeTeamId: 1 },
  { gameId: "20260730WOLG1", date: "20260730", awayTeamId: 7, homeTeamId: 1 },
]);
assert.equal(doubleheaders.has("20260730WOLG0"), true, "1차전 seed row true");
assert.equal(doubleheaders.has("20260730WOLG1"), true, "2차전 seed row true");

const persistedDoubleheaderJob = {
  game_id: "20260730WOLG1",
  game_date: "2026-07-30",
  winner_team_id: 1,
  away_team_name: "키움",
  home_team_name: "LG",
  away_score: 3,
  home_score: 5,
  is_doubleheader: doubleheaders.has("20260730WOLG1"),
  ended_at: base.endedAt,
  expires_at: base.expiresAt,
};

// route context 회귀: 1차전 job이 expired되고 2차전 collecting job만 조회돼도
// 저장된 is_doubleheader가 context까지 유지되어 matcher가 fail-closed한다.
const persistedContext = contextFromStoredJob(persistedDoubleheaderJob, ["임찬규", "송찬의"]);
assert.equal(persistedContext.isDoubleheader, true, "저장 job→context true");
assert.equal(
  matchPostgameInterview(entry, channel, [persistedContext]),
  null,
  "1차전 expired + 2차전 collecting: 남은 2차전 context도 더블헤더면 미노출",
);

assert.deepEqual(
  interviewPlayerLinks(["임찬규", "임찬규", "송찬의"], 1),
  [
    { name: "임찬규", kboId: "61101", teamId: 1 },
    { name: "송찬의", kboId: "68110", teamId: 1 },
  ],
  "승리팀으로 동명이인을 한정하고 선수 상세용 canonical kboId를 반환",
);
assert.deepEqual(
  interviewPlayerLinks(["미등록선수"], 1),
  [{ name: "미등록선수", kboId: null, teamId: 1 }],
  "미등록 선수명은 링크 없이 라벨을 유지",
);
assert.deepEqual(
  interviewPlayerLinks(["임찬규"], 2),
  [{ name: "임찬규", kboId: null, teamId: 2 }],
  "타팀 선수 fallback은 링크하지 않는다",
);
assert.deepEqual(
  interviewPlayerLinks(["김민준"], 4),
  [{ name: "김민준", kboId: null, teamId: 4 }],
  "같은 팀 동명이인은 임의의 첫 선수로 링크하지 않는다",
);

console.log("postgame-interviews smoke: PASS");
