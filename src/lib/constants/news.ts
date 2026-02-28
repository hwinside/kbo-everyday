/* ===== 뉴스 & 영상 목업 데이터 ===== */

export interface NewsMock {
  id: number;
  teamId: number | null;
  title: string;
  source: string;
  sourceUrl: string;
  thumbnailUrl: string | null;
  timeAgo: string;
  type: "news";
}

export interface VideoMock {
  id: string;
  teamId: number;
  title: string;
  channelName: string;
  thumbnailUrl: string | null;
  viewCount: number;
  timeAgo: string;
  type: "video";
}

export type FeedItem = NewsMock | VideoMock;

export const MOCK_NEWS: NewsMock[] = [
  { id: 1, teamId: 1, title: "LG 오스틴, 시범경기 첫 홈런… 시즌 기대감 UP", source: "스포츠조선", sourceUrl: "#", thumbnailUrl: null, timeAgo: "2시간 전", type: "news" },
  { id: 2, teamId: 2, title: "두산, 신인 투수 깜짝 선발 발탁… 감독 \"기대된다\"", source: "일간스포츠", sourceUrl: "#", thumbnailUrl: null, timeAgo: "3시간 전", type: "news" },
  { id: 3, teamId: null, title: "KBO 개막전 일정 확정, 3월 29일 5경기 동시 개막", source: "OSEN", sourceUrl: "#", thumbnailUrl: null, timeAgo: "5시간 전", type: "news" },
  { id: 4, teamId: 6, title: "KIA 양현종, 베테랑의 귀환… 불펜 합류 확정", source: "스포츠서울", sourceUrl: "#", thumbnailUrl: null, timeAgo: "6시간 전", type: "news" },
  { id: 5, teamId: 4, title: "SSG 추신수, 은퇴 후 코치 전환… 타격 코치로 합류", source: "MK스포츠", sourceUrl: "#", thumbnailUrl: null, timeAgo: "8시간 전", type: "news" },
  { id: 6, teamId: 3, title: "KT 강백호, 스프링캠프 MVP 선정… 타격감 폭발", source: "스포츠동아", sourceUrl: "#", thumbnailUrl: null, timeAgo: "10시간 전", type: "news" },
  { id: 7, teamId: 5, title: "NC 박건우, 2000안타 도전… 시즌 중 달성 유력", source: "일간스포츠", sourceUrl: "#", thumbnailUrl: null, timeAgo: "12시간 전", type: "news" },
  { id: 8, teamId: 9, title: "한화 류현진, 재활 순조로움… 5월 복귀 목표", source: "스포츠조선", sourceUrl: "#", thumbnailUrl: null, timeAgo: "1일 전", type: "news" },
  { id: 9, teamId: 7, title: "롯데 전준우, FA 잔류 선언… \"사직이 내 집\"", source: "OSEN", sourceUrl: "#", thumbnailUrl: null, timeAgo: "1일 전", type: "news" },
  { id: 10, teamId: 10, title: "키움, 신인 드래프트 1순위 지명권 확보… 유망주 영입 기대", source: "MK스포츠", sourceUrl: "#", thumbnailUrl: null, timeAgo: "2일 전", type: "news" },
];

export const MOCK_VIDEOS: VideoMock[] = [
  { id: "v1", teamId: 1, title: "[하이라이트] LG vs 두산 — 오스틴 결승 2점 홈런!", channelName: "LG Twins TV", thumbnailUrl: null, viewCount: 123000, timeAgo: "3시간 전", type: "video" },
  { id: "v2", teamId: 6, title: "[경기 리뷰] KIA 7:3 롯데 — 타이거즈 개막전 압승!", channelName: "KIA Tigers TV", thumbnailUrl: null, viewCount: 89000, timeAgo: "5시간 전", type: "video" },
  { id: "v3", teamId: 2, title: "[인터뷰] 곽빈 \"아쉽지만 다음 등판에서 반드시\"", channelName: "Bears TV", thumbnailUrl: null, viewCount: 45000, timeAgo: "6시간 전", type: "video" },
  { id: "v4", teamId: 4, title: "[브이로그] SSG 선수들의 개막전 하루", channelName: "SSG Landers TV", thumbnailUrl: null, viewCount: 67000, timeAgo: "1일 전", type: "video" },
  { id: "v5", teamId: 8, title: "[분석] 2026 삼성 라이온즈 전력 분석", channelName: "야구분석TV", thumbnailUrl: null, viewCount: 156000, timeAgo: "2일 전", type: "video" },
];

export function formatViewCount(count: number): string {
  if (count >= 10000) {
    return `${(count / 10000).toFixed(1)}만`;
  }
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}천`;
  }
  return count.toLocaleString();
}
