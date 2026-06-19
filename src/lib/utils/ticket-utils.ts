import { TICKET_OPEN_RULES } from "@/lib/constants/tickets";

export type TicketOpenStatus = "countdown" | "on_sale" | "none";

export interface NextTicketOpen {
  status: TicketOpenStatus;
  /** 예매 오픈 시각 (countdown 상태) 또는 판매 중 기준 경기 날짜 (on_sale 상태) */
  openAt: Date;
  /** 대상 홈경기 날짜 YYYYMMDD */
  gameDate: string;
  buyUrl: string;
  provider: string;
  /** 오픈까지 남은 ms (countdown only) */
  msUntilOpen: number;
  /** 더블헤더/일정 변경 경기 → 예매 일정 확정 불가(별도 확인 안내) */
  uncertain: boolean;
}

/**
 * 팀 + 다가오는 홈경기 목록을 받아 다음 예매 오픈 정보 반환.
 * - 아직 오픈 안 된 가장 가까운 경기 → countdown
 * - 이미 오픈됐지만 경기 전인 경기  → on_sale
 */
export function getNextTicketOpen(
  teamId: number,
  upcomingHomeGames: Array<{ date: string; uncertain?: boolean }>,
  now: Date = new Date()
): NextTicketOpen | null {
  const policy = TICKET_OPEN_RULES[teamId];
  if (!policy || upcomingHomeGames.length === 0) return null;

  for (const game of upcomingHomeGames) {
    const y = parseInt(game.date.slice(0, 4));
    const m = parseInt(game.date.slice(4, 6)) - 1;
    const d = parseInt(game.date.slice(6, 8));

    const gameDay = new Date(y, m, d, 23, 59, 59); // end of game day
    if (gameDay < now) continue; // 이미 지난 경기

    const openAt = new Date(y, m, d - policy.daysBefore, policy.hour, 0, 0);
    const msUntilOpen = openAt.getTime() - now.getTime();

    if (msUntilOpen > 0) {
      // 아직 예매 오픈 전
      return {
        status: "countdown",
        openAt,
        gameDate: game.date,
        buyUrl: policy.url,
        provider: policy.provider,
        msUntilOpen,
        uncertain: !!game.uncertain,
      };
    } else {
      // 이미 예매 중 (openAt 지남, 경기는 아직 안 됨)
      return {
        status: "on_sale",
        openAt,
        gameDate: game.date,
        buyUrl: policy.url,
        provider: policy.provider,
        msUntilOpen: 0,
        uncertain: !!game.uncertain,
      };
    }
  }

  return null;
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
