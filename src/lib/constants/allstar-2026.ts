/**
 * 2026 KBO 올스타전 확정 엔트리 (KBO 공식 발표 — 크보라이브 2026-06-29).
 * 베스트12(팬 70%+선수단 30% 투표) + 감독 추천 13명 = 팀당 25명, 총 50명.
 *
 * kboId는 로스터(players-roster.json) 기준 name+원소속팀으로 전수 resolve해
 * 하드코딩(동명이인 이승민/최원준 포함 50명 전원 검증, 실패 0). 라인업 탭
 * 엔트리 명단 노출·올스타 라인업 팀명 병기의 SSOT.
 */

export interface AllStarEntry {
  name: string;
  /** 원소속 구단 teamId (정규 10구단) */
  teamId: number;
  /** 로스터 canonical kboId */
  kboId: string;
  group: "투수" | "포수" | "내야수" | "외야수" | "지명타자";
  best12?: boolean;
}

export const ALLSTAR_2026_NANUM_ENTRY: AllStarEntry[] = [
  { name: "올러", teamId: 6, kboId: "55633", group: "투수", best12: true },
  { name: "정해영", teamId: 6, kboId: "50662", group: "투수", best12: true },
  { name: "성영탁", teamId: 6, kboId: "54610", group: "투수", best12: true },
  { name: "허인서", teamId: 9, kboId: "52764", group: "포수", best12: true },
  { name: "오스틴", teamId: 1, kboId: "53123", group: "내야수", best12: true },
  { name: "박민우", teamId: 5, kboId: "62907", group: "내야수", best12: true },
  { name: "김도영", teamId: 6, kboId: "52605", group: "내야수", best12: true },
  { name: "김주원", teamId: 5, kboId: "51907", group: "내야수", best12: true },
  { name: "박해민", teamId: 1, kboId: "62415", group: "외야수", best12: true },
  { name: "문현빈", teamId: 9, kboId: "53764", group: "외야수", best12: true },
  { name: "박재현", teamId: 6, kboId: "55636", group: "외야수", best12: true },
  { name: "강백호", teamId: 9, kboId: "68050", group: "지명타자", best12: true },
  { name: "우강훈", teamId: 1, kboId: "51526", group: "투수" },
  { name: "류현진", teamId: 9, kboId: "76715", group: "투수" },
  { name: "류진욱", teamId: 5, kboId: "65949", group: "투수" },
  { name: "전사민", teamId: 5, kboId: "69969", group: "투수" },
  { name: "박준현", teamId: 10, kboId: "56318", group: "투수" },
  { name: "안우진", teamId: 10, kboId: "68341", group: "투수" },
  { name: "유토", teamId: 10, kboId: "AQ010", group: "투수" },
  { name: "한준수", teamId: 6, kboId: "68646", group: "포수" },
  { name: "김건희", teamId: 10, kboId: "53312", group: "포수" },
  { name: "구본혁", teamId: 1, kboId: "69100", group: "내야수" },
  { name: "이도윤", teamId: 9, kboId: "65703", group: "내야수" },
  { name: "문성주", teamId: 1, kboId: "68119", group: "외야수" },
  { name: "송찬의", teamId: 1, kboId: "68110", group: "외야수" },
];

export const ALLSTAR_2026_DREAM_ENTRY: AllStarEntry[] = [
  { name: "곽빈", teamId: 2, kboId: "68220", group: "투수", best12: true },
  { name: "이승민", teamId: 8, kboId: "50464", group: "투수", best12: true },
  { name: "이영하", teamId: 2, kboId: "66291", group: "투수", best12: true },
  { name: "양의지", teamId: 2, kboId: "76232", group: "포수", best12: true },
  { name: "디아즈", teamId: 8, kboId: "FP006", group: "내야수", best12: true },
  { name: "박준순", teamId: 2, kboId: "55252", group: "내야수", best12: true },
  { name: "최정", teamId: 4, kboId: "75847", group: "내야수", best12: true },
  { name: "박찬호", teamId: 2, kboId: "64646", group: "내야수", best12: true },
  { name: "구자욱", teamId: 8, kboId: "62404", group: "외야수", best12: true },
  { name: "정수빈", teamId: 2, kboId: "79231", group: "외야수", best12: true },
  { name: "최원준", teamId: 3, kboId: "66606", group: "외야수", best12: true },
  { name: "최형우", teamId: 8, kboId: "72443", group: "지명타자", best12: true },
  { name: "김건우", teamId: 4, kboId: "51867", group: "투수" },
  { name: "장찬희", teamId: 8, kboId: "56460", group: "투수" },
  { name: "손동현", teamId: 3, kboId: "69041", group: "투수" },
  { name: "전용주", teamId: 3, kboId: "69047", group: "투수" },
  { name: "김진욱", teamId: 7, kboId: "51516", group: "투수" },
  { name: "박정민", teamId: 7, kboId: "56536", group: "투수" },
  { name: "현도훈", teamId: 7, kboId: "68260", group: "투수" },
  { name: "조형우", teamId: 4, kboId: "51865", group: "포수" },
  { name: "김도환", teamId: 8, kboId: "69442", group: "포수" },
  { name: "정준재", teamId: 4, kboId: "54812", group: "내야수" },
  { name: "허경민", teamId: 3, kboId: "79240", group: "내야수" },
  { name: "오태곤", teamId: 4, kboId: "60558", group: "외야수" },
  { name: "황성빈", teamId: 7, kboId: "50500", group: "외야수" },
];

const BY_NAME = new Map<string, AllStarEntry>(
  [...ALLSTAR_2026_NANUM_ENTRY, ...ALLSTAR_2026_DREAM_ENTRY].map((e) => [e.name, e]),
);

/** 올스타 참가선수 이름(발표명 표기) → 엔트리(원소속 teamId·kboId). 미참가/미매칭이면 undefined. */
export function findAllStarEntryByName(name: string): AllStarEntry | undefined {
  return BY_NAME.get(name.trim());
}

// 2026 올스타 리그 구성 — 정규 구단 teamId → 올스타 사이드. 팬 분위기 게이지 등
// "이 유저(구단 팬)는 나눔/드림 어느 쪽인가" 판정용 (홈 경기카드 소속로고와 동일 구성).
const NANUM_MEMBER_TEAM_IDS = new Set([1, 6, 9, 5, 10]); // LG·KIA·한화·NC·키움
const DREAM_MEMBER_TEAM_IDS = new Set([2, 8, 4, 3, 7]); // 두산·삼성·SSG·KT·롯데

/** 정규 구단 teamId → 소속 올스타 teamId(나눔 101/드림 102). 매핑 밖(null/올스타 id 등)은 undefined. */
export function allStarSideOfTeam(teamId: number | null | undefined): number | undefined {
  if (teamId == null) return undefined;
  if (NANUM_MEMBER_TEAM_IDS.has(teamId)) return 101;
  if (DREAM_MEMBER_TEAM_IDS.has(teamId)) return 102;
  return undefined;
}
