export interface LevelData {
  level: number;
  title: string;
  requiredPoints: number;
  badge: string;
  color: string;
}

// 8티어 — 실측 분포(활동 240명, 중앙값 3pt/p90 20/p95 49/p99 182/최고 1027)에
// 백분위로 맞춤. 초반 보상 간격을 좁히고 상위 희소성은 400pt 이후 확보.
// 임계값=삼순, 티어명=하린아빠 (스펙 specs/level-ranking-v1.md §2.1).
// 리더보드명("명예의 전당")과 최상위 티어명(GOAT)은 분리.
export const LEVELS: LevelData[] = [
  { level: 1, title: "루키", requiredPoints: 0, badge: "🟤", color: "#8B6914" },
  { level: 2, title: "레귤러", requiredPoints: 5, badge: "🔵", color: "#007AFF" },
  { level: 3, title: "올스타", requiredPoints: 20, badge: "🟣", color: "#AF52DE" },
  { level: 4, title: "골든글러브", requiredPoints: 50, badge: "🟡", color: "#FFD60A" },
  { level: 5, title: "MVP", requiredPoints: 150, badge: "🔴", color: "#FF453A" },
  { level: 6, title: "영구결번", requiredPoints: 400, badge: "💎", color: "#64D2FF" },
  { level: 7, title: "레전드", requiredPoints: 800, badge: "🟠", color: "#FF9F0A" },
  { level: 8, title: "GOAT", requiredPoints: 1500, badge: "👑", color: "#FFD700" },
];

export function getLevelForPoints(points: number): LevelData {
  for (let i = LEVELS.length - 1; i >= 0; i--) {
    if (points >= LEVELS[i].requiredPoints) {
      return LEVELS[i];
    }
  }
  return LEVELS[0];
}
