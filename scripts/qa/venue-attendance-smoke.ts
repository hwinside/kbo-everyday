import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { KboGame } from "../../src/lib/crawler/kbo-api";
import {
  buildVenueDiaryItem,
  summarizeVenueAttendance,
  type VenueAttendanceRow,
} from "../../src/lib/venue-attendance/summary";
import { fetchAttendanceGamesWithinDeadline } from "../../src/lib/venue-attendance/fetch-games";

function row(overrides: Partial<VenueAttendanceRow> = {}): VenueAttendanceRow {
  return {
    id: 1,
    game_id: "20260721LGLT0",
    game_date: "2026-07-21",
    favorite_team_id_snapshot: 1,
    stadium_name: "잠실",
    recorded_at: "2026-07-21T10:00:00Z",
    ...overrides,
  };
}

function game(overrides: Partial<KboGame> = {}): KboGame {
  return {
    gameId: "20260721LGLT0",
    date: "20260721",
    time: "18:30",
    stadium: "잠실",
    awayTeamId: 1,
    homeTeamId: 7,
    awayName: "LG",
    homeName: "롯데",
    awayScore: 5,
    homeScore: 3,
    inning: 9,
    isTop: false,
    status: "final",
    awayStarterName: "",
    homeStarterName: "",
    winPitcher: "",
    losePitcher: "",
    savePitcher: "",
    strikes: 0,
    balls: 0,
    outs: 0,
    runnersOn: { first: false, second: false, third: false },
    currentPitcher: "",
    currentBatter: "",
    awayRank: 0,
    homeRank: 0,
    ...overrides,
  };
}

const win = buildVenueDiaryItem(row(), game());
assert.equal(win.result, "W", "최애팀 스냅샷 원정 승리");

const loss = buildVenueDiaryItem(row(), game({ awayScore: 2, homeScore: 4 }));
assert.equal(loss.result, "L", "최애팀 스냅샷 원정 패배");

const draw = buildVenueDiaryItem(row(), game({ awayScore: 4, homeScore: 4 }));
assert.equal(draw.result, "D", "무승부");

for (const status of ["scheduled", "live", "cancelled"] as const) {
  assert.equal(
    buildVenueDiaryItem(row(), game({ status })).result,
    null,
    `${status}는 승률 분모 제외`,
  );
}

assert.equal(buildVenueDiaryItem(row(), null).result, null, "조회 실패는 승률 분모 제외");
assert.equal(
  buildVenueDiaryItem(row({ favorite_team_id_snapshot: 9 }), game()).result,
  null,
  "스냅샷 팀이 참가하지 않은 경기는 W/L/D 제외",
);

const pending = buildVenueDiaryItem(row({ id: 4 }), game({ status: "live" }));
const summary = summarizeVenueAttendance([win, loss, draw, pending]);
assert.deepEqual(summary, {
  attendanceCount: 4,
  wins: 1,
  losses: 1,
  draws: 1,
  finalCount: 3,
  winRate: 1 / 3,
});
assert.equal(summarizeVenueAttendance([pending]).winRate, null, "종료 경기 0건은 승률 미표시");

const migration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260721_venue_attendance.sql"),
  "utf8",
);
const storagePolicyMigration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260721_venue_attendance_storage_policy.sql"),
  "utf8",
);
assert.match(migration, /UNIQUE \(user_id, game_id\)/, "유저·경기 멱등 키");
assert.match(migration, /NEW\.status <> 'active'/, "active 전환만 영구 기록");
assert.match(migration, /NEW\.attendance_source <> 'story_geofence'/, "QA 우회 제외");
assert.match(storagePolicyMigration, /FOR INSERT TO authenticated/, "사진 업로드는 로그인 유저만 허용");
assert.match(storagePolicyMigration, /bucket_id = 'photos'/, "photos 버킷에만 적용");
assert.match(storagePolicyMigration, /\[3\] = auth\.uid\(\)::text/, "경로의 userId를 로그인 유저에 바인딩");
assert.match(storagePolicyMigration, /array_length\(storage\.foldername\(name\), 1\) = 3/, "정확한 3단 폴더만 허용");
assert.match(migration, /AFTER INSERT OR UPDATE OF status ON venue_stories/, "영상 승격 경로 포함");

const attendanceTable = migration.match(/CREATE TABLE IF NOT EXISTS venue_attendance \(([\s\S]*?)\n\);/)?.[1] ?? "";
assert.ok(attendanceTable, "venue_attendance table contract");
assert.doesNotMatch(attendanceTable, /media_url|thumb_url|caption/, "스토리 콘텐츠 영구 복제 금지");

const diaryRoute = readFileSync(
  resolve(process.cwd(), "src/app/api/me/venue-attendance/route.ts"),
  "utf8",
);
assert.match(
  diaryRoute,
  /if \(profileResult\.error\) \{[\s\S]*?status: 500/,
  "프로필 DB 오류를 최애선수 없음으로 오인하지 않고 5xx 처리",
);

async function testDeadline() {
  let deadlineCalls = 0;
  const deadlineRows = Array.from({ length: 20 }, (_, index) =>
    row({
      id: index + 10,
      game_id: `deadline-${index}`,
      game_date: `2026-06-${String(index + 1).padStart(2, "0")}`,
    }),
  );
  const deadlineStartedAt = Date.now();
  const deadlineGames = await fetchAttendanceGamesWithinDeadline(deadlineRows, {
    deadlineMs: 25,
    maxConcurrency: 3,
    fetcher: async () => {
      deadlineCalls += 1;
      return new Promise(() => {});
    },
  });
  assert.ok(Date.now() - deadlineStartedAt < 250, "KBO 장애에도 전체 deadline 안에서 반환");
  assert.equal(deadlineCalls, 3, "느린 KBO 호출의 동시성 상한");
  assert.equal(deadlineGames.size, 0, "deadline 미조회 경기는 fail-soft 제외");
}

void testDeadline()
  .then(() => console.log("venue-attendance smoke: PASS (result 8 + persistence/API/deadline contract 9)"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
