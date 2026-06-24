import type { GameEvent } from "@/types/game-events";

// 홈런 득점(예: 솔로 홈런 1점)은 at_bat_homerun 푸시가 이미 커버한다. 그런데 그 득점이
// 라이브 스코어에 *뒤늦게* 반영되면(홈런은 BoxScore에서 먼저 감지, 점수는 다음 폴링에서
// 갱신) generator가 같은 사이클이 아니라 run_scored를 따로 emit → 같은 1점에 "홈런!"+"득점!"
// 2푸시가 나간다(고객 제보 2026-06-24 #SSLG, 오스틴 솔로 홈런). generator의 같은-사이클
// suppression(event-generator #213-①)이 폴링 시차로 놓치는 이 케이스를, 알림 레이어가
// 전체(누적) 이벤트 기준으로 막는다. 큰 이닝의 후속 안타 득점까지 삼키지 않도록 같은 half
// (inning+isTop) + 짧은 시간창 안의 홈런만 매칭한다(시차는 보통 1폴링 ≈ 60s 이내).
//
// 순수 함수(DB·FCM 의존 없음) — game-score.ts에서 사용하고 smoke 테스트가 직접 검증한다.
export const HR_RUN_DEDUPE_WINDOW_MS = 180_000;

export function isHomerunCoveredRun(ev: GameEvent, allEvents: GameEvent[]): boolean {
  if (ev.type !== "run_scored") return false;
  const t = Date.parse(ev.timestamp);
  if (!Number.isFinite(t)) return false; // 타임스탬프 불량 → 억제하지 않음(중복 < 미발송)
  return allEvents.some((e) => {
    if (e.type !== "at_bat_homerun") return false;
    if (e.isTop !== ev.isTop || e.inning !== ev.inning) return false;
    const ht = Date.parse(e.timestamp);
    // 단방향: 홈런(ht) ≤ run_scored(t) 순서만 suppress — 미래 홈런이 이전 run을 억제하지 않도록.
    return Number.isFinite(ht) && ht <= t && t - ht <= HR_RUN_DEDUPE_WINDOW_MS;
  });
}

// 홈런 알림(at_bat_homerun)의 표시 점수가 0:0으로 잘못 나가는 사고(고객 #SSLG 2026-06-24)
// 보강. 홈런은 BoxScore에서 라이브 스코어보다 먼저 잡혀, 그 득점이 점수에 반영되기 *전*에
// 이벤트가 만들어지면 ev.snapshot이 득점 전(0:0)이다. isHomerunCoveredRun이 중복 득점 푸시는
// 막지만 생존하는 홈런 알림이 stale 점수를 그대로 보여주는 문제가 남는다.
//
// 판정 = "이 홈런의 득점이 점수에 반영됐는가". 신호 두 가지(OR):
//  (a) 라이브 게임 현재 점수(g.T_SCORE_CN/B_SCORE_CN)의 *공격팀* 점수가 홈런 snapshot보다 높다
//      → 홈런 이후 점수가 올랐다 = 반영됨.
//  (b) 같은 half·시간창 안에 매칭 run_scored가 있다(점수가 라이브에 반영돼 generator가 emit).
// 반영됐으면 가장 최신(현재 g 점수와 매칭 run snapshot 중 큰 쪽)으로 발송.
// 아직이면(교차폴링 poll N) defer=true로 이번 사이클 발송 보류(claim 안 함) → 다음 폴링 재시도.
// 단 무한 보류 방지로 waitMs 경과 시 현재 점수로 발송(같은-폴링: 점수가 이미 반영돼 정확,
// 또는 드물게 득점 보정으로 run이 영영 안 와도 현행 동작으로 degrade).
export const HR_SCORE_WAIT_MS = 75_000; // ≈1 폴링(매분) — 교차폴링 득점 반영 대기

export interface HomerunScore {
  defer: boolean;
  awayScore: number;
  homeScore: number;
}

export function resolveHomerunScore(
  hr: GameEvent,
  allEvents: GameEvent[],
  currentAwayScore: number,
  currentHomeScore: number,
  nowMs: number,
  waitMs: number = HR_SCORE_WAIT_MS,
): HomerunScore {
  const snapAway = hr.snapshot?.awayScore ?? 0;
  const snapHome = hr.snapshot?.homeScore ?? 0;
  // 공격팀(홈런 친 팀): isTop=초=원정(away), 말=홈(home). 홈런 이벤트엔 detail.scoringSide가
  // 없으므로 isTop으로 공격팀 side를 직접 계산해 run_scored와 비교한다.
  const hrSide: "away" | "home" = hr.isTop ? "away" : "home";
  const battingSnap = hr.isTop ? snapAway : snapHome;
  const battingCur = hr.isTop ? currentAwayScore : currentHomeScore;

  const ht = Date.parse(hr.timestamp);
  const matchRun = allEvents.find((e) => {
    if (e.type !== "run_scored") return false;
    if (e.isTop !== hr.isTop || e.inning !== hr.inning) return false;
    const rt = Date.parse(e.timestamp);
    // 단방향: run_scored(rt)는 홈런(ht) 이후여야 매칭 — 이전 run을 "반영됨"으로 오판 방지.
    // scoringSide(detail에 위치)가 홈런 공격팀과 일치하는 득점만 매칭.
    return (
      Number.isFinite(rt) &&
      Number.isFinite(ht) &&
      rt >= ht &&
      rt - ht <= HR_RUN_DEDUPE_WINDOW_MS &&
      e.detail?.scoringSide === hrSide
    );
  });

  // 가장 신선한 점수 = 현재 g 점수와 매칭 run snapshot 중 큰 쪽(반영이 더 된 쪽).
  let outAway = currentAwayScore;
  let outHome = currentHomeScore;
  if (matchRun) {
    outAway = Math.max(outAway, matchRun.snapshot?.awayScore ?? outAway);
    outHome = Math.max(outHome, matchRun.snapshot?.homeScore ?? outHome);
  }

  const reflected = battingCur > battingSnap || matchRun !== undefined;
  if (reflected) return { defer: false, awayScore: outAway, homeScore: outHome };

  // 아직 반영 안 됨 — 신선하면 다음 폴링 대기, 오래됐으면 현재 점수로 발송.
  if (Number.isFinite(ht) && nowMs - ht < waitMs) return { defer: true, awayScore: outAway, homeScore: outHome };
  return { defer: false, awayScore: outAway, homeScore: outHome };
}
