import { clsx } from "clsx";
import { LEVELS, getLevelForPoints, type LevelData } from "@/lib/constants/levels";

interface LevelBadgeProps {
  level?: number;
  points?: number;
  showTitle?: boolean;
  className?: string;
}

export default function LevelBadge({
  level,
  points,
  showTitle = false,
  className,
}: LevelBadgeProps) {
  let levelData: LevelData;

  if (points !== undefined) {
    levelData = getLevelForPoints(points);
  } else {
    levelData = LEVELS.find((l) => l.level === (level ?? 1)) ?? LEVELS[0];
  }

  return (
    <span className={clsx("inline-flex items-center gap-1 text-sm", className)}>
      <span>{levelData.badge}</span>
      {showTitle && (
        <span style={{ color: levelData.color }} className="font-medium">
          {levelData.title}
        </span>
      )}
      <span className="text-text-secondary">Lv.{levelData.level}</span>
    </span>
  );
}
