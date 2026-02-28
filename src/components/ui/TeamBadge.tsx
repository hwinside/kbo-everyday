import { clsx } from "clsx";
import { getTeamById } from "@/lib/constants/teams";

interface TeamBadgeProps {
  teamId: number;
  size?: "sm" | "md";
  className?: string;
}

export default function TeamBadge({
  teamId,
  size = "sm",
  className,
}: TeamBadgeProps) {
  const team = getTeamById(teamId);
  if (!team) return null;

  return (
    <span
      className={clsx(
        "inline-flex items-center justify-center rounded-full font-semibold text-white",
        size === "sm" && "px-2 py-0.5 text-[11px]",
        size === "md" && "px-3 py-1 text-xs",
        className,
      )}
      style={{ backgroundColor: team.colorPrimary }}
    >
      {team.shortName}
    </span>
  );
}
