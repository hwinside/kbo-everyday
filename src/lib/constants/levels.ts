export interface LevelData {
  level: number;
  title: string;
  requiredPoints: number;
  badge: string;
  color: string;
}

export const LEVELS: LevelData[] = [
  { level: 1, title: "루키", requiredPoints: 0, badge: "🟤", color: "#8B6914" },
  { level: 2, title: "루키", requiredPoints: 30, badge: "🟤", color: "#8B6914" },
  { level: 3, title: "루키", requiredPoints: 70, badge: "🟤", color: "#8B6914" },
  { level: 4, title: "루키", requiredPoints: 120, badge: "🟤", color: "#8B6914" },
  { level: 5, title: "레귤러", requiredPoints: 200, badge: "🔵", color: "#007AFF" },
  { level: 6, title: "레귤러", requiredPoints: 280, badge: "🔵", color: "#007AFF" },
  { level: 7, title: "레귤러", requiredPoints: 360, badge: "🔵", color: "#007AFF" },
  { level: 8, title: "레귤러", requiredPoints: 420, badge: "🔵", color: "#007AFF" },
  { level: 9, title: "레귤러", requiredPoints: 460, badge: "🔵", color: "#007AFF" },
  { level: 10, title: "올스타", requiredPoints: 500, badge: "🟣", color: "#AF52DE" },
  { level: 11, title: "올스타", requiredPoints: 600, badge: "🟣", color: "#AF52DE" },
  { level: 12, title: "올스타", requiredPoints: 700, badge: "🟣", color: "#AF52DE" },
  { level: 13, title: "올스타", requiredPoints: 800, badge: "🟣", color: "#AF52DE" },
  { level: 14, title: "올스타", requiredPoints: 900, badge: "🟣", color: "#AF52DE" },
  { level: 15, title: "골드글러브", requiredPoints: 1000, badge: "🟡", color: "#FFD60A" },
  { level: 16, title: "골드글러브", requiredPoints: 1200, badge: "🟡", color: "#FFD60A" },
  { level: 17, title: "골드글러브", requiredPoints: 1400, badge: "🟡", color: "#FFD60A" },
  { level: 18, title: "골드글러브", requiredPoints: 1600, badge: "🟡", color: "#FFD60A" },
  { level: 19, title: "골드글러브", requiredPoints: 1800, badge: "🟡", color: "#FFD60A" },
  { level: 20, title: "MVP", requiredPoints: 2000, badge: "🔴", color: "#FF453A" },
  { level: 21, title: "MVP", requiredPoints: 2300, badge: "🔴", color: "#FF453A" },
  { level: 22, title: "MVP", requiredPoints: 2600, badge: "🔴", color: "#FF453A" },
  { level: 23, title: "MVP", requiredPoints: 2800, badge: "🔴", color: "#FF453A" },
  { level: 24, title: "MVP", requiredPoints: 3200, badge: "🔴", color: "#FF453A" },
  { level: 25, title: "사이영", requiredPoints: 3500, badge: "💎", color: "#64D2FF" },
  { level: 26, title: "사이영", requiredPoints: 3800, badge: "💎", color: "#64D2FF" },
  { level: 27, title: "사이영", requiredPoints: 4100, badge: "💎", color: "#64D2FF" },
  { level: 28, title: "사이영", requiredPoints: 4400, badge: "💎", color: "#64D2FF" },
  { level: 29, title: "사이영", requiredPoints: 4700, badge: "💎", color: "#64D2FF" },
  { level: 30, title: "명예의전당", requiredPoints: 5000, badge: "👑", color: "#FFD700" },
];

export function getLevelForPoints(points: number): LevelData {
  for (let i = LEVELS.length - 1; i >= 0; i--) {
    if (points >= LEVELS[i].requiredPoints) {
      return LEVELS[i];
    }
  }
  return LEVELS[0];
}
