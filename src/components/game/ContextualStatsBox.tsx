"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import clsx from "clsx";
import type { ContextualStatsResponse, SplitRow } from "@/lib/contextual-stats/types";

const POLL_INTERVAL_MS = 10_000;

type Props = {
  gameId: string;
  /** 라이브 중인 경기일 때만 polling. final/scheduled은 caller가 mount 안 함 */
  enabled?: boolean;
};

export default function ContextualStatsBox({ gameId, enabled = true }: Props) {
  const [data, setData] = useState<ContextualStatsResponse | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const fetchOnce = async () => {
      try {
        const res = await fetch(`/api/contextual-stats?gameId=${encodeURIComponent(gameId)}`, {
          cache: "no-store",
        });
        if (!res.ok) {
          if (!cancelled) setData(null);
          return;
        }
        const json = (await res.json()) as ContextualStatsResponse;
        if (!cancelled) setData(json);
      } catch {
        if (!cancelled) setData(null);
      }
    };

    const loop = async () => {
      await fetchOnce();
      if (cancelled) return;
      timer = setTimeout(loop, POLL_INTERVAL_MS);
    };

    void loop();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [gameId, enabled]);

  if (!enabled || !data || data.empty) return null;

  const { lines, highlights } = data;
  const hasNoHitter = !!highlights.noHitter;
  const hasVsHand = !!lines.vsHand;
  const hasBasesLoaded = !!lines.basesLoaded;
  const hasRisp = !!lines.risp;
  const hasTwoOuts = !!lines.twoOuts;
  const hasPhBA = !!lines.phBA;

  const anyLine =
    hasNoHitter || hasVsHand || hasBasesLoaded || hasRisp || hasTwoOuts || hasPhBA;
  if (!anyLine) return null;

  return (
    <div className="border-b border-border bg-bg-secondary px-3 py-2">
      <div className="max-w-[640px] mx-auto rounded-xl bg-bg-tertiary border border-border p-1 flex flex-col gap-0.5">
        <AnimatePresence initial={false}>
          {hasNoHitter && (
            <LineRow key="noHitter" tone="accent">
              <span className="font-bold text-accent">🔥 노히트 진행 ({highlights.noHitter!.value.inning}회)</span>
              <span className="ml-auto text-text-secondary text-xs">수비 팀 H=0</span>
            </LineRow>
          )}

          {hasBasesLoaded && (
            <LineRow key="basesLoaded">
              <Badge>만루</Badge>
              <LabelText>만루 타율</LabelText>
              <SplitValue row={lines.basesLoaded!.value.row} />
            </LineRow>
          )}

          {hasRisp && (
            <LineRow key="risp">
              <Badge>RISP</Badge>
              <LabelText>득점권 타율</LabelText>
              <ValueText>
                {lines.risp!.value.AVG}
                <small className="ml-1 text-text-tertiary font-normal text-[11px]">
                  AB {lines.risp!.value.AB}
                </small>
              </ValueText>
            </LineRow>
          )}

          {hasTwoOuts && (
            <LineRow key="twoOuts">
              <Badge>2OUT</Badge>
              <LabelText>2아웃 타율</LabelText>
              <SplitValue row={lines.twoOuts!.value.row} />
            </LineRow>
          )}

          {hasPhBA && (
            <LineRow key="phBA">
              <Badge>PH-BA</Badge>
              <LabelText>대타 타율</LabelText>
              <ValueText>{lines.phBA!.value.AVG}</ValueText>
            </LineRow>
          )}

          {hasVsHand && (
            <LineRow key="vsHand">
              <Badge>{lines.vsHand!.value.opponentSide === "left" ? "vs L" : "vs R"}</Badge>
              <LabelText>
                {lines.vsHand!.value.opponentSide === "left" ? "좌타" : "우타"} 피안타율
              </LabelText>
              <SplitValue row={lines.vsHand!.value.row} />
            </LineRow>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function LineRow({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "accent";
}) {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.18 }}
      className={clsx(
        "flex items-center gap-2 px-2.5 py-2 rounded-lg text-[13px] leading-tight",
        tone === "accent" && "bg-accent/15 border border-accent/30",
      )}
    >
      {children}
    </motion.div>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex px-1.5 py-0.5 rounded-md bg-white/5 border border-border text-[10px] text-text-tertiary font-semibold tracking-wider">
      {children}
    </span>
  );
}

function LabelText({ children }: { children: React.ReactNode }) {
  return <span className="text-text-secondary text-[12px] font-medium">{children}</span>;
}

function ValueText({ children }: { children: React.ReactNode }) {
  return (
    <span className="ml-auto text-text-primary font-semibold tabular-nums">{children}</span>
  );
}

function SplitValue({ row }: { row: SplitRow }) {
  return (
    <ValueText>
      {row.AVG}
      <small className="ml-1 text-text-tertiary font-normal text-[11px]">
        {row.AB}타수 {row.H}안타{row.HR > 0 ? ` (${row.HR}HR)` : ""}
      </small>
    </ValueText>
  );
}
