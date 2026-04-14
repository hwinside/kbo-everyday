"use client";

import { motion } from "framer-motion";

interface AnalysisEntry {
  copy: string | null;
  lastUpdated?: string;
}

interface DailyAnalysisCardProps {
  type: "standings" | "batter_titles" | "pitcher_titles";
  date: string | null;
  analysis: Record<string, AnalysisEntry> | null;
  loading?: boolean;
}

function formatReferenceDate(date: string | null, entry: AnalysisEntry | undefined): string {
  const source = entry?.lastUpdated || date;
  if (!source) return "";
  const d = new Date(source);
  if (isNaN(d.getTime())) return "";
  if (!entry?.lastUpdated && date) {
    d.setDate(d.getDate() - 1);
  }
  return `${d.getMonth() + 1}/${d.getDate()} 경기 기준`;
}

export default function DailyAnalysisCard({ type, date, analysis, loading }: DailyAnalysisCardProps) {
  if (loading) {
    return (
      <div className="glass-card p-4 mt-3 space-y-2">
        <div className="flex items-center gap-2">
          <div className="h-4 w-4 rounded bg-bg-tertiary animate-pulse" />
          <div className="h-4 w-16 rounded bg-bg-tertiary animate-pulse" />
        </div>
        <div className="h-4 w-full rounded bg-bg-tertiary animate-pulse" />
        <div className="h-4 w-3/4 rounded bg-bg-tertiary animate-pulse" />
      </div>
    );
  }

  if (!analysis) return null;

  const entry = analysis[type];
  if (!entry?.copy) return null;

  const refDate = formatReferenceDate(date, entry);

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.1 }}
      className="glass-card p-4 mt-3"
    >
      <div className="flex items-center gap-2 mb-2">
        <span className="text-base">✨</span>
        <span className="text-xs font-semibold text-text-secondary">AI 분석</span>
        {refDate && (
          <span className="text-xs text-text-tertiary ml-auto">{refDate}</span>
        )}
      </div>
      <p className="text-sm text-text-primary leading-relaxed whitespace-pre-line">
        {entry.copy}
      </p>
    </motion.div>
  );
}
