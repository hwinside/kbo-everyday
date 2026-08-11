// Naver STARTED 조기 오표기 가드 smoke — 2026-08-11 18:24 실측 사고 회귀 게이트.
// 실측 원본: Naver schedule/games 가 20260811LGWO02026 을 예정시각(19:00) 35분 전에
// STARTED "1회초"(0:0) 로 내려줌. KBO 공식 GetKboGameList 는 동시각 5경기 전부 경기전(state=1),
// Naver 상세 record 도 전부 0. → 예정시각 전 + 0:0 STARTED 는 scheduled 로 강등해야 한다.
import { isPrematureStarted, mapNaverGameToKbo } from "../../src/lib/crawler/naver-games";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL ${name}`);
  }
}

// 2026-08-11 18:24 실측 페이로드(필드 축약 없이 판정 관련 필드 그대로).
const lgwoPremature = {
  gameId: "20260811LGWO02026",
  gameDateTime: "2026-08-11T19:00:00",
  stadium: "고척",
  homeTeamCode: "WO",
  awayTeamCode: "LG",
  homeTeamName: "키움",
  awayTeamName: "LG",
  homeTeamScore: 0,
  awayTeamScore: 0,
  statusCode: "STARTED",
  statusInfo: "1회초",
  cancel: false,
  suspended: false,
};

// now 는 KST 18:24 = UTC 09:24 (사고 시각 그대로).
const at1824 = new Date("2026-08-11T09:24:00Z");
// 예정시각 도달(KST 19:00 = UTC 10:00).
const at1900 = new Date("2026-08-11T10:00:00Z");

// ── 1) 판정 함수 단위 ─────────────────────────────────────────────
check("예정시각 전 + 0:0 STARTED → premature", isPrematureStarted(lgwoPremature, at1824) === true);
check("예정시각 도달 후 STARTED → premature 아님", isPrematureStarted(lgwoPremature, at1900) === false);
check(
  "예정시각 전이라도 득점 있으면 premature 아님(진행 증거 우선)",
  isPrematureStarted({ ...lgwoPremature, awayTeamScore: 1 }, at1824) === false,
);
check("READY 는 premature 판정 대상 아님", isPrematureStarted({ ...lgwoPremature, statusCode: "READY" }, at1824) === false);
check(
  "gameDateTime 결측 시 가드 off(기존 동작 유지, fail-open)",
  isPrematureStarted({ ...lgwoPremature, gameDateTime: undefined }, at1824) === false,
);
check(
  "gameDateTime 파싱 불가(형식 변화) 시 가드 off",
  isPrematureStarted({ ...lgwoPremature, gameDateTime: "2026-08-11T19:00:00+09:00" }, at1824) === false,
);

// ── 2) 매퍼 종단(홈/상세가 소비하는 KboGame 형태) ──────────────────
const mappedPremature = mapNaverGameToKbo(lgwoPremature, "20260811", at1824);
check("매퍼: 사고 시각엔 scheduled", mappedPremature.status === "scheduled");
check("매퍼: scheduled 는 스코어 null(가짜 0:0 미노출)", mappedPremature.awayScore === null && mappedPremature.homeScore === null);
check("매퍼: scheduled 는 이닝 0(1회초 셀 활성화 방지)", mappedPremature.inning === 0);

const mappedLive = mapNaverGameToKbo(lgwoPremature, "20260811", at1900);
check("매퍼: 예정시각 도달 후엔 live 유지", mappedLive.status === "live");
check("매퍼: live 이닝 파싱 유지(1회초)", mappedLive.inning === 1 && mappedLive.isTop === true);

const mappedScoredEarly = mapNaverGameToKbo({ ...lgwoPremature, awayTeamScore: 2 }, "20260811", at1824);
check("매퍼: 예정 전이라도 득점 있으면 live 유지", mappedScoredEarly.status === "live");

// 기존 정상 경로 무회귀: READY / RESULT.
check(
  "매퍼: READY → scheduled 무회귀",
  mapNaverGameToKbo({ ...lgwoPremature, statusCode: "READY", statusInfo: "경기전" }, "20260811", at1824).status === "scheduled",
);
check(
  "매퍼: RESULT → final 무회귀",
  mapNaverGameToKbo({ ...lgwoPremature, statusCode: "RESULT", statusInfo: "9회말", homeTeamScore: 3 }, "20260811", at1900).status ===
    "final",
);

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall checks passed");
