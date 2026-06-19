import { TICKET_OPEN_RULES } from "@/lib/constants/tickets";

export type TicketOpenStatus = "countdown" | "on_sale" | "none";

export interface NextTicketOpen {
  status: TicketOpenStatus;
  /** 예매 오픈 시각 (countdown 상태) 또는 판매 중 기준 경기 날짜 (on_sale 상태) */
  openAt: Date;
  /** 대상 홈경기 날짜 YYYYMMDD */
  gameDate: string;
  /** 대상 홈경기 시작 시각 (HH:MM) — 없으면 빈 문자열 */
  gameTime: string;
  buyUrl: string;
  provider: string;
  /** 오픈까지 남은 ms (countdown only) */
  msUntilOpen: number;
  /** 더블헤더/일정 변경 경기 → 예매 일정 확정 불가(별도 확인 안내) */
  uncertain: boolean;
  /** countdown 표시 시, 동시에 이미 예매 중인 더 가까운 홈경기 날짜(YYYYMMDD) — 보조 표기용. 없으면 null */
  concurrentOnSaleDate: string | null;
}

/**
 * 팀 + 다가오는 홈경기 목록을 받아 "다음 예매 오픈(대기중)" 경기를 우선 반환.
 * - 예매처가 오픈 즉시 매진되므로 '지금 예매중'보다 *다음 오픈 예정* 경기가 더 유의미.
 * - 다음 오픈 대기 경기(countdown)를 우선 노출하고, 동시에 이미 예매중인 더 가까운 경기는 보조(concurrentOnSaleDate)로 표기.
 * - 대기중 경기가 전혀 없을 때만 가장 가까운 예매중(on_sale) 경기로 폴백.
 */
export function getNextTicketOpen(
  teamId: number,
  upcomingHomeGames: Array<{ date: string; time?: string; uncertain?: boolean }>,
  now: Date = new Date()
): NextTicketOpen | null {
  const policy = TICKET_OPEN_RULES[teamId];
  if (!policy || upcomingHomeGames.length === 0) return null;

  const openAtOf = (date: string) => {
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

  // 가장 가까운 '이미 예매중' 경기 (보조/폴백용)
  let onSale: { date: string; time: string; uncertain: boolean } | null = null;

  for (const game of upcomingHomeGames) {
    if (isPastGame(game.date)) continue;
    const openAt = openAtOf(game.date);
    const msUntilOpen = openAt.getTime() - now.getTime();

    if (msUntilOpen > 0) {
      // 다음 예매 오픈(대기) — 우선 노출
      return {
        status: "countdown",
        openAt,
        gameDate: game.date,
        gameTime: game.time ?? "",
        buyUrl: policy.url,
        provider: policy.provider,
        msUntilOpen,
        uncertain: !!game.uncertain,
        // 보조라인은 '확정 예매중'만 — 더블헤더/변경(uncertain) on_sale 경기는 확정 표기 금지(별도 확인 리스크 재유입 방지)
        concurrentOnSaleDate: onSale && !onSale.uncertain ? onSale.date : null,
      };
    }
    // 이미 오픈된 경기 — 가장 가까운 것만 기록
    if (!onSale) onSale = { date: game.date, time: game.time ?? "", uncertain: !!game.uncertain };
  }

  // 대기중 경기 없음 → 가장 가까운 예매중 경기로 폴백
  if (onSale) {
    return {
      status: "on_sale",
      openAt: openAtOf(onSale.date),
      gameDate: onSale.date,
      gameTime: onSale.time,
      buyUrl: policy.url,
      provider: policy.provider,
      msUntilOpen: 0,
      uncertain: onSale.uncertain,
      concurrentOnSaleDate: null,
    };
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
