import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  lookupPitcherSeasonEra,
  normalizePitcherEra,
  resolveLineupStarter,
  resolveStarterPitcher,
} from "../../src/lib/stats/pitcher-season";
import { resolveRosterPlayer } from "../../src/lib/utils/player-roster";
import {
  isLineupStarterProvenanceTrusted,
  shouldCommitResponse,
  shouldPreserveCanonicalLineup,
} from "../../src/lib/source-snapshot";

/* ⚠︎ 기대 ERA를 리터럴로 박아두면, 이 스모크가 검증하려는 바로 그 파일
 * (`stats-2026-pitchers.json`, 매일 크롤로 갱신)이 정상 갱신되는 순간 RED가 된다.
 * 실제로 8/1 이후 선발 등판으로 ERA가 바뀌자 prebuild가 깨졌고, 로스터/스탯 자동
 * 업데이트 PR(#1059 #1086 #1095)이 사흘간 머지되지 못했다. 데이터 결함을 잡는 게
 * 아니라 데이터 갱신 자체를 막는 순환 참조였다.
 *
 * 그래서 *값*은 테이블에서 직접 읽고(해석기를 거치지 않으므로 순환이 아니다),
 * 스모크는 *identity 결속*(canonical ID 해석, 팀 분리, box 오염 차단)만 검증한다.
 * 값이 바뀌어도 RED가 되지 않고, 해석기가 무너지면 RED가 된다. */
const pitcherTableRows = JSON.parse(
  readFileSync("src/lib/constants/stats-2026-pitchers.json", "utf8"),
) as { kboId?: string; playerId?: string; era?: string }[];

/** 스탯 테이블의 숫자 ID 행을 그대로 읽는다(해석기 미경유). */
function tableEra(numericId: string): string | null {
  const row = pitcherTableRows.find((r) => String(r.kboId ?? r.playerId) === numericId);
  return normalizePitcherEra(row?.era);
}

const officialLineupStarters = [
  ["카라스코", 1, "56103", "56103", true],
  ["곽빈", 2, "68220", "68220", false],
  ["짐머맨", 9, "56799", "56799", false],
  ["배제성", 3, "65516", "65516", false],
  ["타케다", 4, "56823", "56823", false],
  ["김윤하", 10, "54319", "54319", false],
] as const;

for (const [name, teamId, kboId, numericId, withBox] of officialLineupStarters) {
  const era = tableEra(numericId);
  assert.ok(era, `${name}(${numericId})은 시즌 기록을 보유해야 한다`);
  assert.deepEqual(
    resolveStarterPitcher(name, teamId, withBox ? era! : undefined, withBox ? name : undefined),
    { name, era, kboId },
    `${name} official lineup resolves the current identity-bound ERA`,
  );
}

assert.equal(lookupPitcherSeasonEra("missing"), null, "unknown pitcher fails closed");

