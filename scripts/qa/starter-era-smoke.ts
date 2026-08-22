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
import ts from "typescript";
import {
  createPitcherSeasonResolver,
  lookupPitcherSeasonEra as productionLookupEra,
  normalizePitcherEra,
  resolveLineupStarter as productionResolveLineupStarter,
  resolveStarterPitcher as productionResolveStarter,
  type PitcherSeasonRow,
} from "../../src/lib/stats/pitcher-season";
import { resolveRosterPlayer } from "../../src/lib/utils/player-roster";
import { resolvePlayerIdentity, resolveRosterCandidates } from "../../src/lib/utils/resolve-player";
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

/* main(#1098)이 이 파일에 갖고 있던 동명이인 계약을 **값 비의존 형태로** 보존한다.
 * 원본은 `양현종 → "4.52"` 처럼 특정 선수 + 고정 수치였고, 병합 뒤 `tableEra("77637")`
 * 로 바뀌어 있었다. 둘 다 특정 kboId를 하드코딩하므로 로스터가 바뀌면 깨진다.
 *
 * 계약의 본질은 "이름이 같아도 팀이 다르면 그 팀의 canonical ID로 해석된다"이므로,
 * 표본을 실 로스터에서 **동적으로** 고르고 값은 테이블에서 읽어 대조한다.
 * 값이 바뀌어도 RED가 되지 않고, 팀 분리가 깨지면 RED가 된다. */
const dupNames = new Map<string, { name: string; kboId: string; teamId: number }[]>();
for (const p of rosterRows) {
  if (!eraIds.has(String(p.kboId))) continue;
  const list = dupNames.get(p.name) ?? [];
  list.push(p);
  dupNames.set(p.name, list);
}
/* ⚠︎ 표본은 **팀 안에서 유일한** 이름만 쓴다.
 * 같은 팀에 같은 이름이 둘이면(예: 삼성 김태훈 = 투수 62360 + 야수 65040) 이름+팀은
 * 애초에 유일키가 아니라서 해석기가 fail-close 한다 — 그건 아래 §동명이인 절에서 따로 본다.
 * 예전에는 그런 이름도 표본에 섞였고, 해석기가 배열에서 먼저 만나는 사람을 돌려주는 걸
 * "정답"으로 굳히고 있었다(2026-08-08 #1130: 크롤 순서가 밀리자 ERA 가 3.65 → null). */
const uniqueInTeam = (name: string, teamId: number) =>
  rosterRows.filter((q) => q.name === name && q.teamId === teamId).length === 1;
const dupSample = [...dupNames.values()].find(
  (list) =>
    new Set(list.map((p) => p.teamId)).size >= 2
    && list.every((p) => uniqueInTeam(p.name, p.teamId)),
);
assert.ok(
  dupSample,
  "실 로스터에서 팀이 다른 동명이인 투수(기록 보유)를 찾을 수 있어야 한다",
);
for (const dup of dupSample!) {
  const expected = normalizePitcherEra(
    eraRows.find((row) => String(row.kboId ?? row.playerId) === String(dup.kboId))?.era,
  );
  assert.equal(
    productionLookupEra(resolveRosterPlayer({ name: dup.name, teamId: dup.teamId })?.kboId),
    expected,
    `동명이인 ${dup.name}은 팀 ${dup.teamId} 정본(${dup.kboId})으로 해석돼야 한다`,
  );
}
/* ★ 2026-08-08 #1130 — 이름+팀은 **유일키가 아니다**.
 *
 * 실측: 삼성(8)에 김태훈이 둘(투수 62360 ERA 3.65 / 야수 65040). 예전 해석기는 `.find()` 로
 * 배열에서 먼저 만나는 사람을 돌려줬고, 크롤 순서가 밀리자(881명 중 684명 인덱스 변동)
 * 야수가 앞으로 오면서 선발 ERA 가 조용히 null 이 됐다. 즉 **답이 배열 순서에 달려 있었다.**
 *
 * 새 계약:
 *   (a) 이름+팀이 모호하면 해석기는 고르지 않는다 → null (fail-close)
 *   (b) 역할로 좁힐 수 있으면(후보 중 투수 기록 보유자가 1명) 선발 ERA 는 그 사람으로 확정
 *   (c) 좁혀도 복수면 "-" — 틀린 수치보다 빈 값이 낫다(유저는 틀린 걸 알아챌 수 없다)
 *
 * 표본은 전부 실 로스터에서 동적으로 고른다(특정 kboId 하드코딩 금지 — 로스터가 바뀌면 깨진다). */
const ambiguousGroups = (() => {
  const byNameTeam = new Map<string, { name: string; kboId: string; teamId: number }[]>();
  for (const p of rosterRows) {
    const key = `${p.name}::${p.teamId}`;
    const list = byNameTeam.get(key) ?? [];
    list.push(p);
    byNameTeam.set(key, list);
  }
  return [...byNameTeam.values()].filter((list) => list.length > 1);
})();
assert.ok(
  ambiguousGroups.length > 0,
  "실 로스터에 이름+팀이 겹치는 그룹이 있어야 이 계약을 검증할 수 있다",
);

