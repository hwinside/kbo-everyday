/**
 * /api/team-records KBO HTML → Naver team statistics failover 회귀.
 * KBO hard-fail/partial 모두 Naver 10구단으로 복구하고, Naver partial/중복은 fail-close한다.
 */
import assert from "node:assert/strict";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "smoke-service-role-key";

const NAVER_TEAMS = [
  ["LG", "LG"],
  ["OB", "두산"],
  ["KT", "KT"],
  ["SK", "SSG"],
  ["NC", "NC"],
  ["HT", "KIA"],
  ["LT", "롯데"],
  ["SS", "삼성"],
  ["HH", "한화"],
  ["WO", "키움"],
] as const;

function naverPayload(teams: readonly (readonly [string, string])[] = NAVER_TEAMS) {
  return {
    success: true,
    result: {
      seasonTeamStats: teams.map(([teamId, teamName], index) => ({
        teamId,
        teamName,
        offenseHra: 0.25 + index / 1000,
        offenseOps: 0.7 + index / 1000,
        offenseHr: 50 + index,
        offenseRun: 300 + index,
        offenseSb: 40 + index,
        defenseEra: 3.5 + index / 100,
        defenseWhip: 1.2 + index / 100,
        defenseKk: 500 + index,
        defenseSave: 20 + index,
        defenseHr: 60 + index,
      })),
    },
  };
}

async function main() {
  const { loadTeamRecords, mapNaverTeamRecords } = await import(
    "../../src/app/api/team-records/route"
  );

  const mapped = mapNaverTeamRecords(naverPayload(), 2026);
  assert.equal(mapped.batting.length, 10);
  assert.equal(mapped.pitching.length, 10);
  assert.equal(new Set(mapped.batting.map((row) => row.teamId)).size, 10);
  assert.deepEqual(mapped.batting[0], {
    teamId: 1,
    slug: "lg",
    avg: ".250",
    ops: "0.700",
    hr: 50,
    runs: 300,
    sb: 40,
  });
  assert.deepEqual(mapped.pitching[0], {
    teamId: 1,
    slug: "lg",
    era: "3.50",
    whip: "1.20",
    so: 500,
    sv: 20,
    hra: 60,
  });

  const kboData = { batting: mapped.batting, pitching: mapped.pitching };
  let naverCalls = 0;
  const primary = await loadTeamRecords(
    2026,
    async () => kboData,
    async () => {
      naverCalls += 1;
      return mapped;
    },
  );
  assert.deepEqual(primary, { season: 2026, ...kboData });
  assert.equal(naverCalls, 0, "KBO 정상 시 Naver 미호출");

  const hardFail = await loadTeamRecords(
    2026,
    async () => {
      throw new Error("KBO HTTP 503");
    },
    async () => {
      naverCalls += 1;
      return mapped;
    },
  );
  assert.equal(hardFail.batting.length, 10);

  const partial = await loadTeamRecords(
    2026,
    async () => ({ batting: mapped.batting.slice(0, 9), pitching: mapped.pitching }),
    async () => {
      naverCalls += 1;
      return mapped;
    },
  );
  assert.equal(partial.pitching.length, 10);
  assert.equal(naverCalls, 2, "hard-fail + partial 각각 Naver 1회");

  assert.throws(
    () => mapNaverTeamRecords(naverPayload(NAVER_TEAMS.slice(0, 9)), 2026),
    /schema invalid/,
    "Naver partial fail-close",
  );
  assert.throws(
    () => mapNaverTeamRecords(naverPayload([...NAVER_TEAMS.slice(0, 9), NAVER_TEAMS[0]]), 2026),
    /incomplete team data/,
    "Naver duplicate fail-close",
  );

  console.log("team-records Naver failover smoke: 17 assertions PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
