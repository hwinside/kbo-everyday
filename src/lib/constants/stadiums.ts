export interface Stadium {
  id: string;
  name: string;
  city: string;
  teamIds: number[];
  capacity: string;
  image: string; // emoji placeholder
  reviewCount: number;
  rating: number;
  foodSpots: { name: string; category: string; rating: number; distance: string }[];
  seatTips: { zone: string; tip: string; rating: number }[];
}

export const STADIUMS: Stadium[] = [
  {
    id: "jamsil", name: "잠실야구장", city: "서울 송파구", teamIds: [1, 2],
    capacity: "25,553", image: "🏟️", reviewCount: 1284, rating: 4.2,
    foodSpots: [
      { name: "잠실 치킨거리", category: "치킨", rating: 4.5, distance: "도보 3분" },
      { name: "석촌호수 카페거리", category: "카페", rating: 4.3, distance: "도보 8분" },
      { name: "방이동 먹자골목", category: "다양", rating: 4.4, distance: "도보 5분" },
      { name: "잠실새내 곱창거리", category: "곱창", rating: 4.6, distance: "도보 10분" },
    ],
    seatTips: [
      { zone: "1루 내야", tip: "LG 홈. 응원 열기 최고! 파울볼 주의", rating: 4.5 },
      { zone: "3루 내야", tip: "두산 홈. 곰 응원단 가까이", rating: 4.3 },
      { zone: "외야 잔디석", tip: "피크닉 분위기. 경기 잘 안 보임 ㅋㅋ", rating: 3.8 },
      { zone: "테이블석", tip: "치맥하기 최고. 예매 경쟁 치열", rating: 4.7 },
    ],
  },
  {
    id: "suwon", name: "수원KT위즈파크", city: "경기 수원시", teamIds: [3],
    capacity: "20,000", image: "🏟️", reviewCount: 876, rating: 4.5,
    foodSpots: [
      { name: "행리단길", category: "다양", rating: 4.4, distance: "도보 12분" },
      { name: "수원 통닭거리", category: "치킨", rating: 4.7, distance: "버스 10분" },
      { name: "팔달문 시장", category: "전통시장", rating: 4.3, distance: "버스 15분" },
    ],
    seatTips: [
      { zone: "스카이박스", tip: "뷰 최고! 에어컨 있음. 가성비 좋음", rating: 4.8 },
      { zone: "잔디석", tip: "아이와 함께하기 좋음. 놀이시설 가까움", rating: 4.4 },
      { zone: "내야 지정석", tip: "그늘 있는 좌석 추천 (여름 필수)", rating: 4.2 },
    ],
  },
  {
    id: "incheon", name: "인천SSG랜더스필드", city: "인천 미추홀구", teamIds: [4],
    capacity: "23,000", image: "🏟️", reviewCount: 1056, rating: 4.7,
    foodSpots: [
      { name: "구장 내 푸드코트", category: "다양", rating: 4.6, distance: "구장 내" },
      { name: "연수동 맛집거리", category: "다양", rating: 4.2, distance: "도보 15분" },
    ],
    seatTips: [
      { zone: "그린존", tip: "잔디 위 피크닉! 인스타 핫플", rating: 4.9 },
      { zone: "파티플로어", tip: "스탠딩 응원. 젊은 층 추천", rating: 4.5 },
      { zone: "프리미엄석", tip: "넓은 좌석 + 전용 매점. 가족 추천", rating: 4.6 },
    ],
  },
  {
    id: "changwon", name: "창원NC파크", city: "경남 창원시", teamIds: [5],
    capacity: "22,112", image: "🏟️", reviewCount: 724, rating: 4.6,
    foodSpots: [
      { name: "마산어시장", category: "해산물", rating: 4.8, distance: "차 15분" },
      { name: "창원 중앙동", category: "다양", rating: 4.1, distance: "차 10분" },
    ],
    seatTips: [
      { zone: "스카이라운지", tip: "뷰 + 에어컨 + 음식 최고 조합", rating: 4.8 },
      { zone: "외야 응원석", tip: "NC 응원 열기 체감. 가성비 좋음", rating: 4.3 },
    ],
  },
  {
    id: "gwangju", name: "광주-기아 챔피언스 필드", city: "광주 북구", teamIds: [6],
    capacity: "20,500", image: "🏟️", reviewCount: 945, rating: 4.4,
    foodSpots: [
      { name: "충장로 먹자골목", category: "다양", rating: 4.5, distance: "버스 20분" },
      { name: "구장 내 매점", category: "구장음식", rating: 4.0, distance: "구장 내" },
    ],
    seatTips: [
      { zone: "응원석", tip: "KIA 응원 문화 체험 필수!", rating: 4.6 },
      { zone: "패밀리석", tip: "아이 놀이공간 있음", rating: 4.3 },
    ],
  },
  {
    id: "sajik", name: "사직야구장", city: "부산 동래구", teamIds: [7],
    capacity: "24,500", image: "🏟️", reviewCount: 1432, rating: 4.1,
    foodSpots: [
      { name: "사직동 먹자골목", category: "다양", rating: 4.6, distance: "도보 3분" },
      { name: "온천장 먹자골목", category: "다양", rating: 4.4, distance: "도보 10분" },
      { name: "사직 닭똥집 골목", category: "닭똥집", rating: 4.7, distance: "도보 5분" },
    ],
    seatTips: [
      { zone: "응원석", tip: "부산 갈매기 떼창! 분위기 미침", rating: 4.8 },
      { zone: "내야 B석", tip: "가성비 최고. 소리가 잘 들림", rating: 4.2 },
      { zone: "외야석", tip: "시원한 바람. 맥주 필수", rating: 4.0 },
    ],
  },
  {
    id: "daegu", name: "대구삼성라이온즈파크", city: "대구 수성구", teamIds: [8],
    capacity: "24,000", image: "🏟️", reviewCount: 812, rating: 4.5,
    foodSpots: [
      { name: "수성못 카페거리", category: "카페", rating: 4.5, distance: "도보 15분" },
      { name: "들안길 맛집거리", category: "다양", rating: 4.3, distance: "차 10분" },
    ],
    seatTips: [
      { zone: "잔디석", tip: "가족 소풍 분위기. 넓고 쾌적", rating: 4.6 },
      { zone: "Y존", tip: "젊은 층 핫플. 포토존 가까움", rating: 4.4 },
    ],
  },
  {
    id: "daejeon", name: "한화생명이글스파크", city: "대전 중구", teamIds: [9],
    capacity: "13,000", image: "🏟️", reviewCount: 678, rating: 3.9,
    foodSpots: [
      { name: "성심당", category: "빵", rating: 4.9, distance: "차 10분" },
      { name: "대흥동 먹자골목", category: "다양", rating: 4.2, distance: "차 8분" },
    ],
    seatTips: [
      { zone: "응원석", tip: "한화 팬 열정 체감. 가성비 최고", rating: 4.3 },
      { zone: "테이블석", tip: "먹으면서 관람. 분위기 좋음", rating: 4.1 },
    ],
  },
  {
    id: "gocheok", name: "고척스카이돔", city: "서울 구로구", teamIds: [10],
    capacity: "16,813", image: "🏟️", reviewCount: 956, rating: 3.7,
    foodSpots: [
      { name: "고척동 먹자골목", category: "다양", rating: 3.9, distance: "도보 5분" },
      { name: "구로디지털단지 맛집", category: "다양", rating: 4.1, distance: "지하철 10분" },
    ],
    seatTips: [
      { zone: "중앙지정석", tip: "돔구장이라 비/더위 걱정 없음", rating: 4.2 },
      { zone: "외야석", tip: "키움 응원석. 소리 울림이 큼", rating: 4.0 },
      { zone: "테이블석", tip: "4인 가족 추천. 음식 주문 편함", rating: 4.3 },
    ],
  },
];