assert.equal(
  lookupPitcherSeasonEra(resolveRosterPlayer({ name: "양현종", teamId: 6 })?.kboId),
  tableEra("77637"),
  "동명이인 양현종은 KIA 정본으로 해석",
);
assert.equal(normalizePitcherEra("-"), null, "placeholder ERA rejected");
assert.equal(normalizePitcherEra("N/A"), null, "non-numeric ERA rejected");
assert.equal(normalizePitcherEra("0.00"), "0.00", "finite ERA accepted");
assert.equal(
  resolveStarterPitcher("곽빈", 2, "9.99", "다른투수").era,
  tableEra("68220"),
  "box ERA from a different identity cannot contaminate the starter",
);
assert.equal(
  resolveStarterPitcher("곽빈", 2, "1.11", "곽빈").era,
  "1.11",
  "matching in-game box ERA takes priority over season fallback",
);
assert.equal(
  resolveStarterPitcher("양현종", 1).era,
  "-",
  "same-name or stale stats from another team fail closed",
);
assert.equal(
  resolveStarterPitcher("배제성", 3, undefined, undefined).era,
  tableEra("65516"),
  "partial or unavailable box stats retain the identity-bound season fallback",
);
assert.deepEqual(
  resolveLineupStarter({
    liveStarterName: "곽빈",
    lineupStarterName: "곽빈",
    liveStarterFresh: true,
    lineupStarterTrusted: true,
    lineupSource: "kbo-confirmed",
    teamId: 2,
    boxPitcher: { name: "이영하", era: "1.23" },
  }),
  { name: "곽빈", era: tableEra("68220"), kboId: "68220" },
  "a reliever-first box must not replace the official starter or contaminate ERA",
);
assert.deepEqual(
  resolveLineupStarter({
    liveStarterName: "타케다",
    lineupStarterName: "화이트",
    liveStarterFresh: true,
    lineupStarterTrusted: true,
    lineupSource: "kbo-confirmed",
    teamId: 4,
    boxPitcher: { name: "다른투수", era: "9.99" },
  }),
  // 외국인 canonical(영문 FP007) → 숫자 55855 역매핑 경로.
  { name: "화이트", era: tableEra("55855"), kboId: "FP007" },
  "a mismatched live value cannot supersede the confirmed lineup by request timing",
);
assert.deepEqual(
  resolveLineupStarter({
    lineupStarterName: "김윤하",
    liveStarterFresh: false,
    lineupStarterTrusted: true,
    lineupSource: "kbo-confirmed",
    teamId: 10,
    boxPitcher: { name: "이강준", era: "3.21" },
  }),
  { name: "김윤하", era: tableEra("54319"), kboId: "54319" },
  "lineup starter remains canonical when box contains only a reliever",
);
assert.deepEqual(
  resolveLineupStarter({
    liveStarterName: "곽빈",
    lineupStarterName: "곽빈",
    liveStarterFresh: true,
    lineupStarterTrusted: true,
    teamId: 2,
    boxPitcher: { name: "곽빈", era: "1.11" },
  }),
  { name: "곽빈", era: "1.11", kboId: "68220" },
  "matching box starter ERA takes priority after game start",
);
const productionPartialPayload = {
  liveGame: { awayStarterName: null },
  detailLineup: { isToday: true, awayStarter: null },
  boxScore: { awayPitchers: [{ name: "이영하", era: "1.23" }] },
};
assert.deepEqual(
  resolveLineupStarter({
    liveStarterName: productionPartialPayload.liveGame.awayStarterName,
    lineupStarterName: productionPartialPayload.detailLineup.awayStarter,
    liveStarterFresh: false,
    lineupStarterTrusted: productionPartialPayload.detailLineup.isToday,
    teamId: 2,
    boxPitcher: productionPartialPayload.boxScore.awayPitchers[0],
  }),
  { name: "", era: "-", kboId: undefined },
  "no canonical starter must not promote the first box reliever",
);
assert.deepEqual(
  resolveLineupStarter({
    liveStarterFresh: false,
    lineupStarterTrusted: true,
    teamId: 2,
    boxPitcher: { name: "선수(66291)", era: "1.23" },
  }),
  { name: "", era: "-", kboId: undefined },
  "placeholder-only box rows fail closed without a canonical starter",
);
assert.deepEqual(
  resolveLineupStarter({
    liveStarterName: "이영하",
    lineupStarterName: "곽빈",
    liveStarterFresh: false,
    lineupStarterTrusted: true,
    teamId: 2,
  }),
  { name: "곽빈", era: tableEra("68220"), kboId: "68220" },
  "a stale live mismatch yields to the trusted confirmed lineup",
);
assert.deepEqual(
  resolveLineupStarter({
    liveStarterName: "화이트",
    lineupStarterName: "타케다",
    liveStarterFresh: true,
    lineupStarterTrusted: true,
    teamId: 4,
  }),
  { name: "타케다", era: tableEra("56823"), kboId: "56823" },
  "a later-request stale live mismatch yields to the confirmed lineup",
);
assert.deepEqual(
  resolveStarterPitcher("미등록투수", 1, "-"),
  { name: "미등록투수", era: "-", kboId: undefined },
  "unknown pitcher fails closed without guessing",
);

