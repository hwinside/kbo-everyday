"use client";

import { motion, type HTMLMotionProps } from "framer-motion";
import { clsx } from "clsx";

interface GlassCardProps extends HTMLMotionProps<"div"> {
  children: React.ReactNode;
  className?: string;
  pressable?: boolean;
  onClick?: () => void;
}

export default function GlassCard({
  children,
  className,
  pressable = false,
  onClick,
  ...props
}: GlassCardProps) {
  return (
    <motion.div
      className={clsx("glass-card p-5", className)}
      whileTap={pressable ? { scale: 0.97 } : undefined}
      onClick={onClick}
      transition={{ type: "spring", stiffness: 400, damping: 25 }}
      {...props}
    >
      {children}
    </motion.div>
  );
}
