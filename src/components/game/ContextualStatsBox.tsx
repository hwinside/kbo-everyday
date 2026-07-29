"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useVisibilityAwareInterval } from "@/lib/hooks/useVisibilityAwareInterval";
import clsx from "clsx";
import type {
  ContextualStatsResponse,
  PairedSplitLine,
  RispPair,
  Side,
  SplitRow,
  VsHandPair,
} from "@/lib/contextual-stats/types";
import { formatPlayerDisplayName } from "@/lib/utils/player-name";
import { formatSplitInline } from "@/lib/contextual-stats/format";

const POLL_INTERVAL_MS = 10_000;

const isKeyboardOpen = () =>
  typeof document !== "undefined" && document.body.classList.contains("kbd-open");

type Props = {
  gameId: string;
  /** 라이브 중인 경기일 때만 polling. final/scheduled은 caller가 mount 안 함 */
  enabled?: boolean;
};

export default function ContextualStatsBox({ gameId, enabled = true }: Props) {
  const [data, setData] = useState<ContextualStatsResponse | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const pollContextualStats = useCallback(async () => {
    // GameChat composer focus(=body.kbd-open) 동안엔 라인 add/remove로 인한
    // 박스 높이 변화가 composer 위쪽 layout을 흔들어 V3 scrollIntoView 앵커가
    // 깨진다. 키보드 내려갈 때까지 데이터 갱신을 보류한다. (PR #126 회귀 핫픽스)
    if (isKeyboardOpen()) return;
    try {
      const res = await fetch(`/api/contextual-stats?gameId=${encodeURIComponent(gameId)}`, {
        cache: "no-store",
      });
      if (!res.ok) {
        if (mountedRef.current && !isKeyboardOpen()) setData(null);
        return;
      }
      const json = (await res.json()) as ContextualStatsResponse;
      if (mountedRef.current && !isKeyboardOpen()) setData(json);
    } catch {
      if (mountedRef.current && !isKeyboardOpen()) setData(null);
    }
  }, [gameId]);

  // 백그라운드 탭은 폴링 정지, 복귀 시 즉시 갱신. gameId 전환 시도 즉시 갱신.
  useVisibilityAwareInterval(pollContextualStats, POLL_INTERVAL_MS, { enabled, resetKey: gameId });

  // 폴링은 skip해도 framer-motion 진행 중인 height: auto↔0 transition은
  // 박스 외곽 높이를 미세하게 흔들 수 있다. body.kbd-open 동안엔 박스 outer
  // 사이즈를 스냅샷으로 락하고 overflow:hidden으로 in-flight transition을
  // 흡수해 composer 위 layout을 완전히 동결한다.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const apply = () => {
      const el = boxRef.current;
      if (!el) return;
      if (document.body.classList.contains("kbd-open")) {
        el.style.height = `${el.offsetHeight}px`;
        el.style.overflow = "hidden";
      } else {
        el.style.height = "";
        el.style.overflow = "";
      }
    };
    const obs = new MutationObserver(apply);
    obs.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);

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
    <div ref={boxRef} data-contextual-stats-box className="border-b border-border bg-bg-secondary px-3 py-2">
      <div className="max-w-[640px] mx-auto rounded-xl bg-bg-tertiary border border-border p-1 flex flex-col gap-0.5">
        <AnimatePresence initial={false}>
          {hasNoHitter && (
            <LineRow key="noHitter" tone="accent">
              <span className="font-bold text-accent">🔥 노히트 진행 ({highlights.noHitter!.value.inning}회)</span>
              <span className="ml-auto text-text-secondary text-xs">수비 팀 H=0</span>
            </LineRow>
          )}

          {hasBasesLoaded && (
            <PairLineRow
              key="basesLoaded"
              badge="만루"
              pair={lines.basesLoaded!.value}
              batterLabel="만루 타율"
              pitcherLabel="만루 피안타율"
            />
          )}

          {hasRisp && (
            <RispPairLineRow key="risp" badge="RISP" pair={lines.risp!.value} />
          )}

          {hasTwoOuts && (
            <PairLineRow
              key="twoOuts"
              badge="2OUT"
              pair={lines.twoOuts!.value}
              batterLabel="2아웃 타율"
              pitcherLabel="2아웃 피안타율"
            />
          )}

          {hasPhBA && (
            <LineRow key="phBA">
              <Badge>PH-BA</Badge>
              <PairColumn>
                <SideRow
                  name={data.context.batterName ?? ""}
                  label="대타 타율"
                  valueNode={lines.phBA!.value.AVG}
                />
              </PairColumn>
            </LineRow>
          )}

          {hasVsHand && (
            <VsHandLineRow key="vsHand" pair={lines.vsHand!.value} />
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

// ===== Pair line components =====

function PairLineRow({
  badge,
  pair,
  batterLabel,
  pitcherLabel,
}: {
  badge: string;
  pair: PairedSplitLine;
  batterLabel: string;
  pitcherLabel: string;
}) {
  return (
    <LineRow>
      <Badge>{badge}</Badge>
      <PairColumn>
        {pair.batter && (
          <SideRow
            name={pair.batter.name}
            label={batterLabel}
            valueNode={<SplitValueInline row={pair.batter.row} />}
          />
        )}
        {pair.pitcher && (
          <SideRow
            name={pair.pitcher.name}
            label={pitcherLabel}
            valueNode={<SplitValueInline row={pair.pitcher.row} isPitcher />}
          />
        )}
      </PairColumn>
    </LineRow>
  );
}

function RispPairLineRow({ badge, pair }: { badge: string; pair: RispPair }) {
  return (
    <LineRow>
      <Badge>{badge}</Badge>
      <PairColumn>
        {pair.batter && (
          <SideRow
            name={pair.batter.name}
            label="득점권 타율"
            valueNode={
              <>
                {pair.batter.AVG}
                <small className="ml-1 text-text-tertiary font-normal text-[11px]">
                  {pair.batter.AB}타수
                </small>
              </>
            }
          />
        )}
        {pair.pitcher && (
          <SideRow
            name={pair.pitcher.name}
            label="RISP 피안타율"
            valueNode={
              <>
                {pair.pitcher.AVG}
                <small className="ml-1 text-text-tertiary font-normal text-[11px]">
                  {pair.pitcher.AB}타수
                </small>
              </>
            }
          />
        )}
      </PairColumn>
    </LineRow>
  );
}

function VsHandLineRow({ pair }: { pair: VsHandPair }) {
  return (
    <LineRow>
      <Badge>HAND</Badge>
      <PairColumn>
        {pair.batter && (
          <SideRow
            name={pair.batter.name}
            label={`vs ${sideLabel(pair.batter.opponentSide)}투수 타율`}
            valueNode={<SplitValueInline row={pair.batter.row} />}
          />
        )}
        {pair.pitcher && (
          <SideRow
            name={pair.pitcher.name}
            label={`${sideLabel(pair.pitcher.opponentSide)}타 피안타율`}
            valueNode={<SplitValueInline row={pair.pitcher.row} isPitcher />}
          />
        )}
      </PairColumn>
    </LineRow>
  );
}

function sideLabel(side: Side): "좌" | "우" {
  return side === "left" ? "좌" : "우";
}

function PairColumn({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col gap-0.5 flex-1 min-w-0">{children}</div>;
}

function SideRow({
  name,
  label,
  valueNode,
}: {
  name: string;
  label: string;
  valueNode: React.ReactNode;
}) {
  const displayName = formatPlayerDisplayName(name);
  return (
    <div className="flex items-center gap-2">
      <span className="text-text-secondary text-[12px] font-medium flex-1 min-w-0 truncate">
        {displayName ? (
          <>
            <span className="text-text-primary font-bold">{displayName}</span> {label}
          </>
        ) : (
          label
        )}
      </span>
      <span className="ml-auto text-text-primary font-semibold tabular-nums whitespace-nowrap text-[13px]">
        {valueNode}
      </span>
    </div>
  );
}

// ===== Shared primitives =====

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
    <span className="inline-flex shrink-0 self-start mt-0.5 px-1.5 py-0.5 rounded-md bg-white/5 border border-border text-[10px] text-text-tertiary font-semibold tracking-wider">
      {children}
    </span>
  );
}

function SplitValueInline({
  row,
  isPitcher = false,
}: {
  row: SplitRow;
  isPitcher?: boolean;
}) {
  return (
    <>
      {row.AVG}
      <small className="ml-1 text-text-tertiary font-normal text-[11px]">
        {formatSplitInline(row, isPitcher)}
      </small>
    </>
  );
}