for (const group of ambiguousGroups) {
  const { name, teamId } = group[0];

  // (a) 해석기는 모호하면 고르지 않는다.
  assert.equal(
    resolveRosterPlayer({ name, teamId })?.kboId ?? null,
    null,
    `${name}(팀 ${teamId})은 이름+팀으로 유일하지 않으므로 배열 순서로 찍으면 안 된다`,
  );

  // 후보는 전부 보인다(좁히기의 재료).
  const candidates = resolveRosterCandidates({ name, teamId });
  assert.equal(
    new Set(candidates.map((c) => c.kboId)).size,
    group.length,
    `${name}(팀 ${teamId}) 후보가 로스터 실제 인원과 일치해야 한다`,
  );

  const withEra = group.filter((p) => eraIds.has(String(p.kboId)));
  const era = productionResolveStarter(name, teamId).era;
  if (withEra.length === 1) {
    // (b) 투수 기록 보유자가 하나면 그 사람으로 확정된다.
    assert.equal(
      era,
      normalizePitcherEra(
        eraRows.find((row) => String(row.kboId ?? row.playerId) === String(withEra[0].kboId))?.era,
      ),
      `${name}(팀 ${teamId})은 투수 기록 보유자 ${withEra[0].kboId}로 좁혀져야 한다`,
    );
  } else {
    // (c) 좁힐 수 없으면 추측하지 않는다.
    assert.equal(
      era,
      "-",
      `${name}(팀 ${teamId})은 역할로도 좁힐 수 없으므로 추측하면 안 된다(후보 ${withEra.length}명)`,
    );
  }
}

/* ★ 실 로스터에 없는 형상은 fixture 로 직접 태운다.
 *
 * 위 루프는 **지금 로스터에 있는 모양**만 검증한다. 실측하니 (i)부분매칭이 팀 안에서 복수인
 * 케이스, (ii)exact 와 부분매칭이 같은 팀에 섞이는 케이스가 현재 0건이라, 그 두 경로를
 * 망가뜨리는 변이가 GREEN 으로 통과했다(자체 mutation X2·X3). 로스터는 매일 바뀌므로
 * "지금 없다"는 안전이 아니다 — 형상을 고정 fixture 로 만들어 계약을 못 박는다. */
{
  const FIXTURE = [
    { name: "라클란 웰스", kboId: "AQ100", teamId: 1, team: "LG", position: "투수", backNo: "1" },
    { name: "카터 웰스", kboId: "AQ101", teamId: 1, team: "LG", position: "투수", backNo: "2" },
    { name: "웰스", kboId: "AQ102", teamId: 2, team: "두산", position: "투수", backNo: "3" },
    { name: "홍길동", kboId: "AQ103", teamId: 2, team: "두산", position: "투수", backNo: "4" },
    { name: "김홍길동", kboId: "AQ104", teamId: 2, team: "두산", position: "투수", backNo: "5" },
  ] as never;

  // (i) 부분매칭이 팀 안에서 복수 — "웰스"는 LG 에서 두 명에 걸린다. 순서로 찍으면 안 된다.
  assert.equal(
    resolvePlayerIdentity({ name: "웰스", teamId: 1 }, FIXTURE)?.kboId ?? null,
    null,
    "부분매칭이 팀 안에서 복수면 해석하지 않는다(배열 순서 의존 금지)",
  );
  assert.equal(
    resolveRosterCandidates({ name: "웰스", teamId: 1 }, FIXTURE).length,
    2,
    "부분매칭 후보는 전부 노출돼야 호출자가 역할로 좁힐 수 있다",
  );

  // (ii) exact 가 있으면 부분매칭은 섞이지 않는다 — "홍길동"(exact) vs "김홍길동"(suffix).
  const mixed = resolveRosterCandidates({ name: "홍길동", teamId: 2 }, FIXTURE);
  assert.deepEqual(
    mixed.map((c) => c.kboId),
    ["AQ103"],
    "exact 가 있으면 후보는 exact 집합만 — 부분매칭이 섞이면 모호하지 않은 이름이 모호해진다",
  );
  assert.equal(
    resolvePlayerIdentity({ name: "홍길동", teamId: 2 }, FIXTURE)?.kboId,
    "AQ103",
    "exact 유일 매칭은 부분매칭 때문에 흔들리면 안 된다",
  );

  // 팀이 다르면 여전히 갈린다(과도한 fail-close 가 아님).
  assert.equal(
    resolvePlayerIdentity({ name: "웰스", teamId: 2 }, FIXTURE)?.kboId,
    "AQ102",
    "팀으로 유일해지면 정상 해석된다",
  );
}

