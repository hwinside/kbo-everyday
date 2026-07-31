import assert from "node:assert/strict";
import {
  isPostgameInterviewTitle,
  matchPostgameInterview,
  nextPostgameInterviewCollectionAt,
  titleMatchesGameDate,
  type InterviewChannel,
  type InterviewMatchContext,
} from "../../src/lib/video/postgame-interviews";

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

console.log("postgame-interviews smoke: PASS");
