/**
 * 선발 ERA 해석 계약 스모크.
 *
 * 2026-08-03 구조 변경 — 이전 판은 곽빈 `2.64` 등 *실제 시즌 방어율*을 기대값으로
 * 하드코딩한 뒤 그 값을 `stats-2026-pitchers.json`(매일 크롤로 갱신되는 바로 그 파일)
 * 에서 조회해 비교했다. 선발이 등판해 ERA가 바뀌는 순간 RED가 되어 prebuild가 깨지고
 * roster/stats 자동 업데이트 PR이 3일간 머지되지 못했다(#1059·#1086). 데이터 결함을
 * 잡는 게이트가 아니라 데이터 갱신 자체를 막는 순환 참조였다.
 *
 * 그래서 *로직 계약*은 움직이지 않는 fixture로 검증하고(아래 §1),
 * *프로덕션 바인딩*은 값이 아니라 불변식으로 검증한다(§2).
 * 값이 바뀌어도 RED가 되지 않고, 로직이 무너지면 RED가 된다.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createPitcherSeasonResolver,
  lookupPitcherSeasonEra as productionLookupEra,
  normalizePitcherEra,
  resolveStarterPitcher as productionResolveStarter,
  type PitcherSeasonRow,
} from "../../src/lib/stats/pitcher-season";
import { resolveRosterPlayer } from "../../src/lib/utils/player-roster";
import {
  isLineupStarterProvenanceTrusted,
  shouldCommitResponse,
  shouldPreserveCanonicalLineup,
} from "../../src/lib/source-snapshot";

/* ────────────────────────────────────────────────────────────────
 * §1. 로직 계약 — 고정 fixture (실 stats/roster JSON과 무관)
 * ──────────────────────────────────────────────────────────────── */

/** 팀 2 = 선발 후보, 팀 4 = 외국인 canonical ID(숫자↔영문 역매핑) 케이스. */
const FIXTURE_ROSTER = [
  { name: "선발가", kboId: "10001", teamId: 2 },
  { name: "구원가", kboId: "10002", teamId: 2 },
  { name: "동명가", kboId: "10003", teamId: 2 },
  { name: "동명가", kboId: "10004", teamId: 6 }, // 동명이인 — 팀으로만 분리 가능
  { name: "외인가", kboId: "FX001", teamId: 4 }, // stats에는 숫자 ID로만 존재
  { name: "무기록", kboId: "10005", teamId: 2 }, // roster에는 있으나 stats 없음
] as const;

const FIXTURE_NUMERIC: Record<string, string> = { FX001: "59001" };

const FIXTURE_PITCHERS: PitcherSeasonRow[] = [
  { kboId: "10001", playerId: "10001", era: "2.64" },
  { kboId: "10002", playerId: "10002", era: "1.23" },
  { kboId: "10003", playerId: "10003", era: "3.30" },
  { kboId: "10004", playerId: "10004", era: "4.52" },
  { kboId: "59001", playerId: "59001", era: "7.10" }, // 외국인은 숫자 ID로만 적재
];

const {
  lookupPitcherSeasonEra,
  resolveStarterPitcher,
  resolveLineupStarter,
} = createPitcherSeasonResolver({
  pitcherRows: FIXTURE_PITCHERS,
  resolveRoster: ({ name, teamId }) => {
    const hit = FIXTURE_ROSTER.find((p) => p.name === name && p.teamId === teamId);
    return hit ? { kboId: hit.kboId } : null;
  },
  toNumericId: (kboId) => FIXTURE_NUMERIC[kboId],
});

