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
import { decideManualAttendanceTeam } from "../../src/lib/venue-diary/manual-upload";

function row(overrides: Partial<VenueAttendanceRow> = {}): VenueAttendanceRow {
  return {
    id: 1,
    game_id: "20260721LGLT0",
    game_date: "2026-07-21",
    favorite_team_id_snapshot: 1,
    stadium_name: "잠실",
    recorded_at: "2026-07-21T10:00:00Z",
    source: "story_geofence",
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
const manual = buildVenueDiaryItem(row({ source: "diary_manual" }), game());
assert.equal(manual.source, "diary_manual", "직접 추가 source 응답");
assert.equal(manual.venueVerified, false, "직접 추가는 GPS 인증과 분리");
assert.equal(win.venueVerified, true, "GPS source만 인증");

assert.deepEqual(
  decideManualAttendanceTeam(1, { awayTeamId: 1, homeTeamId: 7 }),
  { ok: true, favoriteTeamId: 1 },
  "직접 등록 응원팀은 참가팀 허용",
);
assert.equal(
  decideManualAttendanceTeam(9, { awayTeamId: 1, homeTeamId: 7 }).ok,
  false,
  "비참가팀 출처 위조 차단",
);
assert.equal(
  decideManualAttendanceTeam("1", { awayTeamId: 1, homeTeamId: 7 }).ok,
  false,
  "문자열 팀 id fail-closed",
);

const migration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260721_venue_attendance.sql"),
  "utf8",
);
assert.match(migration, /UNIQUE \(user_id, game_id\)/, "유저·경기 멱등 키");
assert.match(migration, /NEW\.status <> 'active'/, "active 전환만 영구 기록");
assert.match(migration, /NEW\.attendance_source <> 'story_geofence'/, "QA 우회 제외");
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
assert.match(
  diaryRoute,
  /\.in\("source", \["story_geofence", "diary_manual"\]\)/,
  "다이어리 기록에는 GPS+직접 추가 모두 조회(경기수 집계용)",
);
// 인증 계약 유지: 인증 직관수·배지용 summary 는 GPS 인증(story_geofence) 건만.
assert.match(
  diaryRoute,
  /const certifiedGames = games\.filter\(\(game\) => game\.source === "story_geofence"\)/,
  "인증 통계용 GPS 전용 집합 분리",
);
assert.match(
  diaryRoute,
  /summary: summarizeVenueAttendance\(certifiedGames\)/,
  "summary(인증 직관수·배지)는 GPS 인증 건만 집계 — 기존 계약 유지",
);
// 하린아빠 정책 변경(2026-07-30): 승률 표시 기본값은 직접 추가 포함 전체 → overallSummary 별도 필드.
assert.match(
  diaryRoute,
  /overallSummary: summarizeVenueAttendance\(games\)/,
  "overallSummary(승률 기본값)는 GPS+직접 추가 전체 집계",
);
assert.match(
  diaryRoute,
  /diaryGameCount: games\.length/,
  "다이어리 기록 경기수는 직접 추가 포함 전체",
);
assert.match(diaryRoute, /\.is\("deleted_at", null\)/, "삭제 기록은 다이어리 조회에서 즉시 제외");
assert.match(diaryRoute, /upsert_venue_attendance_manual/, "직접 등록/재등록 RPC 사용");

const statsRoute = readFileSync(
  resolve(process.cwd(), "src/app/api/me/venue-stats/route.ts"),
  "utf8",
);
assert.match(statsRoute, /\.is\("deleted_at", null\)/, "삭제 기록은 인사이트 집계에서 즉시 제외");

const mutationRoute = readFileSync(
  resolve(process.cwd(), "src/app/api/me/venue-attendance/[id]/route.ts"),
  "utf8",
);
assert.match(mutationRoute, /row\.user_id !== userId[\s\S]*?status: 403/, "타인 원장 변경 403");
assert.match(mutationRoute, /source !== "diary_manual"[\s\S]*?status: 403/, "GPS 수정 금지");
assert.match(mutationRoute, /deleted_at: now/, "DELETE는 원장 soft-delete");
assert.doesNotMatch(
  mutationRoute,
  /\.from\("venue_stories"\)|storage\.from/,
  "기록 삭제가 미디어를 건드리지 않음",
);

const crudMigration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260802193000_venue_attendance_crud.sql"),
  "utf8",
);
assert.match(crudMigration, /ADD COLUMN IF NOT EXISTS deleted_at/, "soft-delete tombstone");
assert.match(crudMigration, /v_row\.source <> 'diary_manual'/, "삭제 GPS→직접등록 출처 변경 차단");
assert.match(crudMigration, /deleted_at = NULL/, "직접 등록 재등록 복원");
assert.doesNotMatch(
  diaryRoute,
  /(?<!overall)summary: summarizeVenueAttendance\(games\)/i,
  "인증 계약용 summary 필드에 all-source 집계를 넣지 않음(인증 직관수 오염 방지)",
);

// 승률 정책 회귀: 직접 추가 포함(기본) vs GPS 인증만(토글) 결과가 실제로 달라진다.
{
  const gpsWin = buildVenueDiaryItem(row({ id: 201 }), game());
  const gpsLoss = buildVenueDiaryItem(
    row({ id: 202 }),
    game({ awayScore: 2, homeScore: 4 }),
  );
  const manualWin1 = buildVenueDiaryItem(
    row({ id: 203, source: "diary_manual" }),
    game(),
  );
  const manualWin2 = buildVenueDiaryItem(
    row({ id: 204, source: "diary_manual" }),
    game(),
  );
  const all = [gpsWin, gpsLoss, manualWin1, manualWin2];
  const certifiedOnly = all.filter((item) => item.source === "story_geofence");

  const overall = summarizeVenueAttendance(all);
  const certified = summarizeVenueAttendance(certifiedOnly);
  assert.equal(overall.wins, 3, "전체: GPS 1승 + 직접 추가 2승");
  assert.equal(overall.losses, 1);
  assert.equal(overall.winRate, 3 / 4, "직접 추가 포함 승률(기본값)");
  assert.equal(certified.wins, 1, "GPS-only: 직접 추가 제외");
  assert.equal(certified.winRate, 1 / 2, "GPS 인증만 승률(토글)");
  assert.equal(
    certified.attendanceCount,
    2,
    "인증 직관수는 GPS 건만(정책 변경 후에도 불변)",
  );
}

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
