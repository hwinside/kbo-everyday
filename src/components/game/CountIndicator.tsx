"use client";

import { motion } from "framer-motion";
import { clsx } from "clsx";

interface CountIndicatorProps {
  balls: number;
  strikes: number;
  outs: number;
  currentBatter: string | null;
  currentPitcher: string | null;
}

function CountDots({
  label,
  count,
  max,
  activeColor,
}: {
  label: string;
  count: number;
  max: number;
  activeColor: string;
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-base font-bold text-text-tertiary w-3">{label}</span>
      <div className="flex gap-0.5">
        {Array.from({ length: max }, (_, i) => (
          <motion.div
            key={i}
            className={clsx("w-2.5 h-2.5 rounded-full")}
            style={{
              backgroundColor: i < count ? activeColor : "#2C2C2E",
            }}
            animate={
              i === count - 1 && count > 0
                ? { scale: [1, 1.3, 1] }
                : { scale: 1 }
            }
            transition={{ duration: 0.3 }}
          />
        ))}
      </div>
    </div>
  );
}

export default function CountIndicator({
  balls,
  strikes,
  outs,
  currentBatter,
  currentPitcher,
}: CountIndicatorProps) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-4">
        <CountDots label="B" count={balls} max={4} activeColor="#30D158" />
        <CountDots label="S" count={strikes} max={3} activeColor="#FFD60A" />
        <CountDots label="O" count={outs} max={3} activeColor="#FF453A" />
      </div>
      {(currentBatter || currentPitcher) && (
        <div className="flex items-center gap-4 text-base">
          {currentPitcher && (
            <span className="text-text-tertiary">
              <span className="text-text-secondary">P</span> {currentPitcher}
            </span>
          )}
          {currentBatter && (
            <span className="text-text-primary font-medium">
              <span className="text-text-secondary">AB</span> {currentBatter}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