// 시즌 기록 조회 — canonical ID / 숫자 역매핑 / fail-close
assert.equal(lookupPitcherSeasonEra("10001"), "2.64", "canonical ID로 시즌 ERA 조회");
assert.equal(
  lookupPitcherSeasonEra("FX001"),
  "7.10",
  "외국인 canonical ID는 숫자 ID로 역매핑해 조회",
);
assert.equal(lookupPitcherSeasonEra("missing"), null, "unknown pitcher fails closed");
assert.equal(lookupPitcherSeasonEra(undefined), null, "빈 ID는 조회하지 않는다");
assert.equal(lookupPitcherSeasonEra("10005"), null, "roster에 있어도 기록 없으면 fail-close");

// ERA 정규화
assert.equal(normalizePitcherEra("-"), null, "placeholder ERA rejected");
assert.equal(normalizePitcherEra("N/A"), null, "non-numeric ERA rejected");
assert.equal(normalizePitcherEra("0.00"), "0.00", "finite ERA accepted");
assert.equal(normalizePitcherEra(null), null, "null ERA rejected");

// 동명이인은 팀으로 분리
assert.equal(
  resolveStarterPitcher("동명가", 2).era,
  "3.30",
  "동명이인은 요청 팀의 정본으로 해석",
);
assert.equal(
  resolveStarterPitcher("동명가", 6).era,
  "4.52",
  "같은 이름이라도 다른 팀은 그 팀의 정본",
);

// box ERA는 identity가 일치할 때만 채택
assert.equal(
  resolveStarterPitcher("선발가", 2, "9.99", "구원가").era,
  "2.64",
  "box ERA from a different identity cannot contaminate the starter",
);
assert.equal(
  resolveStarterPitcher("선발가", 2, "2.66", "선발가").era,
  "2.66",
  "matching in-game box ERA takes priority over season fallback",
);
assert.equal(
  resolveStarterPitcher("선발가", 2, undefined, undefined).era,
  "2.64",
  "partial or unavailable box stats retain the identity-bound season fallback",
);
assert.equal(
  resolveStarterPitcher("선발가", 2, "N/A", "선발가").era,
  "2.64",
  "identity가 맞아도 비정상 box ERA는 시즌 기록으로 되돌아간다",
);
assert.equal(
  resolveStarterPitcher("동명가", 4).era,
  "-",
  "same-name or stale stats from another team fail closed",
);
assert.deepEqual(
  resolveStarterPitcher("미등록투수", 2, "-"),
  { name: "미등록투수", era: "-", kboId: undefined },
  "unknown pitcher fails closed without guessing",
);

