export interface TicketOpenRule {
  /** 홈경기 기준 예매 오픈까지 며칠 전 */
  daysBefore: number;
  /** 예매 오픈 KST 시각 (0-23) */
  hour: number;
  /** 최대 예매 매수 */
  maxTickets: number;
  /** 표시용 텍스트 */
  label: string;
  /** 예매처 이름 */
  provider: string;
  /** 예매 링크 */
  url: string;
}

/**
 * 구단별 예매 오픈 룰 — SSOT.
 * StadiumCalendar(예매 일정 달력)와 TeamNextTicketCard(팀 페이지 다음 예매 카운트다운)가
 * 동일 규칙을 공유하도록 한 곳에서 관리한다. 룰 변경 시 여기만 고치면 양쪽 반영.
 */
export const TICKET_OPEN_RULES: Record<number, TicketOpenRule> = {
  1:  { daysBefore: 7,  hour: 11, maxTickets: 4,  label: "경기 7일 전 오전 11시 (최대 4매)", provider: "티켓링크", url: "https://www.ticketlink.co.kr" },
  2:  { daysBefore: 7,  hour: 11, maxTickets: 4,  label: "경기 7일 전 오전 11시 (최대 4매)", provider: "인터파크", url: "https://ticket.interpark.com" },
  3:  { daysBefore: 7,  hour: 16, maxTickets: 8,  label: "경기 7일 전 오후 4시 (최대 8매)", provider: "티켓링크", url: "https://www.ticketlink.co.kr" },
  4:  { daysBefore: 5,  hour: 11, maxTickets: 6,  label: "경기 5일 전 오전 11시 (최대 6매)", provider: "SSG닷컴", url: "https://www.ssg.com" },
  5:  { daysBefore: 6,  hour: 11, maxTickets: 10, label: "경기 6일 전 오전 11시 (최대 10매)", provider: "NC 다이노스", url: "https://www.ncdinos.com" },
  6:  { daysBefore: 7,  hour: 11, maxTickets: 4,  label: "경기 7일 전 오전 11시 (최대 4매)", provider: "티켓링크", url: "https://www.ticketlink.co.kr" },
  7:  { daysBefore: 14, hour: 14, maxTickets: 8,  label: "경기 14일 전 오후 2시 (최대 8매)", provider: "롯데 자이언츠", url: "https://www.giantsclub.com" },
  8:  { daysBefore: 7,  hour: 11, maxTickets: 6,  label: "경기 7일 전 오전 11시 (최대 6매)", provider: "티켓링크", url: "https://www.ticketlink.co.kr" },
  9:  { daysBefore: 7,  hour: 11, maxTickets: 4,  label: "경기 7일 전 오전 11시 (최대 4매)", provider: "티켓링크", url: "https://www.ticketlink.co.kr" },
  10: { daysBefore: 7,  hour: 14, maxTickets: 4,  label: "경기 7일 전 오후 2시 (최대 4매)", provider: "놀티켓", url: "https://ticket.interpark.com" },
};
