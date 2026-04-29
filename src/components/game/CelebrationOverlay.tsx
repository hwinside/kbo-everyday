"use client";

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import confetti from "canvas-confetti";
import Image from "next/image";
import { getTeamById } from "@/lib/constants/teams";

export type CelebrationEventType =
  | "homerun"
  | "triple"
  | "double"
  | "hit"
  | "walk"
  | "strikeout";

export interface CelebrationEvent {
  type: CelebrationEventType;
  teamId: number;
  playerName?: string;
  kboId?: string;
  strikeoutCount?: number;
  /** Stable ID for dedup — assigned by useCelebration */
  id?: string;
}

interface CelebrationOverlayProps {
  event: CelebrationEvent | null;
  onDone: () => void;
}

const isHomerun = (type: CelebrationEventType) => type === "homerun";

/** Light confetti for normal events */
function fireLightConfetti(teamId: number) {
  const team = getTeamById(teamId);
  if (!team) return;
  const colors = [team.colorPrimary, team.colorLight, "#FFFFFF"];
  confetti({ particleCount: 25, angle: 60, spread: 40, origin: { x: 0.1, y: 0.7 }, colors, zIndex: 9999, scalar: 0.8 });
  confetti({ particleCount: 25, angle: 120, spread: 40, origin: { x: 0.9, y: 0.7 }, colors, zIndex: 9999, scalar: 0.8 });
}

/** Epic multi-wave confetti for homerun — delayed to fire after ball impact */
function fireHomerunConfetti(teamId: number) {
  const team = getTeamById(teamId);
  if (!team) return;
  const colors = [team.colorPrimary, team.colorLight, team.colorSecondary, "#FFD700", "#FFFFFF"];

  // Confetti synced to impact moment (HR_IMPACT_AT * 1000 ms)
  const t = HR_IMPACT_AT * 1000;

  setTimeout(() => {
    confetti({ particleCount: 100, angle: 55, spread: 80, origin: { x: 0, y: 0.6 }, colors, zIndex: 9999, scalar: 1.4 });
    confetti({ particleCount: 100, angle: 125, spread: 80, origin: { x: 1, y: 0.6 }, colors, zIndex: 9999, scalar: 1.4 });
  }, t);

  setTimeout(() => {
    confetti({ particleCount: 80, angle: 90, spread: 160, origin: { x: 0.5, y: 0.15 }, colors, zIndex: 9999, scalar: 1.5, gravity: 0.8 });
  }, t + 200);

  setTimeout(() => {
    confetti({ particleCount: 50, angle: 70, spread: 55, origin: { x: 0.15, y: 0.5 }, colors, zIndex: 9999, scalar: 1.1 });
    confetti({ particleCount: 50, angle: 110, spread: 55, origin: { x: 0.85, y: 0.5 }, colors, zIndex: 9999, scalar: 1.1 });
  }, t + 500);

  setTimeout(() => {
    confetti({ particleCount: 60, angle: 90, spread: 180, origin: { x: 0.5, y: 0 }, colors, zIndex: 9999, scalar: 0.9, gravity: 1.2 });
  }, t + 900);
}

function getLabel(event: CelebrationEvent): string {
  switch (event.type) {
    case "homerun": return "홈런!";
    case "triple": return "3루타!";
    case "double": return "2루타!";
    case "hit": return "안타!";
    case "walk": return "볼넷 출루!";
    case "strikeout": {
      const k = event.strikeoutCount ?? 1;
      return k >= 2 ? `${k}K!` : "삼진!";
    }
  }
}

function getDuration(type: CelebrationEventType): number {
  if (isHomerun(type)) return 4500;
  switch (type) {
    case "triple": return 2200;
    case "double": return 2000;
    default: return 1800;
  }
}

// Timing constants for homerun sequence
const HR_FLY_DUR = 0.8;       // ball flight duration
const HR_HOLD_DUR = 0.4;      // ball holds big at center
const HR_IMPACT_AT = HR_FLY_DUR + HR_HOLD_DUR;  // shockwave starts (~1.2s)
const HR_CONTENT_AT = HR_IMPACT_AT + 0.15;       // card appears after shockwave (~1.35s)

/* ===== Homerun-exclusive sub-components ===== */

