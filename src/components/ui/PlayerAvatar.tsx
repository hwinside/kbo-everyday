"use client";

import Image from "next/image";
import { TEAMS } from "@/lib/constants/teams";

interface PlayerAvatarProps {
  name: string;
  teamId?: number;
  photoUrl?: string | null;
  size?: number;
  showTeamBadge?: boolean;
  number?: number;
}

export default function PlayerAvatar({
  name,
  teamId,
  photoUrl,
  size = 48,
  showTeamBadge = true,
  number,
}: PlayerAvatarProps) {
  const team = TEAMS.find((t) => t.id === teamId);
  const teamColor = team?.colorPrimary ?? "#888";
  const teamColorLight = team?.colorLight ?? "#aaa";
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
          className="flex items-center justify-center rounded-full overflow-hidden"
          style={{
            width: size,
            height: size,
            background: `linear-gradient(160deg, ${teamColor}30 0%, #1a1a2e 100%)`,
          }}
        >
          <svg
            viewBox="0 0 200 200"
            fill="none"
            style={{ width: size * 0.75, height: size * 0.75, marginTop: size * 0.1 }}
          >
            <circle cx="100" cy="70" r="28" fill={teamColorLight + "90"} />
            <path
              d="M100 108c-30 0-54 16-58 38h116c-4-22-28-38-58-38z"
              fill={teamColorLight + "90"}
            />
          </svg>
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
