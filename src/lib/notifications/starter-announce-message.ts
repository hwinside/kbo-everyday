/**
 * 예고선발 공개 알림 — 순수 전이 판정 + 문구 포맷터 (유저 제안 #cs 1785380092.155589, 삼순 조건부 GO 계약).
 *
 * 계약
 * - 트리거는 "양팀 선발이 모두 빈값→공식값으로 채워진 시점"이다. '연전 첫날' 하드코딩 없음 — KBO가
 *   언제 공시하든 전이 자체가 트리거(수집 cron 이 자연 감지).
 * - 한쪽만 공개면 발송하지 않는다(양팀 확정 대기).
 * - 실제 단일 전이 보장(재수집/cron 중복 실행 중복 0)은 DB 원장(game_starter_notify_state)이 담당하고,
 *   이 모듈은 그 앞단의 순수 게이트다. 선발 '변경'(공식값→다른 공식값)은 원장상 이미 발송이라 재발송 없음.
 */
import { TEAMS } from "@/lib/constants/teams";

/** 팀 shortName(예: "LG", "한화"). 미상 팀은 방어적 폴백. */
function teamShortName(teamId: number): string {
  return TEAMS.find((t) => t.id === teamId)?.shortName ?? `${teamId}팀`;
}

/** 양팀 선발이 모두 공식값(비어있지 않은 이름)인가 — 한쪽만 공개면 false(양팀 확정 대기). */
export function bothStartersOfficial(awayStarterName: string, homeStarterName: string): boolean {
  return awayStarterName.trim().length > 0 && homeStarterName.trim().length > 0;
}

/**
 * 빈값→공식값 최초 전이 판정(순수 계약 부분) — watchdog Phase A 가 실제로 호출하는 발송 게이트.
 * - 전이는 실제 빈값 관측 이력(sawUnannouncedBefore)이 있어야 성립한다. 배포/rollout 첫 tick 에
 *   이미 공식값인 경기는 baseline(발송 금지) — 기공개분 stale burst 차단.
 * - 취소 경기 fail-safe: 발송하지 않는다(호출부가 status='scheduled' 필터로 보장, 이중 게이트).
 * - 이미 발송(alreadyNotified)이면 재발송 없음 — 선발 변경(공식값→다른 공식값)도 여기 걸려 1회 계약 유지.
 */
export function shouldEmitStarterAnnounce(input: {
  bothOfficial: boolean; // 현재 관측: 양팀 선발 모두 공식값
  alreadyNotified: boolean; // 원장상 이미 발송(이 gameId+team)
  sawUnannouncedBefore: boolean; // 실제 빈값 관측 이력 — 없으면 baseline(발송 금지)
  gameCancelled?: boolean; // 취소 fail-safe
}): boolean {
  if (input.gameCancelled === true) return false;
  if (!input.bothOfficial) return false;
  if (input.alreadyNotified) return false;
  if (!input.sawUnannouncedBefore) return false; // rollout 기공개 baseline — 전이 아님
  return true;
}

export interface StarterAnnounceMessageInput {
  /** 수신자 최애팀 (홈 또는 원정). title 렌더용. */
  teamId: number;
  awayTeamId: number;
  homeTeamId: number;
  awayStarterName: string;
  homeStarterName: string;
  /** 경기 날짜 "YYYYMMDD" (KST). 연전 공시는 D+1·D+2 경기도 포함되므로 날짜를 명시한다. */
  gameDate: string;
  /** 경기 시작 시각 "HH:MM"(KST). 게임 데이터에서 그대로 전달. */
  gameTimeKst: string;
}

export interface StarterAnnounceMessage {
  title: string;
  body: string;
}

/** "YYYYMMDD" → "M월 D일". 파싱 불가 시 원문 유지(방어). */
export function formatKstMonthDay(yyyymmdd: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(yyyymmdd.trim());
  if (!m) return yyyymmdd;
  return `${Number(m[2])}월 ${Number(m[3])}일`;
}

/** 예고선발 공개 문구. 수신자 최애팀 기준 title + 양팀 선발 맞대결 body. */
export function formatStarterAnnounceMessage(input: StarterAnnounceMessageInput): StarterAnnounceMessage {
  const team = teamShortName(input.teamId);
  const away = teamShortName(input.awayTeamId);
  const home = teamShortName(input.homeTeamId);
  return {
    title: `${team} 예고선발 공개`,
    body: `${formatKstMonthDay(input.gameDate)} ${input.gameTimeKst} ${away}(${input.awayStarterName.trim()}) vs ${home}(${input.homeStarterName.trim()}) 예고선발이 공개되었습니다. 선발 맞대결을 확인해보세요.`,
  };
}
