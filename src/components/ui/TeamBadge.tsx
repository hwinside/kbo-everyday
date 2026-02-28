import Image from "next/image";
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

  const logoSize = size === "sm" ? 16 : 20;

  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1 rounded-full font-semibold text-white",
        size === "sm" && "py-1 pl-0.5 pr-2.5 text-base",
        size === "md" && "py-1.5 pl-1 pr-3.5 text-base",
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
      {team.shortName}
    </span>
  );
}
