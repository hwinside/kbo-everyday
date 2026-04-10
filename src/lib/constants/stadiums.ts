export interface Stadium {
  id: string;
  name: string;
  city: string;
  teamIds: number[];
  capacity: string;
  image: string; // emoji placeholder
  parking: { fee: string; tips: string };
  transit: { subway: string; bus: string };
  ticketing: { provider: string; url: string; priceRange: string };
  foodBrands: string[];
}

export const STADIUMS: Stadium[] = [
  {
    id: "jamsil",
    name: "잠실야구장",
    city: "서울 송파구",
    teamIds: [1, 2],
    capacity: "25,553",
    image: "🏟️",
    parking: { fee: "경기일 선불 6,000원", tips: "5부제 시행(2026.4.8~), 주차면 876면으로 축소. 대중교통 강력 권장" },
    transit: { subway: "2호선/9호선 종합운동장역 5·6번 출구 도보 5분", bus: "301, 333, 341, 345, 350, 360" },
    ticketing: { provider: "LG: 티켓링크 / 두산: 인터파크", url: "https://www.ticketlink.co.kr", priceRange: "9,000원(외야)~90,000원(프리미엄) (2026 시즌 기준)" },
    foodBrands: ["통밥", "BHC", "BBQ", "프랭크버거", "이가네떡볶이", "XOXO 핫도그"],
  },
  {
    id: "suwon",
    name: "수원KT위즈파크",
    city: "경기 수원시",
    teamIds: [3],
    capacity: "20,000",
    image: "🏟️",
    parking: { fee: "승용차 3,000원 (선불)", tips: "주차예약제 시행. 홈경기 7일 전 17시부터 예약. 만석공원 공영주차장(도보 20분) 대안" },
    transit: { subway: "수인분당선 수원시청역 2번 출구 도보 10분", bus: "2007, 621, 7770, 310, 991" },
    ticketing: { provider: "티켓링크", url: "https://www.ticketlink.co.kr", priceRange: "10,000원(외야)~70,000원(포수뒤테이블) (2026 시즌 기준)" },
    foodBrands: ["진미통닭", "보영만두", "BHC", "파파존스", "롯데리아", "이대로통삼겹"],
  },
  {
    id: "incheon",
    name: "인천SSG랜더스필드",
    city: "인천 미추홀구",
    teamIds: [4],
    capacity: "23,000",
    image: "🏟️",
    parking: { fee: "경기일 2,000원 (선불)", tips: "지하+지상 최대 4,000대. KBO 구장 중 최대 규모. 경기 후 혼잡 주의" },
    transit: { subway: "인천1호선 문학경기장역 2번 출구 도보 5분", bus: "부평역·주안역에서 다수 노선" },
    ticketing: { provider: "SSG닷컴", url: "https://www.ssg.com", priceRange: "11,000원(SKY뷰)~37,000원(홈런커플존) (2026 시즌 기준)" },
    foodBrands: ["스타벅스", "BHC", "노브랜드버거", "이마트24", "노랑통닭", "컴포즈커피", "허갈닭강정"],
  },
  {
    id: "changwon",
    name: "창원NC파크",
    city: "경남 창원시",
    teamIds: [5],
    capacity: "22,112",
    image: "🏟️",
    parking: { fee: "무료 (경기종료 후 1시간까지)", tips: "4층 주차타워 이용. 만차 시 양덕공영주차장(무료)" },
    transit: { subway: "없음 (시내버스 이용)", bus: "100, 105, 108, 160, 720번. 마산역(KTX) 이용 가능" },
    ticketing: { provider: "NC 다이노스 앱", url: "https://www.ncdinos.com", priceRange: "다이내믹 프라이싱 (AI 가격 책정, 2026 시즌)" },
    foodBrands: ["스타벅스 리저브", "반올림피자", "맘스터치", "BHC", "죠스떡볶이", "투다리"],
  },
  {
    id: "gwangju",
    name: "광주-기아 챔피언스 필드",
    city: "광주 북구",
    teamIds: [6],
    capacity: "20,500",
    image: "🏟️",
    parking: { fee: "경기 당일 3,000원", tips: "지하 621면. 무등야구장·임동 공영주차장 무료 개방" },
    transit: { subway: "광주1호선 문화전당역 하차 후 버스 환승", bus: "매월16, 송암47, 상무64번" },
    ticketing: { provider: "티켓링크", url: "https://www.ticketlink.co.kr", priceRange: "10,000원(외야)~85,000원(스카이박스) (2026 시즌 기준)" },
    foodBrands: ["이마트24", "파파존스", "INC COFFEE", "광주원샷", "스트릿츄러스"],
  },
  {
    id: "sajik",
    name: "사직야구장",
    city: "부산 동래구",
    teamIds: [7],
    capacity: "24,500",
    image: "🏟️",
    parking: { fee: "10분당 200원 (일 최대 5,000원)", tips: "경기일 극심한 혼잡. 홈플러스 아시아드점(도보 15분) 대안" },
    transit: { subway: "부산3호선 사직역·종합운동장역", bus: "10, 44, 50, 57, 80, 111, 131번" },
    ticketing: { provider: "롯데 자이언츠 앱", url: "https://www.giantsclub.com", priceRange: "컬러 프라이스 (상대팀·날짜별 변동, 2026 시즌)" },
    foodBrands: ["가온밀면", "심바다", "송헌집", "보영만두", "계란빵클럽", "포도베이커스"],
  },
  {
    id: "daegu",
    name: "대구삼성라이온즈파크",
    city: "대구 수성구",
    teamIds: [8],
    capacity: "24,000",
    image: "🏟️",
    parking: { fee: "전설로 주차장 2,000원 (선불)", tips: "대구미술관 주차장 무료 + 셔틀버스 운행" },
    transit: { subway: "대구2호선 수성알파시티역 직결", bus: "급행1, 급행2, 401번" },
    ticketing: { provider: "티켓링크", url: "https://www.ticketlink.co.kr", priceRange: "외야석~65,000원(VIP블루) (2026 시즌 기준)" },
    foodBrands: ["CU", "버터우드", "지코바", "요야정", "정여사손만두", "노랑통닭", "할리스"],
  },
  {
    id: "daejeon",
    name: "한화생명이글스파크",
    city: "대전 중구",
    teamIds: [9],
    capacity: "13,000",
    image: "🏟️",
    parking: { fee: "주변 임시 공영주차장 무료 (4곳 200면)", tips: "자체 주차장 혼잡. 대사문화공원(82면, 도보5분), 중부소방서 부지(60면) 등 활용" },
    transit: { subway: "대전1호선 중구청역·중앙로역 도보 20분", bus: "2, 33, 52, 119, 513, 604번" },
    ticketing: { provider: "티켓링크", url: "https://www.ticketlink.co.kr", priceRange: "5단계 구간요금제, 최대 82,000원(포수후면) (2026 시즌)" },
    foodBrands: ["아라마크(MLB식)", "새마을식당", "역전우동", "한신포차", "빽다방", "BBQ", "GS25"],
  },
  {
    id: "gocheok",
    name: "고척스카이돔",
    city: "서울 구로구",
    teamIds: [10],
    capacity: "16,813",
    image: "🏟️",
    parking: { fee: "내부 주차장 제한적", tips: "484면뿐. 5부제 시행. 동양미래대 주차장(도보3분, 30분 1,500원) 대안" },
    transit: { subway: "1호선 구일역 2번 출구 도보 10분", bus: "160, 600, 6513, 6611" },
    ticketing: { provider: "놀티켓", url: "https://ticket.interpark.com", priceRange: "계절별 요금제 적용 (2026 시즌)" },
    foodBrands: ["맘스터치", "BBQ", "BHC", "멕시카나", "쉬림프셰프", "편밀밀", "올떡볶이"],
  },
];