/* ★ box ERA 는 identity 로만 채택된다 — 이름이 같다는 이유로 fail-close 를 열지 않는다.
 *
 * 삼순 지적(실증): `resolveStarterPitcher("박준영", 9, "9.99", "박준영")` 이 정체를 못 정했는데도
 * `-` 가 아니라 `9.99` 를 노출했다. 위 (a)~(c) 로 `resolvePitcherByRole` 은 `undefined` 를 냈지만,
 * 바로 다음 `boxPitcherName.trim() === name.trim()` 이름 비교 fallback 이 **다시 열어준** 것이다.
 * 한화 박준영은 둘(52731·56709)이라 그 9.99 가 누구의 기록인지 알 수 없다 — 이름은 식별자가 아니다.
 *
 * live box 는 유저에게 바로 보이는 경로라, 이 우회가 남으면 이번 fail-close 계약 전체가 무의미해진다. */
{
  // (1) 실제 복수-투수 그룹 — 역할로도 좁힐 수 없는 그룹을 실 로스터에서 고른다.
  const unresolvable = ambiguousGroups.filter(
    (group) => group.filter((p) => eraIds.has(String(p.kboId))).length > 1,
  );
  assert.ok(
    unresolvable.length > 0,
    "역할로도 좁힐 수 없는 동명이인 그룹이 있어야 이 계약을 실 데이터로 검증할 수 있다",
  );
  for (const group of unresolvable) {
    const { name, teamId } = group[0];
    assert.equal(
      productionResolveStarter(name, teamId, "9.99", name).era,
      "-",
      `${name}(팀 ${teamId})은 정체를 못 정했으므로 같은 이름의 box ERA 도 채택하면 안 된다`,
    );
  }

  // (2) 고정 fixture — 로스터에서 그 형상이 사라져도 계약은 남는다.
  const FIXTURE_ROWS: PitcherSeasonRow[] = [
    { kboId: "DUP1", playerId: "DUP1", era: "1.11" },
    { kboId: "DUP2", playerId: "DUP2", era: "2.22" },
    { kboId: "SOLO", playerId: "SOLO", era: "3.33" },
    { kboId: "HALF1", playerId: "HALF1", era: "4.44" }, // HALF2 는 기록 없음 → 역할로 갈린다
  ];
  const FIXTURE_PLAYERS = [
    { name: "동명", kboId: "DUP1", teamId: 1 },
    { name: "동명", kboId: "DUP2", teamId: 1 },
    { name: "유일", kboId: "SOLO", teamId: 1 },
    // 이름은 모호하지만 **역할로 좁혀지는** 형상(투수 기록 보유자가 하나뿐).
    // 실 데이터의 김태훈(삼성) 이 이 모양이다.
    { name: "반쪽", kboId: "HALF1", teamId: 1 },
    { name: "반쪽", kboId: "HALF2", teamId: 1 },
  ];
  const { resolveStarterPitcher: fixtureResolve } = createPitcherSeasonResolver({
    pitcherRows: FIXTURE_ROWS,
    resolveRoster: ({ name, teamId }) => {
      const hits = FIXTURE_PLAYERS.filter((p) => p.name === name && p.teamId === teamId);
      return hits.length === 1 ? { kboId: hits[0].kboId } : null;
    },
    resolveRosterCandidates: ({ name, teamId }) =>
      FIXTURE_PLAYERS.filter((p) => p.name === name && p.teamId === teamId),
    toNumericId: (kboId) => kboId,
  });

  assert.equal(
    fixtureResolve("동명", 1, "9.99", "동명").era,
    "-",
    "동명이인은 box 이름이 같아도 채택하지 않는다(이름은 식별자가 아니다)",
  );
  assert.equal(
    fixtureResolve("동명", 1).era,
    "-",
    "동명이인은 box 가 없어도 추측하지 않는다",
  );
  assert.equal(
    fixtureResolve("유일", 1, "9.99", "유일").era,
    "9.99",
    "identity 가 확정되면 box ERA 는 정상 채택된다(과도한 fail-close 아님)",
  );
  assert.equal(
    fixtureResolve("유일", 1, "9.99", "동명").era,
    "3.33",
    "다른 사람의 box ERA 는 선발을 오염시키지 못한다 — 시즌 기록으로 떨어진다",
  );
  assert.equal(
    fixtureResolve("유일", 1, "9.99", "__로스터에없음__").era,
    "3.33",
    "box 투수를 해석하지 못하면 채택하지 않는다",
  );

  /* ★ box 이름도 **선발과 같은 방식으로** 해석해야 한다.
   * "반쪽" 은 이름+팀으로는 모호하지만 역할로 HALF1 이 확정된다. box 쪽만 역할 좁히기를
   * 건너뛰면(=단순 resolveRoster) boxKboId 가 null 이 되어, identity 가 실제로 같은데도
   * live box ERA 를 버리고 시즌 기록으로 떨어진다 — 조용한 신선도 손실이다(자체 mutation X9). */
  assert.equal(
    fixtureResolve("반쪽", 1, "9.99", "반쪽").era,
    "9.99",
    "역할로 좁혀지는 이름은 box 쪽도 같은 방식으로 해석해 identity 일치를 인정해야 한다",
  );
  assert.equal(
    fixtureResolve("반쪽", 1).era,
    "4.44",
    "역할로 좁혀지면 시즌 기록도 그 사람 것으로 조회된다",
  );
}

/* ★ 순서 비의존 — 같은 로스터를 뒤집어도 답이 같아야 한다.
 * 이게 이번 사고의 본질이다. 위 (a)~(c)만 있으면 "지금 순서에서 우연히 맞는" 상태를
 * 계약으로 굳힐 수 있으므로, 순서를 실제로 뒤집어 대조한다. */
{
  const reversed = [...rosterRows].reverse();
  const sampleNames = ambiguousGroups
    .map((g) => g[0])
    .concat(dupSample!)
    .slice(0, 12);
  for (const { name, teamId } of sampleNames) {
    assert.equal(
      resolveRosterCandidates({ name, teamId }, reversed as never).length,
      resolveRosterCandidates({ name, teamId }).length,
      `${name}(팀 ${teamId}) 후보 수가 배열 순서에 따라 달라지면 안 된다`,
    );
    assert.equal(
      resolvePlayerIdentity({ name, teamId }, reversed as never)?.kboId ?? null,
      resolvePlayerIdentity({ name, teamId })?.kboId ?? null,
      `${name}(팀 ${teamId}) 해석 결과가 배열 순서에 따라 달라지면 안 된다`,
    );
  }
}

