"use client";

import { useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { clsx } from "clsx";
import type { GamePlay } from "@/lib/types";

interface PlayByPlayProps {
  plays: GamePlay[];
  teamColor: string;
}

export default function PlayByPlay({ plays, teamColor }: PlayByPlayProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [plays.length]);

  // Group plays by inning, reverse order (latest inning first)
  const inningGroups = plays.reduce<Record<string, GamePlay[]>>((acc, play) => {
    if (!acc[play.inning]) acc[play.inning] = [];
    acc[play.inning].push(play);
    return acc;
  }, {});

  const sortedInnings = Object.keys(inningGroups).sort((a, b) => {
    const aNum = parseInt(a.replace(/[^0-9]/g, ""));
    const bNum = parseInt(b.replace(/[^0-9]/g, ""));
    if (aNum !== bNum) return bNum - aNum;
    // 말 > 초
    return a.includes("말") ? -1 : 1;
  });

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
      <AnimatePresence mode="popLayout">
        {sortedInnings.map((inning) => (
          <motion.div
            key={inning}
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            {/* Inning header */}
            <div className="flex items-center gap-4 mb-3">
              <div
                className="h-5 px-2 rounded-full text-base font-bold flex items-center text-white"
                style={{ backgroundColor: teamColor }}
              >
                {inning}
              </div>
              <div className="flex-1 h-px bg-border" />
            </div>

            {/* Plays in inning */}
            <div className="space-y-1">
              {inningGroups[inning]
                .sort((a, b) => b.sequence - a.sequence)
                .map((play) => (
                  <motion.div
                    key={play.id}
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.3 }}
                    className={clsx(
                      "flex items-start gap-4 py-1.5 px-2 rounded-lg text-base",
                      play.isHighlight
                        ? "bg-accent-gold/10 border border-accent-gold/20"
                        : "hover:bg-bg-glass"
                    )}
                  >
                    {play.isHighlight && (
                      <span className="text-base shrink-0 mt-0.5">⚾</span>
                    )}
                    <span
                      className={clsx(
                        play.isHighlight
                          ? "text-accent-gold font-semibold"
                          : "text-text-secondary"
                      )}
                    >
                      {play.description}
                    </span>
                  </motion.div>
                ))}
            </div>
          </motion.div>
        ))}
      </AnimatePresence>

      {plays.length === 0 && (
        <div className="flex items-center justify-center h-32 text-text-tertiary text-base">
          아직 문자 중계가 없습니다
        </div>
      )}
    </div>
  );
}
