// KBO 수상 기록
export interface Award {
  year: number;
  type: "golden_glove" | "mvp" | "rookie";
  position: string;
  label: string;
}

// 2025 KBO 골든글러브 수상자 (kboId 기반 + 이름 기반 fallback)
const GOLDEN_GLOVE_2025_BY_ID: Record<string, Award> = {
  "76232": { year: 2025, type: "golden_glove", position: "포수", label: "2025년 포수 부문 골든글러브" },        // 양의지 (두산)
  "54400": { year: 2025, type: "golden_glove", position: "1루수", label: "2025년 1루수 부문 골든글러브" },      // 디아즈 (삼성)
  "65207": { year: 2025, type: "golden_glove", position: "2루수", label: "2025년 2루수 부문 골든글러브" },      // 신민재 (LG)
  "51907": { year: 2025, type: "golden_glove", position: "유격수", label: "2025년 유격수 부문 골든글러브" },    // 김주원 (NC)
  "52001": { year: 2025, type: "golden_glove", position: "외야수", label: "2025년 외야수 부문 골든글러브" },    // 안현민 (KT)
  "62404": { year: 2025, type: "golden_glove", position: "외야수", label: "2025년 외야수 부문 골든글러브" },    // 구자욱 (삼성)
  "72443": { year: 2025, type: "golden_glove", position: "지명타자", label: "2025년 지명타자 부문 골든글러브" }, // 최형우 (KIA→삼성)
};

// 2026 로스터에 없는 선수 (이적/방출) — 이름으로 매칭
const GOLDEN_GLOVE_2025_BY_NAME: Record<string, Award> = {
  "폰세": { year: 2025, type: "golden_glove", position: "투수", label: "2025년 투수 부문 골든글러브" },        // 코디 폰세 (한화)
  "코디 폰세": { year: 2025, type: "golden_glove", position: "투수", label: "2025년 투수 부문 골든글러브" },
  "송성문": { year: 2025, type: "golden_glove", position: "3루수", label: "2025년 3루수 부문 골든글러브" },     // 송성문 (키움)
  "레예스": { year: 2025, type: "golden_glove", position: "외야수", label: "2025년 외야수 부문 골든글러브" },   // 빅토르 레예스 (롯데)
  "빅토르 레예스": { year: 2025, type: "golden_glove", position: "외야수", label: "2025년 외야수 부문 골든글러브" },
};

export function getPlayerAwards(kboId?: string, playerName?: string): Award[] {
  const awards: Award[] = [];

  // kboId 매칭
  if (kboId && GOLDEN_GLOVE_2025_BY_ID[kboId]) {
    awards.push(GOLDEN_GLOVE_2025_BY_ID[kboId]);
  }

  // 이름 매칭 (kboId로 못 찾은 경우)
  if (awards.length === 0 && playerName && GOLDEN_GLOVE_2025_BY_NAME[playerName]) {
    awards.push(GOLDEN_GLOVE_2025_BY_NAME[playerName]);
  }

  return awards;
}
