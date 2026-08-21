/**
 * 동명이인 사진/식별 게이트 (2026-08-20 CS 제보 — 삼성 김태훈 투수 자리에 NC 김태훈 사진).
 *
 * 계약:
 *  1) getPlayerPhotoUrl 의 name-only 사진맵 fallback 은 로스터 동명이인(2+)이면 fail-close.
 *     (resolver 가 fail-close 해도 이름 키 사진맵이 우회로가 돼 다른 사람 사진이 붙던 결함)
 *  2) positionHint("투수"|"야수")로 같은 팀 동명이인을 역할로 좁힌다. 힌트로도 유일하지
 *     않으면 여전히 null — 배열 순서로 찍는 경로는 만들지 않는다.
 *  3) 본인으로 resolve 됐는데 사진 파일이 없으면 다른 동명이인 사진으로 대체하지 않는다.
 *
 * 실측 픽스처: 실제 로스터의 김태훈 3명(삼성 투수 62360 · 삼성 야수 65040 · NC 투수 55995),
 * 이정범(KT 67807, SSG→KT 이적). 주입 픽스처: 같은 팀 동일 포지션 동명이인(힌트 무력) 등.
 *
 * 검증력(RED 증명): 계약 1·2 는 수정 전 main 코드에서 실제로 FAIL 한다
 * (main: getPlayerPhotoUrl("김태훈", null, 8) === "/players/55995.jpg" — 이 스모크의 기대값은 null).
 */
import {
  resolvePlayer,
  rosterNameMatchCount,
  type PlayerQuery,
} from "@/lib/utils/resolve-player";
import { getPlayerPhotoUrl } from "@/lib/constants/player-photos";
import playersRoster from "@/lib/constants/players-roster.json";
import type { RosterPlayer } from "@/types/api";

const roster = playersRoster as RosterPlayer[];

let pass = 0;
let fail = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = actual === expected;
  if (ok) {
    pass++;
    console.log(`✓ ${label}`);
  } else {
    fail++;
    console.error(`✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
  }
}

// ── 전제 픽스처 실측 (로스터가 바뀌면 스모크가 전제부터 알려준다) ──
const kimTaehuns = roster.filter((p) => p.name === "김태훈");
check("전제: 로스터 김태훈 3명", kimTaehuns.length, 3);
check(
  "전제: 삼성(teamId 8)에 투수·야수 김태훈 공존",
  kimTaehuns.filter((p) => Number(p.teamId) === 8).length,
  2,
);
const leeJungbeom = roster.find((p) => p.name === "이정범");
check("전제: 이정범은 KT(67807) 단일", leeJungbeom?.kboId, "67807");

// ── 계약 2: positionHint 로 같은 팀 동명이인 분리 ──
check(
  "삼성 김태훈 + hint 투수 → 62360",
  resolvePlayer({ name: "김태훈", teamId: 8, positionHint: "투수" })?.kboId,
  "62360",
);
check(
  "삼성 김태훈 + hint 야수 → 65040",
  resolvePlayer({ name: "김태훈", teamId: 8, positionHint: "야수" })?.kboId,
  "65040",
);
check(
  "NC 김태훈 + hint 투수 → 55995",
  resolvePlayer({ name: "김태훈", teamId: 5, positionHint: "투수" })?.kboId,
  "55995",
);
check(
  "삼성 김태훈 hint 없음 → null (기존 fail-close 유지)",
  resolvePlayer({ name: "김태훈", teamId: 8 }),
  null,
);

// 주입 픽스처: 같은 팀 + 같은 포지션 동명이인 — 힌트로도 특정 불가 → null
const injectedRoster: RosterPlayer[] = [
  { name: "김테스트", kboId: "10001", teamId: 8, position: "투수", backNo: "1", team: "삼성" },
  { name: "김테스트", kboId: "10002", teamId: 8, position: "투수", backNo: "2", team: "삼성" },
] as RosterPlayer[];
check(
  "주입: 같은 팀 투수 2명 + hint 투수 → null (배열 순서로 찍지 않음)",
  resolvePlayer({ name: "김테스트", teamId: 8, positionHint: "투수" } as PlayerQuery, injectedRoster),
  null,
);

// ── 계약 1: name-only 사진 fallback 의 동명이인 fail-close ──
check(
  "getPlayerPhotoUrl(김태훈, no-id, 삼성) → null (main 에선 55995.jpg 오사진 — RED 증명 축)",
  getPlayerPhotoUrl("김태훈", null, 8),
  null,
);
check(
  "getPlayerPhotoUrl(김태훈, no-id, no-team) → null (동명이인 name-only 금지)",
  getPlayerPhotoUrl("김태훈"),
  null,
);
check(
  "getPlayerPhotoUrl(김태훈, no-id, 삼성, hint 투수) → 62360.jpg",
  getPlayerPhotoUrl("김태훈", null, 8, "투수"),
  "/players/62360.jpg",
);
check(
  "getPlayerPhotoUrl(김태훈, no-id, 삼성, hint 야수) → 65040.jpg",
  getPlayerPhotoUrl("김태훈", null, 8, "야수"),
  "/players/65040.jpg",
);
check(
  "getPlayerPhotoUrl(김태훈, no-id, NC, hint 투수) → 55995.jpg",
  getPlayerPhotoUrl("김태훈", null, 5, "투수"),
  "/players/55995.jpg",
);

// ── 회귀: 유일 이름·kboId 직접·이적 선수 ──
check(
  "이정범(KT) → 67807.jpg (이적 반영 로스터 기준 단일 매칭)",
  getPlayerPhotoUrl("이정범", null, 3),
  "/players/67807.jpg",
);
const guJawook = roster.find((p) => p.name === "구자욱");
check(
  "유일 이름 name-only → 사진 유지 (구자욱, 로스터 kboId 기준)",
  getPlayerPhotoUrl("구자욱"),
  guJawook ? `/players/${guJawook.kboId}.jpg` : "(로스터에 없음)",
);
check(
  "kboId 직접 지정 → 그대로 (62360)",
  getPlayerPhotoUrl("김태훈", "62360", 8),
  "/players/62360.jpg",
);
check(
  "kboId 명시 + 로스터 불일치 → null 유지 (엉뚱한 동명이인 부착 금지)",
  getPlayerPhotoUrl("김태훈", "00000", 8),
  null,
);
// 외국인 짧은 표기 회귀 (suffix 매칭 경로)
const wells = roster.find((p) => p.name.endsWith("웰스"));
if (wells) {
  check(
    `외국인 suffix 회귀: 웰스(${wells.team}) resolve 유지`,
    resolvePlayer({ name: "웰스", teamId: wells.teamId })?.kboId,
    wells.kboId,
  );
}

// rosterNameMatchCount 술어 자체 검증
check("rosterNameMatchCount(김태훈) = 3", rosterNameMatchCount("김태훈"), 3);
check("rosterNameMatchCount(구자욱) = 1", rosterNameMatchCount("구자욱"), 1);
check("rosterNameMatchCount(존재안함XYZ) = 0", rosterNameMatchCount("존재안함XYZ"), 0);

console.log(`\n${pass} PASS / ${fail} FAIL`);
if (fail > 0) process.exit(1);
