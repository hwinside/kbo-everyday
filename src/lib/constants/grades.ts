/* ===== 예측 등급 시스템 ===== */

export interface Grade {
  id: string;
  name: string;
  emoji: string;
  minPoints: number;
  color: string;
  bgColor: string;
  perks: string[];
}

export const GRADES: Grade[] = [
  { id: "rookie", name: "루키", emoji: "🌱", minPoints: 0, color: "#9CA3AF", bgColor: "#9CA3AF20", perks: ["기본 예측 참여"] },
  { id: "regular", name: "레귤러", emoji: "⚾", minPoints: 300, color: "#60A5FA", bgColor: "#60A5FA20", perks: ["프로필 뱃지", "댓글 이모지"] },
  { id: "allstar", name: "올스타", emoji: "⭐", minPoints: 1000, color: "#FBBF24", bgColor: "#FBBF2420", perks: ["닉네임 컬러", "예측 히스토리 열람"] },
  { id: "mvp", name: "MVP", emoji: "🏆", minPoints: 3000, color: "#F59E0B", bgColor: "#F59E0B20", perks: ["전용 뱃지", "AI훈수 상세 분석", "주간 리포트"] },
  { id: "hof", name: "명예의전당", emoji: "👑", minPoints: 8000, color: "#EF4444", bgColor: "#EF444420", perks: ["골드 닉네임", "명예의전당 등재", "시즌 종합 리포트"] },
];

export function getGradeByPoints(points: number): Grade {
  let grade = GRADES[0];
  for (const g of GRADES) {
    if (points >= g.minPoints) grade = g;
  }
  return grade;
}

export function getNextGrade(points: number): Grade | null {
  for (const g of GRADES) {
    if (points < g.minPoints) return g;
  }
  return null;
}

export function getProgressToNext(points: number): number {
  const current = getGradeByPoints(points);
  const next = getNextGrade(points);
  if (!next) return 100;
  const range = next.minPoints - current.minPoints;
  const progress = points - current.minPoints;
  return Math.min(100, Math.round((progress / range) * 100));
}

/* ===== 포인트 규칙 ===== */
export const POINT_RULES = {
  predict: 5,       // 예측 참여
  correct: 20,      // 적중
  streak3: 10,      // 3연속 적중 보너스
  streak5: 30,      // 5연속 적중 보너스
  streak10: 100,    // 10연속 적중 보너스
  dailyAll: 15,     // 오늘 전 경기 예측 완료
};
