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
  resolveLineupStarter as productionResolveLineupStarter,
  resolveStarterPitcher as productionResolveStarter,
  type PitcherSeasonRow,
} from "../../src/lib/stats/pitcher-season";
import { resolveRosterPlayer } from "../../src/lib/utils/player-roster";
import { FOREIGN_NUMERIC_TO_ALPHA } from "../../src/lib/constants/foreign-id-map";
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
  // 별칭 — 중계/박스스코어 표기가 로스터 등록명과 달라도 같은 canonical ID로 해석된다.
  // 이름 완전일치만 남기면 이 케이스가 box ERA를 잃는다.
  { name: "선발", kboId: "10001", teamId: 2 },
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
// 이름 표기가 달라도 canonical ID가 같으면 동일 identity — box ERA를 채택해야 한다.
// (이름 완전일치만 남기면 별칭 표기에서 현재 box ERA를 잃고 시즌값으로 후퇴한다.)
assert.equal(
  resolveStarterPitcher("선발가", 2, "2.66", "선발").era,
  "2.66",
  "같은 canonical ID면 표기가 달라도 box ERA를 채택한다",
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
// naver-confirmed도 confirmed 등급이다 — kbo-confirmed와 동일하게 fresh live mismatch를 이긴다.
// (lineupConfirmed에서 naver-confirmed를 빼면 이 케이스가 fresh live로 밀린다.)
assert.deepEqual(
  resolveLineupStarter({
    liveStarterName: "구원가",
    lineupStarterName: "선발가",
    liveStarterFresh: true,
    lineupStarterTrusted: true,
    lineupSource: "naver-confirmed",
    teamId: 2,
  }),
  { name: "선발가", era: "2.64", kboId: "10001" },
  "naver-confirmed도 confirmed 등급으로 fresh live mismatch를 이긴다",
);
// unconfirmed 소스는 confirmed 대우를 받지 못한다 — fresh live가 이긴다(반대 방향 경계).
assert.deepEqual(
  resolveLineupStarter({
    liveStarterName: "구원가",
    lineupStarterName: "선발가",
    liveStarterFresh: true,
    lineupStarterTrusted: true,
    lineupSource: "kbo-unconfirmed",
    teamId: 2,
  }),
  { name: "구원가", era: "1.23", kboId: "10002" },
  "unconfirmed 라인업은 fresh live를 누르지 못한다",
);
// untrusted 라인업은 live가 없어도 선발로 승격되지 않는다(fail-close).
// (lineupStarterTrusted fallback을 무시하면 미신뢰 선발이 그대로 노출된다.)
assert.deepEqual(
  resolveLineupStarter({
    liveStarterName: null,
    lineupStarterName: "선발가",
    liveStarterFresh: false,
    lineupStarterTrusted: false,
    lineupSource: "kbo-unconfirmed",
    teamId: 2,
  }),
  { name: "", era: "-", kboId: undefined },
  "untrusted 라인업 선발은 채택하지 않는다",
);
// KBO가 선발명을 `선수(66291)` placeholder로 내려주면 box 행도 같은 placeholder다.
// 이때 이름이 "같다"는 이유로 box ERA를 채택하면 정체불명 선수의 기록이 노출된다.
// (`^선수\(\d+\)$` 가드를 제거하면 `-` 대신 `1.23`이 나간다 — 실측 확인함.)
assert.deepEqual(
  resolveLineupStarter({
    liveStarterName: "선수(66291)",
    liveStarterFresh: true,
    lineupStarterTrusted: false,
    teamId: 2,
    boxPitcher: { name: "선수(66291)", era: "1.23" },
  }),
  { name: "선수(66291)", era: "-", kboId: undefined },
  "placeholder 선발명은 동일 placeholder box ERA를 채택하지 못한다",
);
// canonical 선발이 있는 경우의 placeholder box도 오염원이 되지 않는다.
assert.deepEqual(
  resolveLineupStarter({
    liveStarterName: "선발가",
    lineupStarterName: "선발가",
    liveStarterFresh: true,
    lineupStarterTrusted: true,
    lineupSource: "kbo-confirmed",
    teamId: 2,
    boxPitcher: { name: "선수(66291)", era: "1.23" },
  }),
  { name: "선발가", era: "2.64", kboId: "10001" },
  "placeholder box 행은 canonical 선발의 ERA를 오염하지 못한다",
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

// 외국인 canonical(영문) → 숫자 ID 역매핑을 *프로덕션 데이터로* 태운다.
// stats-2026-pitchers.json은 현재 276/276이 전부 숫자 ID라, 위의 표본 루프는
// FP/AQ 경로를 절대 밟지 못한다(삼순 지적 — 이 구간이 false-green이었다).
//
// 중요: 표본을 `resolvePlayerIdentity`로 고르면 그 함수가 깨지는 순간 표본이 비어
// "검증할 게 없다"로 빠져나간다. 그래서 표본은 검증 대상 함수가 아니라
// SSOT 상수(FOREIGN_NUMERIC_TO_ALPHA)에서 직접 도출한다.
const alphaToNumericSsot = new Map(
  Object.entries(FOREIGN_NUMERIC_TO_ALPHA).map(([numeric, alpha]) => [alpha, numeric]),
);
const foreignWithStats = rosterRows.filter((p) => {
  const numeric = alphaToNumericSsot.get(String(p.kboId));
  return Boolean(numeric && eraIds.has(numeric));
});
assert.ok(
  foreignWithStats.length > 0,
  "영문 canonical ID로 등록된 외국인 투수 중 시즌 기록 보유자가 최소 1명은 있어야 한다",
);
for (const foreign of foreignWithStats) {
  const numericId = alphaToNumericSsot.get(String(foreign.kboId))!;
  const tableEra = normalizePitcherEra(
    eraRows.find((row) => String(row.kboId ?? row.playerId) === numericId)?.era,
  );
  assert.equal(
    productionLookupEra(foreign.kboId),
    tableEra,
    `외국인 canonical ${foreign.kboId}가 숫자 ${numericId} 기록으로 역매핑되어야 한다`,
  );
  assert.equal(
    productionResolveStarter(foreign.name, foreign.teamId).era,
    tableEra,
    `외국인 ${foreign.name} 선발 해석이 시즌 ERA로 이어져야 한다`,
  );
}

/* 페이지가 실제로 import하는 것은 factory 반환값이 아니라 *export된* `resolveLineupStarter`다.
 * 그 export를 live-only wrapper로 갈아끼워도 직전까지는 전체 prebuild가 GREEN이었다
 * (삼순 2차 지적). §1은 factory 반환 함수를, §2는 lookup/resolveStarter만 태웠기 때문이다.
 * 그래서 여기서는 production export 자체를 실 로스터·실 stats로 호출해 정책을 검증한다. */
const [prodStarter, prodOther] = pairTeam![1];
const prodTeamId = pairTeam![0];
const prodStarterEra = productionLookupEra(prodStarter.kboId);
const prodOtherEra = productionLookupEra(prodOther.kboId);
assert.ok(
  prodStarterEra && prodOtherEra && prodStarterEra !== prodOtherEra,
  "프로덕션 정책 검증은 ERA가 서로 다른 두 투수가 필요하다",
);

// confirmed 라인업은 fresh live mismatch를 이긴다 (kbo/naver 양쪽 등급).
for (const source of ["kbo-confirmed", "naver-confirmed"] as const) {
  assert.deepEqual(
    productionResolveLineupStarter({
      liveStarterName: prodOther.name,
      lineupStarterName: prodStarter.name,
      liveStarterFresh: true,
      lineupStarterTrusted: true,
      lineupSource: source,
      teamId: prodTeamId,
    }),
    { name: prodStarter.name, era: prodStarterEra, kboId: prodStarter.kboId },
    `프로덕션 export도 ${source} 라인업을 fresh live보다 우선한다`,
  );
}
// unconfirmed는 confirmed 대우를 받지 못하고 fresh live가 이긴다 (반대 경계).
assert.deepEqual(
  productionResolveLineupStarter({
    liveStarterName: prodOther.name,
    lineupStarterName: prodStarter.name,
    liveStarterFresh: true,
    lineupStarterTrusted: true,
    lineupSource: "kbo-unconfirmed",
    teamId: prodTeamId,
  }),
  { name: prodOther.name, era: prodOtherEra, kboId: prodOther.kboId },
  "프로덕션 export에서 unconfirmed 라인업은 fresh live를 누르지 못한다",
);
// live가 없을 때만 trusted 라인업으로 폴백하고, untrusted면 fail-close한다.
assert.deepEqual(
  productionResolveLineupStarter({
    liveStarterName: null,
    lineupStarterName: prodStarter.name,
    liveStarterFresh: false,
    lineupStarterTrusted: true,
    teamId: prodTeamId,
  }),
  { name: prodStarter.name, era: prodStarterEra, kboId: prodStarter.kboId },
  "프로덕션 export는 live 실패 시 trusted 라인업으로 폴백한다",
);
assert.deepEqual(
  productionResolveLineupStarter({
    liveStarterName: null,
    lineupStarterName: prodStarter.name,
    liveStarterFresh: false,
    lineupStarterTrusted: false,
    teamId: prodTeamId,
  }),
  { name: "", era: "-", kboId: undefined },
  "프로덕션 export도 untrusted 라인업 선발은 채택하지 않는다",
);
// box identity — 다른 투수의 box ERA는 오염원이 되지 못하고, 동일 identity만 채택된다.
assert.equal(
  productionResolveLineupStarter({
    liveStarterName: prodStarter.name,
    lineupStarterName: prodStarter.name,
    liveStarterFresh: true,
    lineupStarterTrusted: true,
    lineupSource: "kbo-confirmed",
    teamId: prodTeamId,
    boxPitcher: { name: prodOther.name, era: "99.99" },
  }).era,
  prodStarterEra,
  "프로덕션 export에서도 다른 투수 box ERA는 선발을 오염하지 못한다",
);
assert.equal(
  productionResolveLineupStarter({
    liveStarterName: prodStarter.name,
    lineupStarterName: prodStarter.name,
    liveStarterFresh: true,
    lineupStarterTrusted: true,
    lineupSource: "kbo-confirmed",
    teamId: prodTeamId,
    boxPitcher: { name: prodStarter.name, era: "9.99" },
  }).era,
  "9.99",
  "프로덕션 export에서 동일 identity box ERA는 채택된다",
);
// placeholder box는 canonical 선발을 오염하지 못한다.
assert.equal(
  productionResolveLineupStarter({
    liveStarterName: prodStarter.name,
    lineupStarterName: prodStarter.name,
    liveStarterFresh: true,
    lineupStarterTrusted: true,
    lineupSource: "kbo-confirmed",
    teamId: prodTeamId,
    boxPitcher: { name: "선수(66291)", era: "1.23" },
  }).era,
  prodStarterEra,
  "프로덕션 export에서 placeholder box는 canonical 선발을 오염하지 못한다",
);
assert.deepEqual(
  productionResolveLineupStarter({
    liveStarterName: "선수(66291)",
    liveStarterFresh: true,
    lineupStarterTrusted: false,
    teamId: prodTeamId,
    boxPitcher: { name: "선수(66291)", era: "1.23" },
  }),
  { name: "선수(66291)", era: "-", kboId: undefined },
  "프로덕션 export에서 placeholder 선발명은 동일 placeholder box ERA를 채택하지 못한다",
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

// shouldCommitResponse는 "존재하느냐"가 아니라 *커밋보다 앞이냐*가 핵심이다.
// 개수·존재만 보면 같은 문장을 setData/setSnapshot 뒤로 옆겨도 GREEN이 되고,
// 그 상태에서는 늦게 도착한 구세대 응답이 이미 커밋된 뒤다(삼순 2차 지적).
// 그래서 위치 관계를 고정한다: fetch 파싱 뒤 ∧ 모든 커밋 지점보다 앞.
assert.ok(
  /const responseGeneration = \+\+responseGenerationRef\.current;/.test(detailHook),
  "응답 generation은 요청당 1회 증가해야 한다",
);
assert.equal(
  (detailHook.match(
    /shouldCommitResponse\(responseGenerationRef\.current, responseGeneration\)/g,
  ) ?? []).length,
  3,
  "성공·예외·finally 세 커밋 지점 전부 generation 펌스를 통과해야 한다",
);

const guardIdx = detailHook.indexOf(
  "if (!shouldCommitResponse(responseGenerationRef.current, responseGeneration)) return;",
);
assert.ok(guardIdx >= 0, "fetch 직후 구세대 응답은 조기 반환되어야 한다");

const parseIdx = detailHook.indexOf("const json = await res.json()");
assert.ok(parseIdx >= 0, "응답 파싱 지점을 찾을 수 있어야 한다");
assert.ok(
  parseIdx < guardIdx,
  "generation 펌스는 응답 파싱 뒤에 있어야 한다(파싱 전이면 경쟁 창을 닫지 못함)",
);

// 늦게 도착한 응답이 닿을 수 있는 모든 상태 커밋 지점. 하나라도 펌스보다 앞이면
// stale 응답이 현재 데이터를 덮어쓴다.
const commitSites = [
  "dataRef.current = committedData;",
  "snapshotRef.current = committedSnapshot;",
  "setData(committedData);",
  "setSnapshot(committedSnapshot);",
] as const;
for (const site of commitSites) {
  const idx = detailHook.indexOf(site);
  assert.ok(idx >= 0, `커밋 지점 \`${site}\`을 찾을 수 있어야 한다`);
  assert.ok(
    guardIdx < idx,
    `generation 펌스는 \`${site}\` 보다 앞에 있어야 한다(stale 응답의 선커밋 방지)`,
  );
}
// 오류 경로의 setError도 마찬가지 — 구세대 실패가 현재 화면을 에러로 덮으면 안 된다.
const firstSetErrorIdx = detailHook.indexOf("setError(json.error ||");
assert.ok(firstSetErrorIdx >= 0, "HTTP 오류 커밋 지점을 찾을 수 있어야 한다");
assert.ok(
  guardIdx < firstSetErrorIdx,
  "generation 펌스는 HTTP 오류 setError보다도 앞에 있어야 한다",
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
