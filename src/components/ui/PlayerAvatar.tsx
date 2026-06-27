"use client";

import Image from "next/image";
import { useState, useCallback } from "react";
import { TEAMS } from "@/lib/constants/teams";
import { getPlayerPhotoUrl } from "@/lib/constants/player-photos";

interface PlayerAvatarProps {
  name: string;
  teamId?: number;
  kboId?: string;
  photoUrl?: string | null;
  size?: number;
  showTeamBadge?: boolean;
  number?: number;
}

export default function PlayerAvatar({
  name,
  teamId,
  kboId,
  photoUrl,
  size = 48,
  showTeamBadge = true,
}: PlayerAvatarProps) {
  const team = TEAMS.find((t) => t.id === teamId);
  const teamColor = team?.colorPrimary ?? "#888";
  const teamColorLight = team?.colorLight ?? "#aaa";
  const logoPath = team?.logoPath ?? "";
  const badgeSize = Math.max(12, Math.round(size * 0.4));

  const localPhotoUrl = getPlayerPhotoUrl(name, kboId, teamId);
  const primaryPhotoUrl = photoUrl ?? localPhotoUrl;
  const [failedPrimarySrc, setFailedPrimarySrc] = useState<string | null>(null);
  const [failedLocalSrc, setFailedLocalSrc] = useState<string | null>(null);
  const imgSrc =
    primaryPhotoUrl && failedPrimarySrc !== primaryPhotoUrl
      ? primaryPhotoUrl
      : localPhotoUrl && failedLocalSrc !== localPhotoUrl
        ? localPhotoUrl
        : null;

  const handleError = useCallback(() => {
    if (imgSrc && imgSrc === primaryPhotoUrl && localPhotoUrl && localPhotoUrl !== primaryPhotoUrl) {
      // CDN 실패 → 로컬 fallback
      setFailedPrimarySrc(primaryPhotoUrl);
      return;
    }
    // 로컬도 실패 → 이니셜 표시
    if (imgSrc) setFailedLocalSrc(imgSrc);
  }, [imgSrc, primaryPhotoUrl, localPhotoUrl]);

  return (
    <div className="relative flex-shrink-0" style={{ width: size, height: size }}>
      {imgSrc ? (
        <Image
          src={imgSrc}
          alt={name}
          width={size}
          height={size}
          unoptimized
          className="rounded-full object-cover ring-1 ring-white/10"
          style={{ width: size, height: size }}
          onError={handleError}
        />
      ) : (
        <div
          className="flex items-center justify-center rounded-full overflow-hidden ring-1 ring-white/10"
          style={{
            width: size,
            height: size,
            background: `linear-gradient(160deg, ${teamColor}30 0%, #1a1a2e 100%)`,
          }}
        >
          {/* Silhouette behind initial */}
          <svg
            viewBox="0 0 200 200"
            fill="none"
            className="absolute"
            style={{ width: size * 0.65, height: size * 0.65, marginTop: size * 0.15, opacity: 0.35 }}
          >
            <circle cx="100" cy="70" r="28" fill={teamColorLight} />
            <path
              d="M100 108c-30 0-54 16-58 38h116c-4-22-28-38-58-38z"
              fill={teamColorLight}
            />
          </svg>
          {/* Initial letter */}
          <span
            className="relative font-bold"
            style={{
              fontSize: size * 0.38,
              color: teamColorLight,
              textShadow: `0 0 8px ${teamColor}60`,
            }}
          >
            {name.charAt(0)}
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
