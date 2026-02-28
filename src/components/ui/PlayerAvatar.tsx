"use client";

import Image from "next/image";
import { TEAMS } from "@/lib/constants/teams";

interface PlayerAvatarProps {
  name: string;
  teamId: number;
  photoUrl?: string | null;
  size?: number;       // px, default 32
  showTeamBadge?: boolean; // default true
  number?: number;
}

export default function PlayerAvatar({
  name,
  teamId,
  photoUrl,
  size = 40,
  showTeamBadge = true,
  number,
}: PlayerAvatarProps) {
  const team = TEAMS.find((t) => t.id === teamId);
  const teamColor = team?.colorPrimary ?? "#888";
  const logoPath = team?.logoPath ?? "";
  const badgeSize = Math.max(12, Math.round(size * 0.4));

  return (
    <div className="relative flex-shrink-0" style={{ width: size, height: size }}>
      {photoUrl ? (
        <Image
          src={photoUrl}
          alt={name}
          width={size}
          height={size}
          unoptimized
          className="rounded-full object-cover"
          style={{ width: size, height: size }}
        />
      ) : (
        <div
          className="flex items-center justify-center rounded-full"
          style={{
            width: size,
            height: size,
            backgroundColor: teamColor + "25",
            border: `2px solid ${teamColor}40`,
          }}
        >
          <span
            className="font-bold leading-none"
            style={{
              color: teamColor,
              fontSize: number != null ? Math.round(size * 0.35) : Math.round(size * 0.4),
            }}
          >
            {number != null ? number : name.charAt(0)}
          </span>
        </div>
      )}
      {showTeamBadge && logoPath && (
        <div
          className="absolute flex items-center justify-center rounded-full bg-white"
          style={{
            width: badgeSize,
            height: badgeSize,
            bottom: -1,
            right: -1,
            padding: 1,
          }}
        >
          <Image
            src={logoPath}
            alt=""
            width={badgeSize - 4}
            height={badgeSize - 4}
            unoptimized
            className="object-contain"
          />
        </div>
      )}
    </div>
  );
}
