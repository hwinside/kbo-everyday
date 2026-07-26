"use client";

import { useState } from "react";
import { clsx } from "clsx";
import { ChevronDown } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import type { PlayEvent } from "@/app/api/game-relay/route";
import PitchSequence, { CountBadge } from "@/components/game/PitchSequence";

/**
 * 실시간 문자중계 한 타석(플레이) 렌더 — 크관 탭(KgwanTab) 이전/현재 이닝 공용.
 *
 * 폰트 단일 소스: 본문 text-sm(14px), 보조(extras) text-xs(12px).
 * (과거 기록 UI 14px와 통일 — PR: 중계 글자 확대)
 * QA fixture(/qa/relay-font)도 이 컴포넌트를 그대로 사용하므로 마크업 drift가 없다.
 *
 * pitch-by-pitch: play.pitches 가 있으면 타석을 눌러 구종·구속·투구결과를 펼친다
 * (기록 탭 RelayInningCard 와 동일한 PitchSequence 공유). 진행 중 타석(inProgress)은
 * 볼카운트 배지와 함께 자동 펼침(defaultExpanded)으로 라이브 몰입감을 준다.
 */
export function playEmoji(type: PlayEvent["type"]): string {
  switch (type) {
    case "homerun": return "💥";
    case "hit": return "🔵";
    case "walk": return "🟡";
    case "hbp": return "🟡";
    case "strikeout": return "🔴";
    case "out": return "⚪";
    case "sacrifice": return "⚪";
    case "error": return "⚠️";
    default: return "⚾";
  }
}

export default function RelayPlayLine({
  play,
  defaultExpanded = false,
}: {
  play: PlayEvent;
  defaultExpanded?: boolean;
}) {
  const hasPitches = !!play.pitches && play.pitches.length > 0;
  const inProgress = !!play.inProgress;
  // 진행 중 타석은 라이브 몰입을 위해 자동 펼침. 그 외엔 호출부 지정(현재 이닝 최신 타석 등).
  const [expanded, setExpanded] = useState(defaultExpanded || inProgress);
  // 진행 중 타석 볼카운트 = 마지막 투구 시점 스냅샷.
  const liveCount = inProgress ? play.pitches?.[play.pitches.length - 1]?.count : undefined;

  const rowInner = (
    <>
      <span className="text-xs mt-0.5 w-4 text-center shrink-0">{playEmoji(play.type)}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <p data-qa="relay-body" className="text-sm text-text-primary leading-relaxed">
            <span className="font-semibold">{play.batterName}</span>
            {inProgress ? (
              <span className="ml-1.5 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-bold text-accent align-middle">
                타석 진행중
              </span>
            ) : (
              <span className="text-text-secondary ml-1.5">{play.result}</span>
            )}
          </p>
          {inProgress && <span className="ml-auto"><CountBadge count={liveCount} /></span>}
        </div>
        {play.extras && play.extras.length > 0 && (
          <p data-qa="relay-aux" className="text-xs leading-relaxed mt-0.5" style={{ color: "var(--relay-sub-text)" }}>
            └ {play.extras.join(" / ")}
          </p>
        )}
      </div>
      {hasPitches && !inProgress && (
        <ChevronDown
          size={14}
          className={clsx(
            "shrink-0 mt-0.5 text-text-tertiary transition-transform",
            expanded && "rotate-180",
          )}
        />
      )}
    </>
  );

  return (
    <div
      className={clsx(
        inProgress && "rounded-lg border-l-2 border-accent bg-accent/[0.04] pl-2 -ml-2",
      )}
    >
      {hasPitches ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex w-full items-start gap-2 text-left active:opacity-70"
        >
          {rowInner}
        </button>
      ) : (
        <div className="flex items-start gap-2">{rowInner}</div>
      )}
      <AnimatePresence initial={false}>
        {expanded && hasPitches && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="overflow-hidden"
          >
            <PitchSequence pitches={play.pitches!} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
