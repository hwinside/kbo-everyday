import { TICKET_OPEN_RULES } from "@/lib/constants/tickets";

export type TicketOpenStatus = "countdown";

export interface NextTicketOpen {
  status: TicketOpenStatus;
  /** 예매 오픈 시각 */
  openAt: Date;
  /** 대상 경기 날짜 YYYYMMDD */
  gameDate: string;
  /** 대상 경기 시작 시각 (HH:MM) — 없으면 빈 문자열 */
  gameTime: string;
  /** 상대 팀명 (홈경기=원정팀, 원정경기=홈팀) — 없으면 빈 문자열 */
  opponentName: string;
  /** 원정경기 여부 (true=상대 구장, 상대팀 예매처) */
  isAway: boolean;
  buyUrl: string;
  provider: string;
  /** 오픈까지 남은 ms (countdown only) */
  msUntilOpen: number;
  /** 더블헤더/일정 변경 경기 → 예매 일정 확정 불가(별도 확인 안내) */
  uncertain: boolean;
}

/**
 * 다가오는 경기(홈+원정) 목록을 받아 "다음 예매 오픈(대기중)" 경기를 반환.
 * - 예매 룰은 *경기를 주최하는 홈팀(homeTeamId)* 기준 — 원정경기는 상대(홈)팀의 예매처/오픈룰을 따른다.
 * - 예매처가 오픈 즉시 매진되므로 '지금 예매중' 경기는 노출하지 않음 — *다음 오픈 예정* 경기만 의미 있음.
 * - 홈/원정 통틀어 *가장 먼저 오픈되는* 대기 경기를 반환(없으면 null = 카드 미노출).
 */
export function getNextTicketOpen(
  upcomingGames: Array<{ date: string; time?: string; homeTeamId: number; opponentName?: string; isAway?: boolean; uncertain?: boolean }>,
  now: Date = new Date()
): NextTicketOpen | null {
  if (upcomingGames.length === 0) return null;

  const openAtOf = (date: string, hostId: number): Date | null => {
    const policy = TICKET_OPEN_RULES[hostId];
    if (!policy) return null;
    const y = parseInt(date.slice(0, 4));
    const m = parseInt(date.slice(4, 6)) - 1;
    const d = parseInt(date.slice(6, 8));
    return new Date(y, m, d - policy.daysBefore, policy.hour, 0, 0);
  };
  const isPastGame = (date: string) => {
    const y = parseInt(date.slice(0, 4));
    const m = parseInt(date.slice(4, 6)) - 1;
    const d = parseInt(date.slice(6, 8));
    return new Date(y, m, d, 23, 59, 59) < now;
  };

  let best: NextTicketOpen | null = null;
  for (const game of upcomingGames) {
    if (isPastGame(game.date)) continue;
    const policy = TICKET_OPEN_RULES[game.homeTeamId];
    if (!policy) continue; // 주최팀 예매룰 미정의 → 스킵
    const openAt = openAtOf(game.date, game.homeTeamId);
    if (!openAt) continue;
    const msUntilOpen = openAt.getTime() - now.getTime();
    // 이미 예매 오픈된 경기는 노출하지 않음(오픈 즉시 매진) → 다음 오픈 대기 경기만
    if (msUntilOpen <= 0) continue;
    // 홈/원정 중 가장 먼저 오픈되는 경기 선택(호스트별 daysBefore가 달라도 안전)
    if (best && openAt.getTime() >= best.openAt.getTime()) continue;

    best = {
      status: "countdown",
      openAt,
      gameDate: game.date,
      gameTime: game.time ?? "",
      opponentName: game.opponentName ?? "",
      isAway: !!game.isAway,
      buyUrl: policy.url,
      provider: policy.provider,
      msUntilOpen,
      uncertain: !!game.uncertain,
    };
  }

  return best;
}

export function formatCountdown(ms: number): string {
  if (ms <= 0) return "오픈!";
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;

  if (days > 0) return `${days}일 ${hours}시간 후`;
  if (hours > 0) return `${hours}시간 ${mins}분 후`;
  if (mins > 0) return `${mins}분 ${secs}초 후`;
  return `${secs}초 후`;
}

const WD = ["일", "월", "화", "수", "목", "금", "토"];

/** 예매 오픈 일시 → "6/26 (목) 오전 11시" */
export function formatOpenAt(d: Date): string {
  const h = d.getHours();
  const ampm = h < 12 ? "오전" : "오후";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const min = d.getMinutes();
  return `${d.getMonth() + 1}/${d.getDate()} (${WD[d.getDay()]}) ${ampm} ${h12}시${min > 0 ? ` ${min}분` : ""}`;
}

/** 대상 경기 일시 → "7/3 (목) 18:30" (시간 없으면 날짜만) */
export function formatGameDateTime(yyyymmdd: string, time: string): string {
  const y = parseInt(yyyymmdd.slice(0, 4));
  const m = parseInt(yyyymmdd.slice(4, 6)) - 1;
  const d = parseInt(yyyymmdd.slice(6, 8));
  const dt = new Date(y, m, d);
  const base = `${m + 1}/${d} (${WD[dt.getDay()]})`;
  return time ? `${base} ${time}` : base;
}