// 팀 분리가 실제로 갈라지는지 — 두 표본의 canonical ID가 서로 달라야 한다.
const dupIds = new Set(
  dupSample!.map((dup) => resolveRosterPlayer({ name: dup.name, teamId: dup.teamId })?.kboId),
);
assert.equal(
  dupIds.size,
  new Set(dupSample!.map((d) => d.teamId)).size,
  "동명이인이 팀별로 서로 다른 canonical ID로 해석돼야 한다",
);
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
// 판별자는 ERA 값이 아니라 identity(name/kboId)다. 두 투수의 ERA가 우연히 같아지는
// *정상적인 기록 갱신*에 RED가 나면 이 hotfix가 막으려던 원 사고(데이터 갱신이
// 빌드를 깨는 순환 참조)가 그대로 재발한다(삼순 3차 지적). 그래서 동률은 GREEN이고,
// 정책이 깨지면 name/kboId 차이로 RED가 되도록 아래 단정들을 deepEqual로 태운다.
assert.ok(
  prodStarterEra && prodOtherEra,
  "프로덕션 정책 검증 표본 두 투수는 시즌 기록을 보유해야 한다",
);
assert.ok(
  prodStarter.name !== prodOther.name && prodStarter.kboId !== prodOther.kboId,
  "프로덕션 정책 검증은 identity가 서로 다른 두 투수가 필요하다",
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
/* 위 §3의 문자열 검사는 "어떤 함수가 호출되는가"를 증명하지 못한다. import를 alias로
 * 받고 같은 파일에 동명의 live-only wrapper를 두면 화면 정책이 깨져도 문자열은 그대로라
 * 전체 prebuild가 GREEN이었다(삼순 3차 지적). 그래서 호출부 식별자의 *심볼*을 TS 바인더로
 * 해석해, 두 호출이 모두 프로덕션 모듈의 named import에 직접 연결돼 있는지 확인한다. */
const GAME_PAGE_PATH = "src/app/(main)/games/[gameId]/page.tsx";
const pageSource = ts.createSourceFile(
  GAME_PAGE_PATH,
  gamePage,
  ts.ScriptTarget.ESNext,
  true,
  ts.ScriptKind.TSX,
);
const pageProgram = ts.createProgram({
  rootNames: [GAME_PAGE_PATH],
  options: { noResolve: true, noLib: true, allowJs: false, jsx: ts.JsxEmit.Preserve },
  host: {
    getSourceFile: (name) => (name === GAME_PAGE_PATH ? pageSource : undefined),
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "",
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (name) => name === GAME_PAGE_PATH,
    readFile: (name) => (name === GAME_PAGE_PATH ? gamePage : undefined),
  },
});
const pageChecker = pageProgram.getTypeChecker();

/* ⚠︎ 직전 판은 파일 전체를 순회하며 *마지막* 선언 하나만 잡았다. 그래서 실제 outer 호출을
 * live-only wrapper로 갈아끼운 뒤 `if (false)` 같은 dead 블록에 동명의 direct 호출을 더하면
 * 후행 선언이 탐색 결과를 덮어써 다시 false-green이었다(삼순 4차 지적). 그래서
 * ①선언이 정확히 1개인지 ②그 유일 선언의 callee가 프로덕션 import인지 ③side별 team/box 인자가
 * 교차되지 않았는지 ④렌더 소비부가 같은 심볼을 쓰고 호출 뒤 변형이 없는지를 모두 고정한다. */
const SIDE_BINDINGS = {
  awayLineupStarter: {
    side: "away",
    liveStarterName: "liveGame?.awayStarterName",
    lineupStarterName: "d.detailLineup?.awayStarter",
    teamId: "game.awayTeamId",
    boxPitcher: "gameDetail?.boxScore?.awayPitchers?.[0]",
  },
  homeLineupStarter: {
    side: "home",
    liveStarterName: "liveGame?.homeStarterName",
    lineupStarterName: "d.detailLineup?.homeStarter",
    teamId: "game.homeTeamId",
    boxPitcher: "gameDetail?.boxScore?.homePitchers?.[0]",
  },
} as const;

function collectAll(predicate: (node: ts.Node) => boolean): ts.Node[] {
  const hits: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (predicate(node)) hits.push(node);
    ts.forEachChild(node, visit);
  };
  visit(pageSource);
  return hits;
}

/** 인자 프로퍼티 식을 공백 정규화해 원문 그대로 비교한다(매핑 교차 감지용). */
function propertyText(call: ts.CallExpression, key: string): string | null {
  const arg = call.arguments[0];
  if (!arg || !ts.isObjectLiteralExpression(arg)) return null;
  for (const prop of arg.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const name = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : null;
    if (name !== key) continue;
    return prop.initializer.getText(pageSource).replace(/\s+/g, "");
  }
  return null;
}