const previewTrusted = isLineupStarterProvenanceTrusted({
  source: "naver-preview",
  awayBatters: 0,
  homeBatters: 0,
  isAllStar: false,
});
assert.equal(previewTrusted, true, "identity-verified Naver preview-only starters are trusted");
assert.deepEqual(
  resolveLineupStarter({
    liveStarterName: null,
    lineupStarterName: "곽빈",
    liveStarterFresh: false,
    lineupStarterTrusted: previewTrusted,
    lineupSource: "naver-preview",
    teamId: 2,
  }),
  { name: "곽빈", era: tableEra("68220"), kboId: "68220" },
  "live failure + Naver preview-only preserves starter identity and season ERA",
);
assert.deepEqual(
  resolveLineupStarter({
    liveStarterName: "타케다",
    lineupStarterName: "화이트",
    liveStarterFresh: true,
    lineupStarterTrusted: previewTrusted,
    lineupSource: "naver-preview",
    teamId: 4,
  }),
  { name: "타케다", era: tableEra("56823"), kboId: "56823" },
  "preview-only is fallback and cannot supersede a current live starter",
);
assert.equal(
  isLineupStarterProvenanceTrusted({
    source: "naver-preview",
    awayBatters: 1,
    homeBatters: 0,
    isAllStar: false,
  }),
  false,
  "partial preview shape fails closed",
);
assert.equal(
  isLineupStarterProvenanceTrusted({
    source: "none",
    awayBatters: 0,
    homeBatters: 0,
    isAllStar: false,
  }),
  false,
  "dual-source failure cannot manufacture starter provenance",
);

assert.deepEqual(
  resolveLineupStarter({
    liveStarterName: "화이트",
    lineupStarterName: "타케다",
    liveStarterFresh: true,
    lineupStarterTrusted: true,
    lineupSource: "kbo-confirmed",
    teamId: 4,
  }),
  { name: "타케다", era: tableEra("56823"), kboId: "56823" },
  "confirmed lineup remains monotonic across repeated later stale live polls",
);
assert.equal(shouldPreserveCanonicalLineup("kbo-confirmed", "none"), true);
assert.equal(shouldPreserveCanonicalLineup("naver-preview", "kbo-unconfirmed"), true);
assert.equal(shouldPreserveCanonicalLineup("kbo-confirmed", "naver-preview"), true);
assert.equal(shouldPreserveCanonicalLineup("kbo-confirmed", "naver-confirmed"), true);
assert.equal(shouldPreserveCanonicalLineup("naver-confirmed", "kbo-confirmed"), false);
assert.equal(shouldCommitResponse(8, 7), false, "older in-flight response generation is fenced");
assert.equal(shouldCommitResponse(8, 8), true, "latest response generation commits");

const gamePage = readFileSync("src/app/(main)/games/[gameId]/page.tsx", "utf8");
assert.equal(
  (gamePage.match(/boxPitcher: gameDetail\?\.boxScore\?\.(?:away|home)Pitchers\?\.\[0\]/g) ?? []).length,
  2,
  "both official-lineup sides must pass box identity separately from starter identity",
);
assert.ok(
  gamePage.includes("liveStarterName: liveGame?.awayStarterName")
    && gamePage.includes("lineupStarterName: d.detailLineup?.awayStarter")
    && gamePage.includes("liveStarterName: liveGame?.homeStarterName")
    && gamePage.includes("lineupStarterName: d.detailLineup?.homeStarter")
    && gamePage.includes("liveStarterFresh = Boolean(liveSnapshot)")
    && gamePage.includes("lineupSource: detailSnapshot?.lineupSource")
    && gamePage.includes("isLineupStarterProvenanceTrusted"),
  "page binds starter selection to actual live success and lineup provenance",
);
const detailHook = readFileSync("src/lib/hooks/useGameDetail.ts", "utf8");
assert.ok(
  detailHook.includes("shouldPreserveCanonicalLineup")
    && detailHook.includes("lineup: dataRef.current.lineup"),
  "actual detail polling cannot downgrade a canonical lineup to none/unconfirmed",
);

console.log("starter ERA smoke: ALL assertions PASS");
