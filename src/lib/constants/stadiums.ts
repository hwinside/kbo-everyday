export interface Stadium {
  id: string;
  name: string;
  city: string;
  teamIds: number[];
  capacity: string;
  image: string; // emoji placeholder
}

export const STADIUMS: Stadium[] = [
  { id: "jamsil", name: "잠실야구장", city: "서울 송파구", teamIds: [1, 2], capacity: "25,553", image: "🏟️" },
  { id: "suwon", name: "수원KT위즈파크", city: "경기 수원시", teamIds: [3], capacity: "20,000", image: "🏟️" },
  { id: "incheon", name: "인천SSG랜더스필드", city: "인천 미추홀구", teamIds: [4], capacity: "23,000", image: "🏟️" },
  { id: "changwon", name: "창원NC파크", city: "경남 창원시", teamIds: [5], capacity: "22,112", image: "🏟️" },
  { id: "gwangju", name: "광주-기아 챔피언스 필드", city: "광주 북구", teamIds: [6], capacity: "20,500", image: "🏟️" },
  { id: "sajik", name: "사직야구장", city: "부산 동래구", teamIds: [7], capacity: "24,500", image: "🏟️" },
  { id: "daegu", name: "대구삼성라이온즈파크", city: "대구 수성구", teamIds: [8], capacity: "24,000", image: "🏟️" },
  { id: "daejeon", name: "한화생명이글스파크", city: "대전 중구", teamIds: [9], capacity: "13,000", image: "🏟️" },
  { id: "gocheok", name: "고척스카이돔", city: "서울 구로구", teamIds: [10], capacity: "16,813", image: "🏟️" },
];