for (const [variableName, expected] of Object.entries(SIDE_BINDINGS)) {
  // ① 선언 유일성 — dead duplicate로 결함을 숨길 수 없게 한다.
  const declarations = collectAll(
    (node) =>
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === variableName,
  ) as ts.VariableDeclaration[];
  assert.equal(
    declarations.length,
    1,
    `\`${variableName}\` 선언은 페이지에 정확히 1개여야 한다(dead duplicate로 결함 은폐 방지)`,
  );
  const declaration = declarations[0];

  // ② 유일 선언의 callee가 프로덕션 named import인지.
  assert.ok(
    declaration.initializer
      && ts.isCallExpression(declaration.initializer)
      && ts.isIdentifier(declaration.initializer.expression),
    `\`${variableName}\`는 식별자 호출로 선언되어 있어야 한다`,
  );
  const call = declaration.initializer as ts.CallExpression;
  const calleeSymbol = pageChecker.getSymbolAtLocation(call.expression);
  const calleeDecl = calleeSymbol?.declarations?.[0];
  assert.ok(
    calleeDecl && ts.isImportSpecifier(calleeDecl),
    `\`${variableName}\`는 로컬 wrapper가 아니라 import된 함수를 직접 호출해야 한다`,
  );
  const specifier = calleeDecl as ts.ImportSpecifier;
  assert.equal(
    (specifier.propertyName ?? specifier.name).text,
    "resolveLineupStarter",
    `\`${variableName}\`는 프로덕션 \`resolveLineupStarter\`를 호출해야 한다`,
  );
  const moduleSpecifier = specifier.parent.parent.parent.moduleSpecifier;
  assert.ok(
    ts.isStringLiteral(moduleSpecifier)
      && moduleSpecifier.text === "@/lib/stats/pitcher-season",
    `\`${variableName}\`의 선발 해석기는 프로덕션 모듈에서 와야 한다`,
  );

  // ③ side/team 배선 — 원정을 홈팀 roster로 해석하면 동명이인·ERA가 오염된다.
  for (const key of ["liveStarterName", "lineupStarterName", "teamId", "boxPitcher"] as const) {
    assert.equal(
      propertyText(call, key),
      expected[key].replace(/\s+/g, ""),
      `\`${variableName}\`의 \`${key}\`는 ${expected.side} 측 입력에 결속되어야 한다`,
    );
  }

  // ④ 소비부 — blocklist가 아니라 **allowlist + fail-close**.
  //
  // 직전 판은 "알려진 나쁜 형태"(dot-property 대입, Object.assign)만 막고 나머지를 통과시켰다.
  // 그래서 `awayLineupStarter["era"] = "9.99"`(computed) 나 `{ ...awayLineupStarter, era: "9.99" }`
  // 파생 alias로 렌더 consumer를 통짜 교체해도 GREEN이었다(삼순 5차 지적).
  // 나쁜 형태를 열거하는 방식(blocklist)은 새 문법마다 새므로,
  // **허용된 소비 형태 외엔 전부 RED**로 뒤집는다(allowlist + fail-close).
  const declSymbol = pageChecker.getSymbolAtLocation(declaration.name);
  assert.ok(declSymbol, `\`${variableName}\` 선언 심볼을 해석할 수 있어야 한다`);
  const references = (collectAll(
    (node) => ts.isIdentifier(node) && node.text === variableName && node !== declaration.name,
  ) as ts.Identifier[]).filter((node) => {
    // 프로퍼티 *이름* 위치는 변수 참조가 아니다(심볼이 다름).
    const parent = node.parent;
    if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
    return true;
  });

  let starterPropUses = 0;
  let starterNameUses = 0;
  for (const reference of references) {
    assert.equal(
      pageChecker.getSymbolAtLocation(reference),
      declSymbol,
      `\`${variableName}\` 참조는 선언과 동일한 심볼이어야 한다`,
    );
    const parent = reference.parent;

    // 허용 A: `startingPitcher: <ident>` — 실제 렌더 소비 지점.
    if (
      ts.isPropertyAssignment(parent)
      && ts.isIdentifier(parent.name)
      && parent.name.text === "startingPitcher"
      && parent.initializer === reference
    ) {
      starterPropUses += 1;
      continue;
    }
    // 허용 B: `<ident>.name` 읽기 — 단, *어디서* 읽는지까지 고정한다.
    // 읽기를 무조건 허용하면 크관 `starterNames`를 상수 `"WRONG_AWAY"`로 바꿔도
    // allowlist만 만족되어 GREEN이었다(삼순 6차 지적). 허용 지점은 둘뿐이다.
    if (
      ts.isPropertyAccessExpression(parent)
      && parent.expression === reference
      && parent.name.text === "name"
      && !(ts.isBinaryExpression(parent.parent)
        && parent.parent.left === parent
        && parent.parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
        && parent.parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment)
    ) {
      const grand = parent.parent;
      // B-1: starterOnly 존재 판정 — `const awayName = awayLineupStarter.name;`
      const isExistenceProbe =
        ts.isVariableDeclaration(grand)
        && ts.isIdentifier(grand.name)
        && grand.name.text === `${expected.side}Name`
        && grand.initializer === parent;
      // B-2: 크관 `starterNames={{ away: ..., home: ... }}`
      const isKgwanStarterName =
        ts.isPropertyAssignment(grand)
        && ts.isIdentifier(grand.name)
        && grand.name.text === expected.side
        && grand.initializer === parent
        && ts.isObjectLiteralExpression(grand.parent)
        && ts.isJsxExpression(grand.parent.parent)
        && ts.isJsxAttribute(grand.parent.parent.parent)
        && ts.isIdentifier(grand.parent.parent.parent.name)
        && grand.parent.parent.parent.name.text === "starterNames";
      assert.ok(
        isExistenceProbe || isKgwanStarterName,
        `\`${variableName}.name\` 읽기는 starterOnly 존재판정 또는 크관 starterNames.${expected.side} 에서만 허용된다`
          + ` (실제: \`${grand.getText(pageSource).replace(/\s+/g, " ").slice(0, 70)}\`)`,
      );
      starterNameUses += 1;
      continue;
    }
    // 그 외 전부 fail-close — computed 접근, spread, 재할당, Object.assign/Reflect.set,
    // 타입 단언, 임의 함수 인자 전달 등이 여기로 떨어진다.
    assert.fail(
      `\`${variableName}\`의 허용되지 않은 소비 형태: `
        + `\`${reference.parent.getText(pageSource).replace(/\s+/g, " ").slice(0, 90)}\` `
        + `(startingPitcher 직접 전달 또는 .name 읽기만 허용)`,
    );
  }
  assert.equal(
    starterPropUses,
    2,
    `\`${variableName}\`는 starterOnly/LineupTab 두 곳의 \`startingPitcher\`로 직접 전달되어야 한다`,
  );
  assert.equal(
    starterNameUses,
    2,
    `\`${variableName}.name\`은 starterOnly 존재판정 1회 + 크관 starterNames 1회, 총 2회 읽혀야 한다`,
  );
}

