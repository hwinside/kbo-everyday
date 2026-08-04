"use client";

import Image from "next/image";
import { clsx } from "clsx";
import { useEffect, useState } from "react";
import { getTeamById, getTeamBgColor, getTeamBgBorder } from "@/lib/constants/teams";
import { useTheme } from "@/components/ThemeProvider";

interface TeamBadgeProps {
  teamId: number;
  size?: "xs" | "sm" | "md" | "lg";
  className?: string;
  /** 선수 게시판용: "LG 김진성" 형태로 표시 */
  playerName?: string;
  /** 작성자 응원팀처럼 보조 의미를 명시할 때 붙이는 접미사 */
  suffix?: string;
}

export default function TeamBadge({
  teamId,
  size = "sm",
  className,
  playerName,
  suffix,
}: TeamBadgeProps) {
  const team = getTeamById(teamId);
  const { resolvedTheme } = useTheme();
  // SSR 하이드레이션 mismatch 방지: 초기엔 다크 기준으로 렌더,
  // 마운트 후 실제 테마로 스왑. 색상이 잠깐 다크→라이트로 바뀔 수 있으나 FOUC 수준은 themeScript로 충분히 억제됨.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  const theme: "dark" | "light" = mounted ? resolvedTheme : "dark";

  if (!team) return null;

  const logoSize = size === "xs" ? 12 : size === "sm" ? 14 : size === "md" ? 20 : 28;

  const bgColor = getTeamBgColor(team, theme);
  const borderColor = getTeamBgBorder(team, theme);

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
      style={{
        backgroundColor: bgColor,
        ...(borderColor && {
          boxShadow: `inset 0 0 0 1px ${borderColor}`,
        }),
      }}
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
      {playerName ? `${team.shortName} ${playerName}` : `${team.shortName}${suffix ? ` ${suffix}` : ""}`}
    </span>
  );
}
