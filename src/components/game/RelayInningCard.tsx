"use client";

import { useState } from "react";
import { clsx } from "clsx";
import { ChevronDown } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import type { TeamData } from "@/lib/constants/teams";
import type { FieldingEvent, InningRelay, PlayEvent } from "@/lib/hooks/useGameRelay";
import type { PitchDetail } from "@/lib/game/pitch-provider";

/**
 * relay 이닝별 타석 카드 (실시간 + 종료경기 공용).
 * LiveStatsTab / GameStatsTab이 각자 렌더하던 near-duplicate InningPlays를 하나로 합쳐
 * 타석 pitch-by-pitch 펼쳐보기를 두 화면에서 동일하게 재사용한다(삼순 리뷰: 단일 컴포넌트).
 */

function getPlayStyle(type: PlayEvent["type"]) {
  switch (type) {
    case "homerun":
      return "text-accent font-semibold";
    case "hit":
      return "text-accent";
    case "strikeout":
      return "text-text-tertiary";
    case "walk":
    case "hbp":
      return "text-text-secondary";
    case "error":
      return "text-red-400";
    default:
      return "text-text-secondary";
  }
}

function getPlayEmoji(type: PlayEvent["type"]) {
  if (type === "homerun") return " 🔥";
  if (type === "hit") return " ⚾";
  return "";
}

/** 구질 카테고리 → 배지 색. text 기반 파생(kind)이라 원문 code 의미 불안정과 무관. */
function pitchKindClass(kind: PitchDetail["kind"]): string {
  switch (kind) {
    case "strike":
      return "bg-red-500/15 text-red-400";
    case "ball":
      return "bg-emerald-500/15 text-emerald-400";
    case "foul":
      return "bg-bg-tertiary text-text-tertiary";
    case "inplay":
      return "bg-accent/15 text-accent";
    default:
      return "bg-bg-tertiary text-text-secondary";
  }
}