// 역방향 — 크관 `starterNames`의 away/home이 *상수나 다른 식*으로 대체되지 않았는지.
// 위 순회는 "선언 참조가 어디에 쓰이나"를 보므로, 참조 자체를 지우면 개수로만 잡힌다.
// 여기서는 소비 지점 쪽에서 역으로 "무엇이 들어있나"를 확인한다.
const starterNamesAttrs = collectAll(
  (node) =>
    ts.isJsxAttribute(node)
    && ts.isIdentifier(node.name)
    && node.name.text === "starterNames",
) as ts.JsxAttribute[];
assert.equal(starterNamesAttrs.length, 1, "크관 `starterNames` 소비 지점은 1개여야 한다");
const starterNamesInit = starterNamesAttrs[0].initializer;
assert.ok(
  starterNamesInit
    && ts.isJsxExpression(starterNamesInit)
    && starterNamesInit.expression
    && ts.isObjectLiteralExpression(starterNamesInit.expression),
  "`starterNames`는 객체 리터럴이어야 한다",
);
const starterNamesObject = (starterNamesInit as ts.JsxExpression)
  .expression as ts.ObjectLiteralExpression;
for (const [variableName, expected] of Object.entries(SIDE_BINDINGS)) {
  const prop = starterNamesObject.properties.find(
    (p): p is ts.PropertyAssignment =>
      ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === expected.side,
  );
  assert.ok(prop, `크관 \`starterNames\`에 \`${expected.side}\` 프로퍼티가 있어야 한다`);
  const init = prop!.initializer;
  assert.ok(
    ts.isPropertyAccessExpression(init)
      && init.name.text === "name"
      && ts.isIdentifier(init.expression)
      && init.expression.text === variableName,
    `크관 \`starterNames.${expected.side}\`는 \`${variableName}.name\`이어야 한다`
      + `(실제: \`${init.getText(pageSource).replace(/\s+/g, " ").slice(0, 60)}\`)`,
  );
}

// 역방향 — 페이지의 *모든* `startingPitcher` 소비 지점이 위 두 선언 심볼만 쓰는지.
// 이게 없으면 변조된 파생값을 새 이름으로 만들어 렌더에만 꽂는 경로가 열려 있다.
const starterDeclSymbols = new Set(
  Object.keys(SIDE_BINDINGS).map((variableName) => {
    const decl = (collectAll(
      (node) =>
        ts.isVariableDeclaration(node)
        && ts.isIdentifier(node.name)
        && node.name.text === variableName,
    ) as ts.VariableDeclaration[])[0];
    return pageChecker.getSymbolAtLocation(decl.name);
  }),
);
const starterPropAssignments = collectAll(
  (node) =>
    ts.isPropertyAssignment(node)
    && ts.isIdentifier(node.name)
    && node.name.text === "startingPitcher",
) as ts.PropertyAssignment[];
assert.equal(
  starterPropAssignments.length,
  4,
  "페이지의 `startingPitcher` 소비 지점은 away/home × starterOnly/LineupTab = 4개여야 한다",
);
for (const assignment of starterPropAssignments) {
  assert.ok(
    ts.isIdentifier(assignment.initializer),
    "`startingPitcher`에는 파생식이 아닌 선발 변수를 그대로 전달해야 한다",
  );
  assert.ok(
    starterDeclSymbols.has(pageChecker.getSymbolAtLocation(assignment.initializer)),
    "`startingPitcher`는 resolveLineupStarter 선언 심볼을 직접 참조해야 한다(변조 alias 불가)",
  );
}

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
// (initializer 검사는 아래 AST 구간으로 이관했다. 정규식은 주석의 dead text를 읽어
// 실제 선언에서 `++`를 빼도 GREEN이었다 — 삼순 6차 지적.)

/* 캡처 위치도 계약이다. 캡처를 첫 `await` 뒤로만 옮겨도 guard→commit 순서는 그대로라
 * 전체 prebuild가 GREEN이었다(삼순 3차). 그러면 A→B 요청에서 B가 먼저 완료할 때
 * B가 gen1, 늦게 끝난 A가 gen2를 받아 **stale A가 최종 커밋**된다.
 *
 * ⚠︎ 그런데 직전 판은 이걸 `indexOf` 문자열 위치로만 봤다. 그래서 첫 await 앞 unreachable
 * 블록에 똑같은 문장을 dead로 깔아두고, 실제 캡처는 `let`으로 await 뒤에 두면
 * 게이트가 dead 문자열의 index를 읽어 GREEN이었다(삼순 5차 지적).
 * 그래서 AST로 바꿔 ①fetchDetail 안 선언이 정확히 1개 ②그 선언이 함수 본문의 직접 statement
 * ③첫 실제 AwaitExpression보다 앞 ④guard들이 그 선언 심볼을 참조 — 네 개를 함께 고정한다. */
const HOOK_PATH = "src/lib/hooks/useGameDetail.ts";
const hookSource = ts.createSourceFile(
  HOOK_PATH,
  detailHook,
  ts.ScriptTarget.ESNext,
  true,
  ts.ScriptKind.TS,
);
const hookProgram = ts.createProgram({
  rootNames: [HOOK_PATH],
  options: { noResolve: true, noLib: true, allowJs: false },
  host: {
    getSourceFile: (name) => (name === HOOK_PATH ? hookSource : undefined),
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "",
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (name) => name === HOOK_PATH,
    readFile: (name) => (name === HOOK_PATH ? detailHook : undefined),
  },
});
const hookChecker = hookProgram.getTypeChecker();

