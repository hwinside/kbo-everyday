export interface TicketPolicy {
  teamId: number;
  /** 홈경기 기준 예매 오픈까지 남은 일수 */
  daysBeforeGame: number;
  /** 예매 오픈 KST 시각 (0-23) */
  openHour: number;
  /** 예매 URL */
  buyUrl: string;
  /** 예매처 이름 */
  provider: string;
}

export const TICKET_POLICIES: TicketPolicy[] = [
  { teamId: 1,  daysBeforeGame: 7, openHour: 10, buyUrl: "https://www.ticketlink.co.kr/sports/baseball/5", provider: "티켓링크" },   // LG
  { teamId: 2,  daysBeforeGame: 7, openHour: 10, buyUrl: "https://ticket.interpark.com/sports/baseball",  provider: "인터파크" },    // 두산
  { teamId: 3,  daysBeforeGame: 7, openHour: 17, buyUrl: "https://www.ticketlink.co.kr/sports/baseball/5", provider: "티켓링크" },   // KT (수원 주차처럼 경기 7일 전 17시)
  { teamId: 4,  daysBeforeGame: 7, openHour: 10, buyUrl: "https://www.ssg.com/event/sports.ssg",           provider: "SSG닷컴" },      // SSG
  { teamId: 5,  daysBeforeGame: 5, openHour: 10, buyUrl: "https://www.ncdinos.com/ticket/reservation",     provider: "NC 공식앱" },   // NC
  { teamId: 6,  daysBeforeGame: 7, openHour: 10, buyUrl: "https://www.ticketlink.co.kr/sports/baseball/5", provider: "티켓링크" },   // KIA
  { teamId: 7,  daysBeforeGame: 7, openHour: 10, buyUrl: "https://www.giantsclub.com/ticket",              provider: "롯데 공식앱" }, // 롯데
  { teamId: 8,  daysBeforeGame: 7, openHour: 10, buyUrl: "https://www.ticketlink.co.kr/sports/baseball/5", provider: "티켓링크" },   // 삼성
  { teamId: 9,  daysBeforeGame: 7, openHour: 10, buyUrl: "https://www.ticketlink.co.kr/sports/baseball/5", provider: "티켓링크" },   // 한화
  { teamId: 10, daysBeforeGame: 7, openHour: 10, buyUrl: "https://ticket.interpark.com/sports/baseball",   provider: "놀티켓" },      // 키움
];
