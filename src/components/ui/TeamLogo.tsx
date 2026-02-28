import type { CSSProperties } from "react";
import Image from "next/image";
import { clsx } from "clsx";
import type { TeamData } from "@/lib/constants/teams";

interface TeamLogoProps {
  team: TeamData;
  size?: number;
  className?: string;
  style?: CSSProperties;
}

export default function TeamLogo({ team, size = 40, className, style }: TeamLogoProps) {
  return (
    <div
      className={clsx(
        "flex shrink-0 items-center justify-center rounded-full bg-white p-1",
        className,
      )}
      style={{ width: size, height: size, ...style }}
    >
      <Image
        src={team.logoPath}
        alt={team.name}
        width={size}
        height={size}
        unoptimized
        className="object-contain"
      />
    </div>
  );
}
