import { TEAMS } from "@/lib/constants/teams";

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
  zones: string[]; // 좌석팁용 구역 목록 (드롭다운 선택지)
}

/** 구역 직접입력 옵션 라벨 */
export const ZONE_CUSTOM_LABEL = "직접 입력";

/**
 * 구장 → 그 구장을 홈으로 쓰는 구단 slug 배열 (잠실이면 LG·두산 2팀).
 *
 * 구장 좌석팁·후기글은 작성 UI 에 팀 피커가 없지만, 공개범위는 모든 글의 필수 조건이다
 * (`20260807020000_posts_require_team_scope.sql` — board_type 면제는 사용자가 고를 수 있는 값이라
 * 그 자체가 우회로가 된다, 삼순 NO-GO 2026-08-07). 그래서 팀을 리스트에서 고르게 하는 대신
 * **구장에서 파생**한다 — 잠실 좌석팁은 LG·두산 팬 모두에게 유용하므로 의미도 맞는다.
 *
 * 미상 구장은 **빈 배열**을 돌려준다. 임의 팀(예: lg)을 채우면 틀린 팀 피드에 글이 노출된다 —
 * 그럴 바엔 DB 트리거가 거절해 작성이 실패하는 편이 안전하다.
 */
export function teamSlugsForStadium(stadiumId: string | null | undefined): string[] {
  const stadium = STADIUMS.find((s) => s.id === stadiumId);
  if (!stadium) return [];
  return stadium.teamIds
    .map((id) => TEAMS.find((t) => t.id === id)?.slug)
    .filter((slug): slug is string => typeof slug === "string");
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
    foodBrands: ["육회바른연어", "슈프림치킨", "김치말이국수", "통빱삼겹살", "87닭강정", "백남옥만두", "스시/초밥", "통밥", "BHC", "BBQ", "프랭크버거", "이가네떡볶이", "XOXO 핫도그"],
    zones: ["프리미엄석", "테이블석", "익사이팅존", "오렌지석", "레드석", "블루석", "네이비석", "외야석", "휠체어석"],
  },
  {
    id: "suwon",
    name: "수원KT위즈파크",
    city: "경기 수원시",
    teamIds: [3],
    capacity: "18,700",
    image: "🏟️",
    parking: { fee: "승용차 5,000원 (경기 종료 후 3시간 내 정산)", tips: "주차예약제 시행. 홈경기 7일 전 17시부터 예약. 만석공원 공영주차장(도보 20분) 대안" },
    transit: { subway: "인근 지하철역 없음 · 버스 이용 권장", bus: "7-1A, 7-2, 16-2, 19, 25, 27, 62-1, 64, 99, 99-2, 300, 300-1, 310, 777, 900, 2007, 3000, 7770 / 경기일보·한일타운 하차 8401, 8409, 9100" },
    ticketing: { provider: "티켓링크", url: "https://www.ticketlink.co.kr", priceRange: "10,000원(외야)~70,000원(포수뒤테이블) (2026 시즌 기준)" },
    foodBrands: ["꼬마김밥", "타코야끼", "수원통닭", "진미통닭", "보영만두", "BHC", "파파존스", "롯데리아", "이대로통삼겹"],
    zones: ["중앙테이블석", "익사이팅석", "1루 응원지정석", "3루 응원지정석", "내야지정석", "스카이존", "외야잔디존"],
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
    foodBrands: ["크림새우", "물회", "인천 로컬 먹거리", "스타벅스", "BHC", "노브랜드버거", "이마트24", "노랑통닭", "컴포즈커피", "허갈닭강정"],
    zones: ["덕아웃상단석", "1루 응원지정석", "3루 응원지정석", "라이브존", "4층 SKY뷰석", "SKY탁자석", "그린존", "바베큐존", "홈런커플존", "미니스카이박스", "스카이박스", "외야파티덱"],
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
    zones: ["프리미엄석", "프리미엄테이블석", "테이블석", "라운드테이블석", "내야석 1층", "내야석 2층", "내야석 3층", "내야석 4층", "외야석", "외야잔디석", "피크닉석", "가족석", "불펜석", "스카이박스"],
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
    foodBrands: ["챔필 크림새우", "마성떡볶이", "야구공빵", "인크커피", "물회", "이마트24", "파파존스", "광주원샷", "스트릿츄러스"],
    zones: ["K9", "K8", "K5", "EV4", "외야석", "챔피언석", "중앙테이블석", "테이블석", "파티석", "가족석", "외야가족석", "서프라이즈석", "응원특별석", "스카이박스", "휠체어석"],
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
    zones: ["1루내야상단석", "3루내야상단석A", "3루내야상단석B", "중앙상단석", "1루외야석", "3루외야석", "그라운드석", "중앙탁자석", "와이드탁자석", "응원탁자석", "3루프리미엄석", "내야탁자석", "1루내야필드석", "3루내야필드석", "외야글램핑존", "외야탁자석"],
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
    zones: ["VIP석", "중앙테이블석", "3루테이블석", "커플석", "블루존", "SKY블루존", "3루지정석", "중앙지정석", "1루지정석", "익사이팅석", "파티플로어석", "외야테이블석", "외야지정석", "외야자유석", "잔디그린존", "루프탑존", "SKY자유석"],
  },
  {
    id: "daejeon",
    name: "대전 한화생명 볼파크",
    city: "대전 중구",
    teamIds: [9],
    capacity: "17,000",
    image: "🏟️",
    parking: { fee: "구장 지하(B1)·지상 주차장 (입장시간 1시간 전부터 입차)", tips: "경기일 조기 만차 잦음. 대중교통 강력 권장, 인근 공영주차장 병행" },
    transit: { subway: "대전1호선 중구청역 하차 후 택시 10분(1.6km) 또는 513번 버스 환승", bus: "52, 513, 604, 급행4번. KTX 대전역에서 급행4·802번" },
    ticketing: { provider: "티켓링크", url: "https://www.ticketlink.co.kr", priceRange: "5단계 구간요금제, 최대 82,000원(포수후면) (2026 시즌)" },
    foodBrands: ["ML 핫도그", "자담치킨", "BBQ", "반올림피자", "빽보이피자", "한신포차", "백스비어", "공차", "요아정"],
    zones: ["포수후면석", "중앙지정석", "중앙탁자석", "내야지정석A", "내야지정석B", "응원단석", "내야커플석", "내야박스석", "내야탁자석", "덕아웃지정석", "이닝스 VIP", "외야지정석", "잔디석", "스카이박스", "휠체어석"],
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
    foodBrands: ["BHC 뿌링클", "이가네떡볶이", "테이블석 야푸", "맘스터치", "BBQ", "BHC", "멕시카나", "쉬림프셰프", "편밀밀", "올떡볶이"],
    zones: ["다크버건디석", "버건디석", "1층테이블석", "2층테이블석", "골드내야지정석", "골드외야지정석", "스카이블루석", "블루석", "3층지정석", "4층지정석", "외야지정석", "외야비지정석", "내야커플석", "외야커플석", "스카이박스", "휠체어석"],
  },
];
