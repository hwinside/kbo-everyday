import NATIONALITY_BY_KBO_ID from "@/lib/constants/player-nationality.json";

/**
 * 외국인·아시아쿼터 선수 국적 표시.
 *
 * 소스: 단일 API로 국적을 주는 데가 없어, 34명(FP·AQ) 고정 집합을
 *   KBO 공식/나무위키/위키백과 교차확인해 큐레이션한 매핑(player-nationality.json).
 *   국적은 안 바뀌는 값이라 한 번 검증하면 사실상 영구.
 *
 * 유지보수: 로스터에 새 외국인(FP0xx/AQ0xx)이 온보딩되면 player-nationality.json 에
 *   해당 kboId → ISO alpha-2 코드 한 줄만 추가하면 된다. 미등록 시 국적 미표시(graceful).
 *   국기 SVG는 public/flags/{code}.svg (신규 국가면 flag-icons 4x3 에서 추가).
 *
 * ⚠️ 로스터 크롤 JSON(players-roster.json)엔 국적을 넣지 않는다 — 크롤러가 덮어쓸 수 있어
 *   국적은 이 별도 상수파일이 SSOT.
 */

export interface Nationality {
  /** ISO 3166-1 alpha-2 (야구 국적 관례상 푸에르토리코 PR 은 미국과 별도 표기) */
  code: string;
  nameKo: string;
}

const COUNTRY_NAME_KO: Record<string, string> = {
  US: "미국",
  JP: "일본",
  VE: "베네수엘라",
  DO: "도미니카공화국",
  AU: "호주",
  TW: "대만",
  CU: "쿠바",
  PR: "푸에르토리코",
};

const MAP = NATIONALITY_BY_KBO_ID as Record<string, string>;

/** kboId → 국적. 로스터에 국적 매핑이 없으면(내국인 포함) null. */
export function getPlayerNationality(kboId: string | null | undefined): Nationality | null {
  if (!kboId) return null;
  const code = MAP[String(kboId)];
  if (!code) return null;
  const nameKo = COUNTRY_NAME_KO[code];
  if (!nameKo) return null;
  return { code, nameKo };
}

/** 국기 SVG 경로 (public/flags/{code}.svg) */
export function flagSrc(code: string): string {
  return `/flags/${code.toLowerCase()}.svg`;
}
