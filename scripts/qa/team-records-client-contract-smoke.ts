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

  // RED: LG 누락 + fake slug로 길이 10을 유지한 malformed 200
  const fakeSlugs = structuredClone(validPayload);
  fakeSlugs.batting = slugs.map((_, index) => ({
    teamId: index + 1,
    slug: `fake${index}`,
    avg: ".280",
    ops: "0.810",
    hr: 100 + index,
    runs: 500 + index,
    sb: 50 + index,
  }));
  assert.equal(
    isRecordsData(fakeSlugs),
    false,
    "unknown slugs with length 10 must fail closed",
  );

  const lgMissing = structuredClone(validPayload);
  lgMissing.batting[0] = {
    ...lgMissing.batting[0],
    teamId: 99,
    slug: "unknown",
  };
  assert.equal(
    isRecordsData(lgMissing),
    false,
    "LG 누락 + unknown team must fail closed",
  );

  // RED: teamId↔slug 불일치(정규 slug이지만 다른 팀의 id)
  const mismatched = structuredClone(validPayload);
  mismatched.pitching[0] = { ...mismatched.pitching[0], teamId: 2 };
  assert.equal(
    isRecordsData(mismatched),
    false,
    "teamId↔slug mismatch must fail closed",
  );

  // RED: 비수치 rate 문자열
  for (const [array, field] of [
    ["batting", "avg"],
    ["batting", "ops"],
    ["pitching", "era"],
    ["pitching", "whip"],
  ] as const) {
    const badRate = structuredClone(validPayload);
    (badRate[array][0] as Record<string, unknown>)[field] = "N/A";
    assert.equal(
      isRecordsData(badRate),
      false,
      `non-numeric ${array}.${field} must fail closed`,
    );
  }

  // RED: batting/pitching 팀 집합 불일치
  const setMismatch = structuredClone(validPayload);
  setMismatch.pitching[9] = {
    ...setMismatch.pitching[9],
    teamId: setMismatch.pitching[0].teamId,
    slug: setMismatch.pitching[0].slug,
  };
  assert.equal(
    isRecordsData(setMismatch),
    false,
    "batting/pitching team set mismatch must fail closed",
  );

  // malformed 200이 fetch 경로에서도 inline 실패로 이어져야 한다
  await assert.rejects(
    fetchTeamRecordsForDisplay(async () => Response.json(fakeSlugs)),
    /response contract invalid/,
    "fake-slug malformed 200 must fail closed through fetch path",
  );

  console.log("team-records client contract smoke: ALL assertions PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
