/**
 * 엠팍(MLBPARK) 게시판 태그 → KBO team_id 매핑.
 *
 * 엠팍 KBO 게시판 글의 태그/제목에는 팀이 다양한 별칭으로 등장한다:
 *   - 공식 약자: "LG", "KT", "SSG", "NC", "KIA"
 *   - 한글 음차: "엘지", "케이티", "에스에스지", "엔씨", "기아"
 *   - 닉네임: "트윈스", "베어스", "위즈", "랜더스", "다이노스",
 *           "타이거즈", "자이언츠", "라이온즈", "이글스", "히어로즈"
 *   - 풀네임: "LG트윈스", "두산베어스" ...
 *
 * 신규 별칭은 운영 중 발견되는 대로 ALIAS_MAP에 추가한다.
 */

export const ALIAS_MAP: Record<string, number> = {
  // LG (1)
  "lg": 1, "엘지": 1, "lg트윈스": 1, "트윈스": 1,
  // 두산 (2)
  "두산": 2, "두산베어스": 2, "베어스": 2,
  // KT (3)
  "kt": 3, "케이티": 3, "kt위즈": 3, "위즈": 3,
  // SSG (4)
  "ssg": 4, "에스에스지": 4, "ssg랜더스": 4, "랜더스": 4,
  // NC (5)
  "nc": 5, "엔씨": 5, "nc다이노스": 5, "다이노스": 5,
  // KIA (6)
  "kia": 6, "기아": 6, "kia타이거즈": 6, "타이거즈": 6,
  // 롯데 (7)
  "롯데": 7, "롯데자이언츠": 7, "자이언츠": 7,
  // 삼성 (8)
  "삼성": 8, "삼성라이온즈": 8, "라이온즈": 8,
  // 한화 (9)
  "한화": 9, "한화이글스": 9, "이글스": 9,
  // 키움 (10)
  "키움": 10, "키움히어로즈": 10, "히어로즈": 10,
};

export function normalizeTag(tag: string): string {
  return tag.replace(/^#/, "").replace(/\s+/g, "").toLowerCase();
}

export interface TeamTagResolution {
  /** 매칭된 team_id 목록 (중복 제거). */
  teamIds: number[];
  /** 2개 이상의 서로 다른 팀에 매칭됐는지 (모호 여부). */
  ambiguous: boolean;
}

export function resolveTeamFromTags(tags: string[]): TeamTagResolution {
  const found = new Set<number>();
  for (const tag of tags) {
    const id = ALIAS_MAP[normalizeTag(tag)];
    if (id) found.add(id);
  }
  const teamIds = [...found];
  return { teamIds, ambiguous: teamIds.length > 1 };
}
