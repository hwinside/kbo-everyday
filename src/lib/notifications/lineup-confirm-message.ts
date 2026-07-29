/**
 * 라인업 확정 알림 — 순수 문구 포맷터 + 전이 판정 (하린아빠 스펙 2026-07-29, #cs 1785295937.731339).
 *
 * 확정 문구(gate ④ KST 시각·팀명 문법):
 *   "금일 {확정시각} 시 {경기시각}전의 {팀명} 라인업이 확정되었습니다. 자세한 라인업을 확인해보세요."
 *   - {확정시각} = 미확정→확정 최초 전이를 감지·발송한 시각(KST HH:MM)
 *   - {경기시각} = 경기 시작 시각(KST HH:MM)
 *   - {팀명}     = 최애팀 shortName (예: LG, 한화, KT)
 */
import { TEAMS } from "@/lib/constants/teams";

/** Date → KST "HH:MM"(24h). Intl(Asia/Seoul)로 서버 TZ 무관하게 고정. */
export function toKstHhmm(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const hh = parts.find((p) => p.type === "hour")?.value ?? "00";
  const mm = parts.find((p) => p.type === "minute")?.value ?? "00";
  return `${hh}:${mm}`;
}

/** 팀 shortName(예: "LG", "한화"). 미상 팀은 방어적 폴백. */
export function teamShortName(teamId: number): string {
  return TEAMS.find((t) => t.id === teamId)?.shortName ?? `${teamId}팀`;
}

export interface LineupConfirmMessageInput {
  teamId: number;
  /** 확정 감지=발송 시각. KST HH:MM 로 렌더. */
  confirmedAt: Date;
  /** 경기 시작 시각 "HH:MM"(KST). 게임 데이터에서 그대로 전달. */
  gameTimeKst: string;
}

export interface LineupConfirmMessage {
  title: string;
  body: string;
}

/** 하린아빠 확정 문구를 그대로 생성(gate ④). title 은 팀 shortName 기준. */
export function formatLineupConfirmMessage(input: LineupConfirmMessageInput): LineupConfirmMessage {
  const team = teamShortName(input.teamId);
  const confirmHhmm = toKstHhmm(input.confirmedAt);
  return {
    title: `${team} 라인업 확정`,
    body: `금일 ${confirmHhmm} 시 ${input.gameTimeKst}전의 ${team} 라인업이 확정되었습니다. 자세한 라인업을 확인해보세요.`,
  };
}

/**
 * 미확정→확정 최초 전이 판정(gate ①②의 순수 계약 부분).
 * 실제 단일 전이 보장(폴링/재배포 중복 0)은 DB 원장의 원자 claim 이 담당하고,
 * 이 함수는 그 앞단 게이트: 확정 신호가 없거나 이미 발송했거나 취소/연기면 발송 대상 아님.
 */
export function shouldEmitLineupConfirm(input: {
  lineupConfirmed: boolean; // 현재 KBO LINEUP_CK
  alreadyNotified: boolean; // 원장상 이미 발송(이 gameId+team)
  gameCancelled?: boolean; // 취소/연기 fail-safe
}): boolean {
  if (input.gameCancelled === true) return false;
  if (!input.lineupConfirmed) return false;
  if (input.alreadyNotified) return false;
  return true;
}