/** Baseball: launches up from bottom → arcs to center → holds → fades */
function BallImpact({ color }: { color: string }) {
  const total = HR_FLY_DUR + HR_HOLD_DUR + 0.3;
  return (
    <motion.div
      className="absolute z-30 flex items-center justify-center"
      style={{ filter: `drop-shadow(0 0 24px ${color})` }}
      initial={{ y: "50vh", x: "-5vw", scale: 0.6, rotate: 0 }}
      animate={{
        y: ["50vh", "-5vh", "-5vh", "-5vh"],
        x: ["-5vw", "0vw", "0vw", "0vw"],
        scale: [0.6, 1.3, 1.5, 0],
        rotate: [0, -720, -720, -720],
        opacity: [1, 1, 1, 0],
      }}
      transition={{
        duration: total,
        times: [
          0,
          HR_FLY_DUR / total,                    // arrive at top-center
          (HR_FLY_DUR + HR_HOLD_DUR) / total,    // hold end
          1,                                       // fade
        ],
        ease: [
          [0.2, 0.8, 0.2, 1],  // launch up (fast start, decelerate at top)
          [0, 0, 1, 1],         // hold
          [0.4, 0, 1, 1],       // fade out
        ],
      }}
    >
      <span className="text-6xl">⚾</span>
    </motion.div>
  );
}

/** Expanding impact rings at collision point */
function ImpactRing({ color }: { color: string }) {
  return (
    <>
      <motion.div
        initial={{ scale: 0, opacity: 0.9 }}
        animate={{ scale: 7, opacity: 0 }}
        transition={{ delay: HR_IMPACT_AT, duration: 0.9, ease: "easeOut" }}
        className="absolute z-20 w-24 h-24 rounded-full"
        style={{ border: `4px solid ${color}`, boxShadow: `0 0 40px ${color}60` }}
      />
      <motion.div
        initial={{ scale: 0, opacity: 0.7 }}
        animate={{ scale: 5, opacity: 0 }}
        transition={{ delay: HR_IMPACT_AT + 0.1, duration: 0.8, ease: "easeOut" }}
        className="absolute z-20 w-20 h-20 rounded-full"
        style={{ border: `3px solid ${color}90` }}
      />
      <motion.div
        initial={{ scale: 0, opacity: 0.5 }}
        animate={{ scale: 3.5, opacity: 0 }}
        transition={{ delay: HR_IMPACT_AT + 0.2, duration: 0.6, ease: "easeOut" }}
        className="absolute z-20 w-16 h-16 rounded-full"
        style={{ border: `2px solid ${color}60` }}
      />
    </>
  );
}

