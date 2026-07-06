"use client";

import { useState } from "react";
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

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

function formatReferenceDate(date: string | null, entry: AnalysisEntry | undefined): string {
  // lastUpdated가 있으면 그 값이 실제 마지막 경기일(휴식일 보정 완료).
  // 없으면 분석 날짜(=표시일)의 하루 전이 경기일.
  const source = entry?.lastUpdated || date;
  if (!source) return "";
  const d = new Date(`${source}T12:00:00`);
  if (isNaN(d.getTime())) return "";
  if (!entry?.lastUpdated && date) {
    d.setDate(d.getDate() - 1);
  }
  return `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAYS[d.getDay()]}) 경기 기준`;
}

// 본문에 남은 시점 부사(어제/오늘)는 표시 단계에서 제거 (과거 생성분/휴식일 복사 대비).
// 경기 날짜는 배지가 책임지므로 도입부뿐 아니라 본문 전체에서 제거한다.
// 조사(은/는/이/가/의/도/만)·문장부호(,)가 붙은 형태도 제거. "오늘날", "어제오늘" 합성어는 보존.
// 뒤 공백은 소비하지 않아 "어제도 오늘은"처럼 연속된 시점어도 모두 제거한다.
function stripTemporal(copy: string): string {
  return copy
    .replace(/(^|\s)(어제|오늘)(은|는|이|가|의|도|만)?(,)?(?=\s|$)/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export default function DailyAnalysisCard({ type, date, analysis, loading }: DailyAnalysisCardProps) {
  const [expanded, setExpanded] = useState(false);

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
  const displayCopy = stripTemporal(entry.copy);
  const isLong = displayCopy.length > 150;

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
      <div className={!expanded && isLong ? "line-clamp-3" : undefined}>
        <p className="text-sm text-text-primary leading-relaxed whitespace-pre-line">
          {displayCopy}
        </p>
      </div>
      {isLong && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-xs text-accent font-medium mt-1.5"
        >
          {expanded ? "접기" : "더보기"}
        </button>
      )}
    </motion.div>
  );
}