// confirmed lineup vs live — 정책 계약
assert.deepEqual(
  resolveLineupStarter({
    liveStarterName: "선발가",
    lineupStarterName: "선발가",
    liveStarterFresh: true,
    lineupStarterTrusted: true,
    lineupSource: "kbo-confirmed",
    teamId: 2,
    boxPitcher: { name: "구원가", era: "1.23" },
  }),
  { name: "선발가", era: "2.64", kboId: "10001" },
  "a reliever-first box must not replace the official starter or contaminate ERA",
);
assert.deepEqual(
  resolveLineupStarter({
    liveStarterName: "동명가",
    lineupStarterName: "선발가",
    liveStarterFresh: true,
    lineupStarterTrusted: true,
    lineupSource: "kbo-confirmed",
    teamId: 2,
    boxPitcher: { name: "구원가", era: "9.99" },
  }),
  { name: "선발가", era: "2.64", kboId: "10001" },
  "a mismatched live value cannot supersede the confirmed lineup by request timing",
);
assert.deepEqual(
  resolveLineupStarter({
    lineupStarterName: "선발가",
    liveStarterFresh: false,
    lineupStarterTrusted: true,
    lineupSource: "kbo-confirmed",
    teamId: 2,
    boxPitcher: { name: "구원가", era: "1.23" },
  }),
  { name: "선발가", era: "2.64", kboId: "10001" },
  "lineup starter remains canonical when box contains only a reliever",
);
assert.deepEqual(
  resolveLineupStarter({
    liveStarterName: "선발가",
    lineupStarterName: "선발가",
    liveStarterFresh: true,
    lineupStarterTrusted: true,
    teamId: 2,
    boxPitcher: { name: "선발가", era: "2.66" },
  }),
  { name: "선발가", era: "2.66", kboId: "10001" },
  "matching box starter ERA takes priority after game start",
);
const productionPartialPayload = {
  liveGame: { awayStarterName: null },
  detailLineup: { isToday: true, awayStarter: null },
  boxScore: { awayPitchers: [{ name: "구원가", era: "1.23" }] },
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
    liveStarterName: "구원가",
    lineupStarterName: "선발가",
    liveStarterFresh: false,
    lineupStarterTrusted: true,
    teamId: 2,
  }),
  { name: "선발가", era: "2.64", kboId: "10001" },
  "a stale live mismatch yields to the trusted confirmed lineup",
);
assert.deepEqual(
  resolveLineupStarter({
    liveStarterName: "구원가",
    lineupStarterName: "선발가",
    liveStarterFresh: true,
    lineupStarterTrusted: true,
    teamId: 2,
  }),
  { name: "선발가", era: "2.64", kboId: "10001" },
  "a later-request stale live mismatch yields to the confirmed lineup",
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
    lineupStarterName: "선발가",
    liveStarterFresh: false,
    lineupStarterTrusted: previewTrusted,
    lineupSource: "naver-preview",
    teamId: 2,
  }),
  { name: "선발가", era: "2.64", kboId: "10001" },
  "live failure + Naver preview-only preserves starter identity and season ERA",
);
assert.deepEqual(
  resolveLineupStarter({
    liveStarterName: "구원가",
    lineupStarterName: "선발가",
    liveStarterFresh: true,
    lineupStarterTrusted: previewTrusted,
    lineupSource: "naver-preview",
    teamId: 2,
  }),
  { name: "구원가", era: "1.23", kboId: "10002" },
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
    liveStarterName: "구원가",
    lineupStarterName: "선발가",
    liveStarterFresh: true,
    lineupStarterTrusted: true,
    lineupSource: "kbo-confirmed",
    teamId: 2,
  }),
  { name: "선발가", era: "2.64", kboId: "10001" },
  "confirmed lineup remains monotonic across repeated later stale live polls",
);
assert.equal(shouldPreserveCanonicalLineup("kbo-confirmed", "none"), true);
assert.equal(shouldPreserveCanonicalLineup("naver-preview", "kbo-unconfirmed"), true);
assert.equal(shouldPreserveCanonicalLineup("kbo-confirmed", "naver-preview"), true);
assert.equal(shouldPreserveCanonicalLineup("kbo-confirmed", "naver-confirmed"), true);
assert.equal(shouldPreserveCanonicalLineup("naver-confirmed", "kbo-confirmed"), false);
assert.equal(shouldCommitResponse(8, 7), false, "older in-flight response generation is fenced");
assert.equal(shouldCommitResponse(8, 8), true, "latest response generation commits");

/* ────────────────────────────────────────────────────────────────
 * §2. 프로덕션 바인딩 — 값이 아니라 불변식으로 검증
 *     (크롤로 매일 바뀌는 수치를 기대값으로 쓰지 않는다)
 * ──────────────────────────────────────────────────────────────── */

const pitcherRows = JSON.parse(
  readFileSync("src/lib/constants/stats-2026-pitchers.json", "utf8"),
) as PitcherSeasonRow[];

assert.ok(pitcherRows.length > 0, "프로덕션 투수 기록 테이블이 비어 있으면 안 된다");