function collectIn(root: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node[] {
  const hits: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (predicate(node)) hits.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return hits;
}

const fetchDetailDecls = collectIn(
  hookSource,
  (node) =>
    ts.isVariableDeclaration(node)
    && ts.isIdentifier(node.name)
    && node.name.text === "fetchDetail",
) as ts.VariableDeclaration[];
assert.equal(fetchDetailDecls.length, 1, "`fetchDetail` 선언은 정확히 1개여야 한다");
const fetchDetailFn = collectIn(
  fetchDetailDecls[0],
  (node) => ts.isArrowFunction(node) || ts.isFunctionExpression(node),
)[0] as ts.ArrowFunction | ts.FunctionExpression | undefined;
assert.ok(fetchDetailFn?.body, "`fetchDetail`의 async 본문을 찾을 수 있어야 한다");
const fetchBody = fetchDetailFn!.body as ts.Block;
assert.ok(ts.isBlock(fetchBody), "`fetchDetail` 본문은 블록이어야 한다");

// ① 선언 유일성 — dead capture를 하나 더 숨어두면 2개가 돼 RED.
const generationDecls = collectIn(
  fetchBody,
  (node) =>
    ts.isVariableDeclaration(node)
    && ts.isIdentifier(node.name)
    && node.name.text === "responseGeneration",
) as ts.VariableDeclaration[];
assert.equal(
  generationDecls.length,
  1,
  "`fetchDetail` 안 `responseGeneration` 선언은 정확히 1개여야 한다(dead capture 은폐 방지)",
);
const generationDecl = generationDecls[0];
const generationStatement = generationDecl.parent.parent as ts.Statement;

// ② 함수 본문의 *직접* statement — 조건문·루프 안으로 숨기면 매 호출 실행이 보장되지 않는다.
assert.ok(
  ts.isVariableStatement(generationStatement)
    && fetchBody.statements.includes(generationStatement),
  "`responseGeneration` 선언은 fetchDetail 본문의 직접 statement여야 한다(조건부 블록 불가)",
);
assert.ok(
  (generationDecl.parent as ts.VariableDeclarationList).flags & ts.NodeFlags.Const,
  "`responseGeneration`은 재할당 불가한 const여야 한다",
);

// initializer 의미도 AST로 결속한다. 위치·유일성만 보면 `= responseGenerationRef.current`로
// **증가를 빼도** GREEN이다(모든 poll이 같은 generation을 공유 → stale 커밋).
// 구 정규식은 주석에 같은 문장을 넣으면 그걸 읽어 통과시켰다(삼순 6차 지적).
const generationInit = generationDecl.initializer;
assert.ok(
  generationInit
    && ts.isPrefixUnaryExpression(generationInit)
    && generationInit.operator === ts.SyntaxKind.PlusPlusToken,
  "`responseGeneration`은 전위 증가(`++`)로 캐프처되어야 한다"
    + "(증가가 없으면 모든 poll이 같은 generation을 공유해 stale 응답이 커밋된다)",
);
const generationOperand = (generationInit as ts.PrefixUnaryExpression).operand;
assert.ok(
  ts.isPropertyAccessExpression(generationOperand)
    && generationOperand.name.text === "current"
    && ts.isIdentifier(generationOperand.expression)
    && generationOperand.expression.text === "responseGenerationRef",
  "`responseGeneration`은 `++responseGenerationRef.current` 여야 한다",
);
// ref 심볼까지 동일성 확인 — 동명의 로컬 ref를 따로 만들어 가리면 무의미해진다.
const refDecls = collectIn(
  hookSource,
  (node) =>
    ts.isVariableDeclaration(node)
    && ts.isIdentifier(node.name)
    && node.name.text === "responseGenerationRef",
) as ts.VariableDeclaration[];
assert.equal(refDecls.length, 1, "`responseGenerationRef` 선언은 정확히 1개여야 한다");
assert.equal(
  hookChecker.getSymbolAtLocation((generationOperand as ts.PropertyAccessExpression).expression),
  hookChecker.getSymbolAtLocation(refDecls[0].name),
  "generation 캐프처는 훅의 유일한 `responseGenerationRef`를 증가시켜야 한다",
);

// ③ 첫 실제 await보다 앞인가.
const awaits = collectIn(fetchBody, ts.isAwaitExpression);
assert.ok(awaits.length > 0, "fetchDetail 본문에 await가 있어야 한다");
const firstAwaitPos = Math.min(...awaits.map((node) => node.pos));
assert.ok(
  generationStatement.end <= firstAwaitPos,
  "generation 캡처는 첫 async boundary(await)보다 앞이어야 한다"
    + "(뒤로 올리면 먼저 완료한 최신 응답이 더 낮은 generation을 받아 stale 응답이 최종 커밋된다)",
);

// ④ guard들이 바로 그 선언 심볼을 쓰는가 — 동명의 다른 변수를 읽고 있으면 무의미하다.
const generationSymbol = hookChecker.getSymbolAtLocation(generationDecl.name);
assert.ok(generationSymbol, "`responseGeneration` 선언 심볼을 해석할 수 있어야 한다");
const guardCalls = collectIn(
  fetchBody,
  (node) =>
    ts.isCallExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === "shouldCommitResponse",
) as ts.CallExpression[];
assert.equal(
  guardCalls.length,
  2,
  "예외·finally 두 커밋 지점은 fetchDetail 안에서 generation 펜스를 직접 통과해야 한다"
    + "(성공 경로 커밋은 공용 커밋 함수(commitPayloadRef.current)의 선두 펜스가 담당 — 아래에서 AST로 별도 결속)",
);
for (const guard of guardCalls) {
  const secondArg = guard.arguments[1];
  assert.ok(
    secondArg && ts.isIdentifier(secondArg),
    "`shouldCommitResponse` 두 번째 인자는 캡처한 generation 변수여야 한다",
  );
  assert.equal(
    hookChecker.getSymbolAtLocation(secondArg as ts.Identifier),
    generationSymbol,
    "모든 generation 펌스는 첫 await 앞에서 캡처한 바로 그 선언을 참조해야 한다",
  );
}

// ⑤ 성공 경로 이관 결속(멀티플렉스 리팩터) — fetchDetail은 파싱 결과를 공용 커밋 함수
// commitPayloadRef.current에 캡처한 바로 그 generation과 함께 넘겨야 한다.
// (ingestExternal(멀티플렉스 frame)과 fetch가 같은 커밋 함수를 공유하는 구조)
const commitCalls = collectIn(
  fetchBody,
  (node) =>
    ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && node.expression.name.text === "current"
    && ts.isIdentifier(node.expression.expression)
    && node.expression.expression.text === "commitPayloadRef",
) as ts.CallExpression[];
assert.equal(
  commitCalls.length,
  1,
  "fetchDetail 성공 경로의 commitPayloadRef.current 호출은 정확히 1개여야 한다",
);
const commitCallGenArg = commitCalls[0].arguments[1];
assert.ok(
  commitCallGenArg && ts.isIdentifier(commitCallGenArg),
  "커밋 호출 두 번째 인자는 캡처한 generation 변수여야 한다",
);
assert.equal(
  hookChecker.getSymbolAtLocation(commitCallGenArg as ts.Identifier),
  generationSymbol,
  "커밋 호출은 첫 await 앞에서 캡처한 바로 그 generation을 넘겨야 한다",
);
// 런타임 순서: 응답 파싱(await res.json()) 뒤에 커밋 호출 — 펜스가 파싱 뒤에 실행되는
// 기존 계약의 이관형(커밋 함수가 텍스트상 앞에 있어도 실행은 파싱 뒤다).
const jsonAwaits = collectIn(
  fetchBody,
  (node) =>
    ts.isAwaitExpression(node)
    && ts.isCallExpression(node.expression)
    && ts.isPropertyAccessExpression(node.expression.expression)
    && node.expression.expression.name.text === "json",
) as ts.AwaitExpression[];
assert.ok(jsonAwaits.length > 0, "res.json() await를 찾을 수 있어야 한다");
assert.ok(
  jsonAwaits[0].end <= commitCalls[0].pos,
  "커밋 호출은 응답 파싱(await res.json()) 뒤여야 한다(파싱 전 커밋이면 경쟁 창을 닫지 못함)",
);
// 공용 커밋 함수의 선두 펜스 — 성공·오류 커밋 지점이 전부 이 함수 안이므로,
// 펜스가 첫 statement면 모든 커밋이 구조적으로 펜스 뒤가 된다(조건·순서 우회 불가).
const commitAssigns = collectIn(
  hookSource,
  (node) =>
    ts.isBinaryExpression(node)
    && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && ts.isPropertyAccessExpression(node.left)
    && node.left.name.text === "current"
    && ts.isIdentifier(node.left.expression)
    && node.left.expression.text === "commitPayloadRef"
    && (ts.isArrowFunction(node.right) || ts.isFunctionExpression(node.right)),
) as ts.BinaryExpression[];
assert.equal(commitAssigns.length, 1, "commitPayloadRef.current 함수 할당은 정확히 1개여야 한다");
const commitFnNode = commitAssigns[0].right as ts.ArrowFunction;
const commitBody = commitFnNode.body;
assert.ok(ts.isBlock(commitBody), "커밋 함수 본문은 블록이어야 한다");
const commitFirstStmt = (commitBody as ts.Block).statements[0];
assert.ok(
  commitFirstStmt
    && ts.isIfStatement(commitFirstStmt)
    && ts.isPrefixUnaryExpression(commitFirstStmt.expression)
    && commitFirstStmt.expression.operator === ts.SyntaxKind.ExclamationToken
    && ts.isCallExpression(commitFirstStmt.expression.operand)
    && ts.isIdentifier(commitFirstStmt.expression.operand.expression)
    && commitFirstStmt.expression.operand.expression.text === "shouldCommitResponse"
    && (ts.isReturnStatement(commitFirstStmt.thenStatement)
      || (ts.isBlock(commitFirstStmt.thenStatement)
        && commitFirstStmt.thenStatement.statements.length === 1
        && ts.isReturnStatement(commitFirstStmt.thenStatement.statements[0]))),
  "커밋 함수 첫 statement는 generation 펜스 조기 반환이어야 한다(모든 커밋 지점의 구조적 펜스)",
);
assert.equal(
  (detailHook.match(
    /shouldCommitResponse\(responseGenerationRef\.current, responseGeneration\)/g,
  ) ?? []).length,
  4,
  "커밋 함수 선두 펜스 + 예외·finally + ingestExternal loading 커밋 — 네 지점 전부 generation 펜스를 통과해야 한다",
);

const guardIdx = detailHook.indexOf(
  "if (!shouldCommitResponse(responseGenerationRef.current, responseGeneration)) return;",
);
assert.ok(guardIdx >= 0, "fetch 직후 구세대 응답은 조기 반환되어야 한다");

// (구) parseIdx < guardIdx 텍스트 순서 검사는 커밋 함수 추출로 실행 순서와 역전됨.
// 파싱→커밋 순서는 위 ⑤의 AST 결속(jsonAwaits[0].end <= commitCalls[0].pos)이 담당한다.

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
