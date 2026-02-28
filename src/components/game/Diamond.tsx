"use client";

import { motion } from "framer-motion";

interface DiamondProps {
  runner1b: boolean;
  runner2b: boolean;
  runner3b: boolean;
  teamColor: string;
}

export default function Diamond({
  runner1b,
  runner2b,
  runner3b,
  teamColor,
}: DiamondProps) {
  const baseSize = 14;
  const emptyColor = "#2C2C2E";
  const glowFilter = "drop-shadow(0 0 6px var(--glow-color))";

  return (
    <svg
      viewBox="0 0 80 70"
      className="w-[72px] h-[63px]"
      aria-label={`주자 상황: 1루 ${runner1b ? "있음" : "없음"}, 2루 ${runner2b ? "있음" : "없음"}, 3루 ${runner3b ? "있음" : "없음"}`}
    >
      <defs>
        <filter id="glow">
          <feGaussianBlur stdDeviation="2" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* Diamond lines */}
      <path
        d="M40 8 L62 35 L40 62 L18 35 Z"
        fill="none"
        stroke="rgba(255,255,255,0.1)"
        strokeWidth="1"
      />

      {/* 2nd base (top) */}
      <motion.rect
        x={40 - baseSize / 2}
        y={8 - baseSize / 2}
        width={baseSize}
        height={baseSize}
        rx={2}
        transform="rotate(45 40 8)"
        fill={runner2b ? teamColor : emptyColor}
        filter={runner2b ? "url(#glow)" : undefined}
        style={{ "--glow-color": teamColor } as React.CSSProperties}
        animate={{
          fill: runner2b ? teamColor : emptyColor,
          scale: runner2b ? [1, 1.15, 1] : 1,
        }}
        transition={{ duration: 0.4, ease: "easeOut" }}
      />

      {/* 3rd base (left) */}
      <motion.rect
        x={18 - baseSize / 2}
        y={35 - baseSize / 2}
        width={baseSize}
        height={baseSize}
        rx={2}
        transform="rotate(45 18 35)"
        fill={runner3b ? teamColor : emptyColor}
        filter={runner3b ? "url(#glow)" : undefined}
        style={{ "--glow-color": teamColor } as React.CSSProperties}
        animate={{
          fill: runner3b ? teamColor : emptyColor,
          scale: runner3b ? [1, 1.15, 1] : 1,
        }}
        transition={{ duration: 0.4, ease: "easeOut" }}
      />

      {/* 1st base (right) */}
      <motion.rect
        x={62 - baseSize / 2}
        y={35 - baseSize / 2}
        width={baseSize}
        height={baseSize}
        rx={2}
        transform="rotate(45 62 35)"
        fill={runner1b ? teamColor : emptyColor}
        filter={runner1b ? "url(#glow)" : undefined}
        style={{ "--glow-color": teamColor } as React.CSSProperties}
        animate={{
          fill: runner1b ? teamColor : emptyColor,
          scale: runner1b ? [1, 1.15, 1] : 1,
        }}
        transition={{ duration: 0.4, ease: "easeOut" }}
      />

      {/* Home plate (bottom) */}
      <path
        d="M40 58 L45 62 L40 66 L35 62 Z"
        fill={emptyColor}
        opacity={0.6}
      />
    </svg>
  );
}