export default function CelebrationOverlay({ event, onDone }: CelebrationOverlayProps) {
  const timerRef = useRef<ReturnType<typeof setTimeout>>(null);
  // imgError resets on remount (key={event.id} forces new instance per event)
  const [imgError, setImgError] = useState(false);

  useEffect(() => {
    if (!event) return;

    if (isHomerun(event.type)) {
      fireHomerunConfetti(event.teamId);
    } else {
      fireLightConfetti(event.teamId);
    }

    timerRef.current = setTimeout(onDone, getDuration(event.type));
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [event, onDone]);

  const team = event ? getTeamById(event.teamId) : null;
  const hasPlayerPhoto = !!event?.kboId && !imgError;
  const hr = event ? isHomerun(event.type) : false;

  const photoSize = hr ? 160 : 100;
  const logoSize = hr ? 120 : 80;

  // Content delay: after ball impact for HR, immediate for others
  const contentDelay = hr ? HR_CONTENT_AT : 0;

  return (
    <AnimatePresence>
      {event && team && (
        <motion.div
          key={event.id || `${event.type}-${event.playerName}`}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-[9998] pointer-events-none flex flex-col items-center justify-center"
        >
          {/* === HOMERUN EXCLUSIVE SEQUENCE === */}
          {hr && (
            <>
              <BallImpact color={team.colorLight} />
              <ImpactRing color={team.colorLight} />

              {/* White flash at impact moment */}
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: [0, 0.9, 0] }}
                transition={{ delay: HR_IMPACT_AT, duration: 0.35 }}
                className="absolute inset-0 bg-white z-25"
              />

              {/* Screen shake at impact */}
              <motion.div
                animate={{
                  x: [0, -12, 12, -8, 8, -4, 4, 0],
                  y: [0, -6, 6, -4, 4, -2, 2, 0],
                }}
                transition={{ delay: HR_IMPACT_AT, duration: 0.6 }}
                className="absolute inset-0"
              />
            </>
          )}

          {/* === SHARED CONTENT — delay controlled by animation, not state === */}

          {/* Radial glow */}
          <motion.div
            initial={{ opacity: 0, scale: 0.3 }}
            animate={{ opacity: hr ? 0.6 : 0.25, scale: hr ? 2.5 : 1.5 }}
            exit={{ opacity: 0 }}
            transition={{ duration: hr ? 0.6 : 0.5, delay: contentDelay }}
            className="absolute inset-0"
            style={{
              background: hr
                ? `radial-gradient(circle at 50% 45%, ${team.colorLight}70 0%, ${team.colorPrimary}30 35%, transparent 65%)`
                : `radial-gradient(circle at 50% 50%, ${team.colorLight}40 0%, transparent 70%)`,
            }}
          />

          {/* Player photo card or team logo */}
          <motion.div
            initial={{ opacity: 0, scale: hr ? 0.1 : 0.3, y: hr ? 40 : 30 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.8, y: -15 }}
            transition={hr
              ? { type: "spring", stiffness: 180, damping: 13, delay: contentDelay }
              : { type: "spring", stiffness: 220, damping: 20, delay: 0.05 }
            }
            className="relative z-10"
          >
            {hasPlayerPhoto ? (
              <div
                className="relative overflow-hidden"
                style={{
                  width: photoSize,
                  height: photoSize,
                  borderRadius: hr ? 28 : 16,
                  boxShadow: hr
                    ? `0 0 80px ${team.colorLight}80, 0 0 160px ${team.colorPrimary}40, 0 12px 48px rgba(0,0,0,0.6)`
                    : `0 0 30px ${team.colorLight}50, 0 6px 24px rgba(0,0,0,0.4)`,
                  border: hr
                    ? `3px solid ${team.colorLight}`
                    : `2px solid ${team.colorLight}80`,
                }}
              >
                <Image
                  src={`/players/${event.kboId}.jpg`}
                  alt={event.playerName || ""}
                  fill
                  sizes={`${photoSize}px`}
                  className="object-cover"
                  unoptimized
                  onError={() => setImgError(true)}
                />
                {hr && (
                  <motion.div
                    initial={{ opacity: 0.8, scale: 1 }}
                    animate={{ opacity: 0, scale: 2 }}
                    transition={{ duration: 1, delay: contentDelay + 0.2, repeat: 1, ease: "easeOut" }}
                    className="absolute inset-0"
                    style={{ borderRadius: 28, border: `3px solid ${team.colorLight}` }}
                  />
                )}
              </div>
            ) : (
              <div className="relative" style={{ width: logoSize, height: logoSize }}>
                <Image
                  src={team.logoPath}
                  alt={team.name}
                  fill
                  sizes={`${logoSize}px`}
                  className="object-contain"
                  unoptimized
                />
                <div
                  className="absolute inset-0 -z-10 rounded-full blur-3xl"
                  style={{ backgroundColor: team.colorLight, opacity: hr ? 0.7 : 0.4 }}
                />
              </div>
            )}
          </motion.div>

          {/* Label */}
          <motion.div
            initial={{ opacity: 0, y: 20, scale: hr ? 0.5 : 1 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{
              delay: contentDelay + 0.15,
              duration: 0.3,
              type: hr ? "spring" : "tween",
              stiffness: 200,
              damping: 15,
            }}
            className="relative z-10 mt-3 text-center"
          >
            {event.playerName && (
              <p
                className="font-bold text-white drop-shadow-lg"
                style={{ fontSize: hr ? 24 : 16 }}
              >
                {event.playerName}
              </p>
            )}
            <p
              className="font-black tracking-wider drop-shadow-lg"
              style={{
                color: team.colorLight,
                fontSize: hr ? 40 : 20,
                textShadow: hr
                  ? `0 0 30px ${team.colorLight}90, 0 0 60px ${team.colorLight}40`
                  : undefined,
                letterSpacing: hr ? "0.15em" : undefined,
              }}
            >
              {getLabel(event)}
            </p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
