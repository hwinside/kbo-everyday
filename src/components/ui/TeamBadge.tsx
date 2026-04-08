import Image from "next/image";
import { clsx } from "clsx";
import { getTeamById } from "@/lib/constants/teams";

interface TeamBadgeProps {
  teamId: number;
  size?: "xs" | "sm" | "md" | "lg";
  className?: string;
  /** 선수 게시판용: "LG 김진성" 형태로 표시 */
  playerName?: string;
}

export default function TeamBadge({
  teamId,
  size = "sm",
  className,
  playerName,
}: TeamBadgeProps) {
  const team = getTeamById(teamId);
  if (!team) return null;

  const logoSize = size === "xs" ? 12 : size === "sm" ? 14 : size === "md" ? 20 : 28;

  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1 rounded-full font-semibold text-white whitespace-nowrap shrink-0",
        size === "xs" && "py-0.5 pl-0.5 pr-1.5 text-[10px]",
        size === "sm" && "py-0.5 pl-0.5 pr-2 text-xs",
        size === "md" && "py-1.5 pl-1 pr-3.5 text-base",
        size === "lg" && "py-2 pl-1.5 pr-4 text-lg",
        className,
      )}
      style={{ backgroundColor: team.colorPrimary }}
    >
      <span
        className="inline-flex shrink-0 items-center justify-center rounded-full bg-white"
        style={{ width: logoSize + 4, height: logoSize + 4 }}
      >
        <Image
          src={team.logoPath}
          alt={team.name}
          width={logoSize}
          height={logoSize}
          unoptimized
          className="object-contain"
        />
      </span>
      {playerName ? `${team.shortName} ${playerName}` : team.shortName}
    </span>
  );
}