// 실 데이터에서 임의 표본을 골라 "테이블에 있는 값 그대로" 되돌아오는지만 본다.
// 어떤 수치인지는 검증하지 않으므로 크롤 갱신에 영향받지 않는다.
const eraRows = pitcherRows.filter((row) => normalizePitcherEra(row.era) !== null);
assert.ok(eraRows.length > 0, "정상 ERA를 가진 투수가 최소 1명은 있어야 한다");
for (const row of eraRows.slice(0, 25)) {
  const id = String(row.kboId ?? row.playerId);
  assert.equal(
    productionLookupEra(id),
    normalizePitcherEra(row.era),
    `프로덕션 바인딩이 ${id}의 테이블 값을 그대로 반환해야 한다`,
  );
}
assert.equal(
  productionLookupEra("__nonexistent_pitcher__"),
  null,
  "프로덕션 바인딩도 미등록 ID는 fail-close",
);

// 프로덕션 roster/stats로도 identity 오염 차단이 실제로 동작하는지 —
// 실 로스터에서 같은 팀의 서로 다른 두 투수를 골라 검증한다(수치 무관).
const rosterRows = JSON.parse(
  readFileSync("src/lib/constants/players-roster.json", "utf8"),
) as { name: string; kboId: string; teamId: number }[];
const eraIds = new Set(eraRows.map((row) => String(row.kboId ?? row.playerId)));
const byTeam = new Map<number, { name: string; kboId: string }[]>();
for (const p of rosterRows) {
  const numeric = String(p.kboId);
  if (!eraIds.has(numeric)) continue;
  // 동명이인은 이름 매칭이 팀 안에서도 갈릴 수 있어 제외한다.
  if (rosterRows.filter((q) => q.name === p.name && q.teamId === p.teamId).length !== 1) continue;
  const list = byTeam.get(p.teamId) ?? [];
  list.push({ name: p.name, kboId: p.kboId });
  byTeam.set(p.teamId, list);
}
const pairTeam = [...byTeam.entries()].find(([, list]) => list.length >= 2);
assert.ok(pairTeam, "실 로스터에서 같은 팀의 기록 보유 투수 2명을 찾을 수 있어야 한다");
const [teamId, [starter, other]] = pairTeam!;
const starterSeasonEra = productionLookupEra(starter.kboId);
assert.equal(
  productionResolveStarter(starter.name, teamId, "99.99", other.name).era,
  starterSeasonEra,
  "프로덕션 바인딩에서도 다른 투수의 box ERA는 선발을 오염시키지 못한다",
);
assert.equal(
  productionResolveStarter(starter.name, teamId, "9.99", starter.name).era,
  "9.99",
  "프로덕션 바인딩에서도 동일 identity의 box ERA는 채택된다",
);
assert.equal(
  productionResolveStarter("__없는투수__", teamId).era,
  "-",
  "프로덕션 바인딩에서도 미등록 선발은 추측하지 않는다",
);
assert.ok(
  resolveRosterPlayer({ name: starter.name, teamId })?.kboId === starter.kboId,
  "프로덕션 roster 해석기가 표본 선수를 canonical ID로 되돌려야 한다",
);

/* ────────────────────────────────────────────────────────────────
 * §3. 실제 배선 — 호출부가 계약대로 연결돼 있는지
 * ──────────────────────────────────────────────────────────────── */

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

// 프로덕션 바인딩이 실제 stats/roster JSON에 연결돼 있는지 (fixture로 갈아끼워진 채
// 배포되면 §2가 통과해도 서비스는 빈 값이 된다).
const resolverSource = readFileSync("src/lib/stats/pitcher-season.ts", "utf8");
assert.ok(
  resolverSource.includes('import pitcherStatsJson from "@/lib/constants/stats-2026-pitchers.json"')
    && resolverSource.includes("pitcherRows: pitcherStatsJson as PitcherSeasonRow[]")
    && resolverSource.includes("resolveRoster: ({ name, teamId }) => resolveRosterPlayer({ name, teamId })")
    && resolverSource.includes("toNumericId: (kboId) => resolvePlayerIdentity(kboId)?.numericId"),
  "프로덕션 resolver는 실제 stats/roster에 바인딩되어야 한다",
);

console.log("starter ERA smoke: ALL assertions PASS");
