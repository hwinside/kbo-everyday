import assert from "node:assert/strict";
import {
  fetchTeamRecordsForDisplay,
  isRecordsData,
} from "../../src/lib/team-records/client";

const slugs = ["lg", "doosan", "kt", "ssg", "nc", "kia", "lotte", "samsung", "hanwha", "kiwoom"];
const validPayload = {
  season: 2026,
  batting: slugs.map((slug, index) => ({
    teamId: index + 1,
    slug,
    avg: ".280",
    ops: "0.810",
    hr: 100 + index,
    runs: 500 + index,
    sb: 50 + index,
  })),
  pitching: slugs.map((slug, index) => ({
    teamId: index + 1,
    slug,
    era: "3.80",
    whip: "1.35",
    so: 900 + index,
    sv: 30 + index,
    hra: 90 + index,
  })),
};

async function main() {
  await assert.rejects(
    fetchTeamRecordsForDisplay(async () =>
      Response.json({ error: "dual source failed" }, { status: 500 }),
    ),
    /request failed: 500/,
    "API 500 payload must not enter the records render path",
  );

  await assert.rejects(
    fetchTeamRecordsForDisplay(async () =>
      Response.json({ error: "malformed success" }, { status: 200 }),
    ),
    /response contract invalid/,
    "malformed 200 payload must fail closed",
  );

  assert.equal(isRecordsData(validPayload), true);
  const displayed = await fetchTeamRecordsForDisplay(async () =>
    Response.json(validPayload),
  );
  assert.equal(displayed.batting[0].ops, "0.810");
  assert.equal(displayed.pitching[0].era, "3.80");

  const duplicate = structuredClone(validPayload);
  duplicate.batting[9].slug = duplicate.batting[0].slug;
  assert.equal(isRecordsData(duplicate), false, "duplicate team contract fails");

  console.log("team-records client contract smoke: ALL assertions PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
