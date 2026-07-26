"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { clsx } from "clsx";
import type { PlayEvent } from "@/app/api/game-relay/route";
import { LivePitchList } from "@/components/game/LivePitchByPitch";

/**
 * 실시간 문자중계 한 타석(플레이) 렌더 — 크관 탭(KgwanTab) 이전/현재 이닝 공용.
 *
 * 폰트 단일 소스: 본문 text-sm(14px), 보조(extras) text-xs(12px).
 * (과거 기록 UI 14px와 통일 — PR: 중계 글자 확대)
 * QA fixture(/qa/relay-font)도 이 컴포넌트를 그대로 사용하므로 마크업 drift가 없다.
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

export default function RelayPlayLine({ play }: { play: PlayEvent }) {
  const [expanded, setExpanded] = useState(false);
  const hasPitches = !!play.pitches?.length;

  return (
    <div data-qa="completed-at-bat" className="border-b border-border/20 last:border-b-0">
      <button
        type="button"
        disabled={!hasPitches}
        onClick={() => hasPitches && setExpanded((value) => !value)}
        className={clsx("flex w-full items-start gap-2 py-2 text-left", hasPitches && "active:opacity-70")}
      >
        <span className="text-xs mt-0.5 w-4 text-center shrink-0">{playEmoji(play.type)}</span>
        <div className="flex-1 min-w-0">
          <p data-qa="relay-body" className="text-sm text-text-primary leading-relaxed">
            <span className="font-semibold">{play.batterName}</span>
            <span className="text-text-secondary ml-1.5">{play.result}</span>
          </p>
          {play.extras && play.extras.length > 0 && (
            <p data-qa="relay-aux" className="text-xs leading-relaxed mt-0.5" style={{ color: "var(--relay-sub-text)" }}>
              └ {play.extras.join(" / ")}
            </p>
          )}
        </div>
        {hasPitches && (
          <span className="mt-0.5 flex shrink-0 items-center gap-1 text-[10px] text-text-tertiary">
            총 {play.pitches!.length}구
            <ChevronDown size={13} className={clsx("transition-transform", expanded && "rotate-180")} />
          </span>
        )}
      </button>
      {expanded && hasPitches && (
        <div className="mb-2 ml-5 rounded-lg bg-bg-secondary px-1">
          <LivePitchList pitches={play.pitches!} />
        </div>
      )}
    </div>
  );
}