/** 타석 투구 시퀀스 — 구종·구속·결과 pill. 소스 무관(PitchDetail[]). */
function PitchSequence({ pitches }: { pitches: PitchDetail[] }) {
  return (
    <div className="mt-1 mb-1 ml-5 flex flex-col gap-1">
      {pitches.map((p, i) => (
        <div key={i} className="flex items-center gap-1.5 text-xs">
          <span className="text-text-tertiary w-8 shrink-0 tabular-nums">
            {p.num > 0 ? `${p.num}구` : "-"}
          </span>
          {p.stuff && (
            <span className="text-text-secondary font-medium shrink-0">{p.stuff}</span>
          )}
          {p.speed > 0 && (
            <span className="text-text-tertiary tabular-nums shrink-0">{p.speed}</span>
          )}
          <span
            className={clsx(
              "ml-auto shrink-0 rounded px-1.5 py-0.5 font-medium",
              pitchKindClass(p.kind),
            )}
          >
            {p.resultText}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * 교체 이벤트 라벨 — 들어오는 쪽(inPosKr) 기준. 폐쇄집합(FIELDING_POS_TOKEN)이라 룰로 충분.
 * 수비위치 변경(reposition)은 피드 소음이라 중계 피드에서는 숨긴다(필드뷰 전용 유지).
 */
function substitutionLabel(e: Extract<FieldingEvent, { kind: "replace" }>): string {
  if (e.inPosKr === "투수") return "투수교체";
  if (e.inPosKr === "대타") return "대타";
  if (e.inPosKr === "대주자") return "대주자";
  return "교체";
}

type ReplaceEvent = Extract<FieldingEvent, { kind: "replace" }>;

/**
 * 피드에 노출할 교체 이벤트만 추린다 — replace 이면서 playIndex 가 있는 것만.
 * playIndex 미정의(구버전 응답)는 위치를 복원할 수 없으므로 오배치 대신 생략(fail-safe,
 * 기존 동작과 동일). reposition(수비위치 변경)은 필드뷰 전용으로 유지.
 */
function feedSubstitutions(fielding: FieldingEvent[] | undefined): (ReplaceEvent & { playIndex: number })[] {
  return (fielding ?? []).filter(
    (e): e is ReplaceEvent & { playIndex: number } =>
      e.kind === "replace" && typeof e.playIndex === "number",
  );
}

function substitutionsAt(subs: (ReplaceEvent & { playIndex: number })[], index: number) {
  return subs.filter((e) => e.playIndex === index);
}

/** 타석 사이 교체 인포 행 — "투수교체 · 올러 → 조상우" */
function SubstitutionRow({ event }: { event: Extract<FieldingEvent, { kind: "replace" }> }) {
  const label = substitutionLabel(event);
  return (
    <div
      data-testid="relay-sub-row"
      data-sub-label={label}
      data-sub-in={event.inName}
      className="flex items-center gap-2 py-1 border-b border-border/20"
    >
      <span className="text-text-tertiary text-xs shrink-0 w-3 text-center">⇄</span>
      <span
        className={clsx(
          "text-[10px] font-bold px-1 py-0.5 rounded shrink-0",
          label === "투수교체"
            ? "text-amber-400 bg-amber-400/10"
            : "text-text-secondary bg-bg-tertiary",
        )}
      >
        {label}
      </span>
      <span className="text-xs text-text-secondary">
        {event.outName}
        <span className="text-text-tertiary"> → </span>
        <span className="text-text-primary font-medium">{event.inName}</span>
      </span>
    </div>
  );
}

function PlayRow({ play, isLast }: { play: PlayEvent; isLast: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const hasScoring = play.extras?.some(
    (e) => e.includes("홈까지 진루") || e.includes("득점"),
  );
  const hasPitches = !!play.pitches && play.pitches.length > 0;

  return (
    <div data-testid="relay-play-row" data-play-batter={play.batterName} className={clsx(!isLast && "border-b border-border/20")}>
      <button
        type="button"
        onClick={() => hasPitches && setExpanded((v) => !v)}
        disabled={!hasPitches}
        className={clsx(
          "flex w-full items-start gap-2 py-1.5 text-left",
          hasPitches && "active:opacity-70",
        )}
      >
        <span className="text-text-tertiary text-xs mt-0.5 shrink-0 w-3 text-center">
          {isLast ? "└" : "├"}
        </span>
        <span className="text-sm text-text-primary font-medium shrink-0 min-w-[48px]">
          {play.batterName}
        </span>
        <span className={clsx("text-sm flex-1", getPlayStyle(play.type))}>
          {play.result}
          {getPlayEmoji(play.type)}
        </span>
        {hasScoring && (
          <span className="text-[10px] font-bold text-accent bg-accent/10 px-1 py-0.5 rounded shrink-0 mt-0.5">
            +득점
          </span>
        )}
        {hasPitches && (
          <ChevronDown
            size={14}
            className={clsx(
              "shrink-0 mt-0.5 text-text-tertiary transition-transform",
              expanded && "rotate-180",
            )}
          />
        )}
      </button>
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

export default function RelayInningCard({
  inning,
  awayTeam,
  homeTeam,
  runs,
}: {
  inning: InningRelay;
  awayTeam: TeamData;
  homeTeam: TeamData;
  /**
   * 해당 초/말의 실제 이닝 득점(linescore 기준).
   * undefined/null이면 문구로 추정하지 않고 배지를 숨긴다.
   */
  runs?: number | null;
}) {
  const teamColor = inning.half === "top" ? awayTeam.colorPrimary : homeTeam.colorPrimary;
  const halfLabel = inning.half === "top" ? "초" : "말";
  const substitutions = feedSubstitutions(inning.fielding);
  // 마지막 확정 타석 이후(= 진행 중 타석 중) 교체 — 라이브에서 즉시 노출되는 케이스.
  const trailingSubstitutions = substitutions.filter((e) => e.playIndex >= inning.plays.length);

  return (
    <div className="glass-card overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/30">
        <div className="w-1 h-4 rounded-full shrink-0" style={{ backgroundColor: teamColor }} />
        <span className="text-sm font-semibold text-text-primary">
          {inning.inning}회{halfLabel}
        </span>
        <span className="text-sm font-medium" style={{ color: teamColor }}>
          {inning.teamName}
        </span>
        {runs != null && runs > 0 && (
          <span className="ml-auto text-xs font-bold text-accent bg-accent/10 px-1.5 py-0.5 rounded">
            {runs}점
          </span>
        )}
      </div>
      <div className="px-3 py-1.5">
        {inning.plays.length === 0 && substitutions.length === 0 ? (
          <p className="text-xs text-text-tertiary py-1">기록 없음</p>
        ) : (
          <>
            {inning.plays.map((play, i) => (
              <div key={`${play.batterName}-${i}`}>
                {substitutionsAt(substitutions, i).map((e, j) => (
                  <SubstitutionRow key={`sub-${i}-${j}`} event={e} />
                ))}
                <PlayRow
                  play={play}
                  isLast={i === inning.plays.length - 1 && trailingSubstitutions.length === 0}
                />
              </div>
            ))}
            {trailingSubstitutions.map((e, j) => (
              <SubstitutionRow key={`sub-tail-${j}`} event={e} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}
