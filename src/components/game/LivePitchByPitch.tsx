"use client";

import { useEffect, useMemo, useRef, useState, type Ref } from "react";
import { clsx } from "clsx";
import type { PitchDetail } from "@/lib/game/pitch-provider";

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

function countLabel(pitch: PitchDetail): string {
  return pitch.count ? `${pitch.count.ball}-${pitch.count.strike}` : "";
}

export function LivePitchList({
  pitches,
  highlightLatest = false,
  latestRowRef,
}: {
  pitches: PitchDetail[];
  highlightLatest?: boolean;
  latestRowRef?: Ref<HTMLDivElement>;
}) {
  return (
    <div className="divide-y divide-border/30">
      {pitches.map((pitch, index) => {
        const latest = highlightLatest && index === pitches.length - 1;
        return (
          <div
            ref={latest ? latestRowRef : undefined}
            key={`${pitch.num}-${index}`}
            data-qa={latest ? "live-pitch-latest" : "live-pitch-row"}
            className={clsx(
              "grid min-h-10 grid-cols-[32px_minmax(0,1fr)_auto_34px] items-center gap-1.5 px-2 text-xs",
              latest && "rounded-lg bg-accent/10 shadow-[inset_2px_0_0_var(--accent)]",
            )}
          >
            <span className={clsx("tabular-nums text-text-tertiary", latest && "text-accent")}>
              {pitch.num > 0 ? `${pitch.num}구` : "-"}
            </span>
            <span className="min-w-0 truncate">
              <span className="font-semibold text-text-primary">{pitch.stuff || "구종 미상"}</span>
              {pitch.speed > 0 && (
                <span className="ml-1.5 tabular-nums text-text-tertiary">
                  {pitch.speed}<span className="ml-0.5 text-[9px]">km/h</span>
                </span>
              )}
            </span>
            <span className={clsx("rounded-md px-1.5 py-1 text-[10px] font-bold", pitchKindClass(pitch.kind))}>
              {pitch.resultText}
            </span>
            <span className={clsx("text-right tabular-nums text-[10px] text-text-tertiary", latest && "font-bold text-accent")}>
              {countLabel(pitch)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function formatUpdatedAge(updatedAt: string | undefined, nowMs: number): string {
  if (!updatedAt) return "갱신 시각 확인 중";
  const updatedMs = Date.parse(updatedAt);
  if (!Number.isFinite(updatedMs)) return "갱신 시각 확인 중";
  const seconds = Math.max(0, Math.floor((nowMs - updatedMs) / 1000));
  if (seconds < 2) return "방금 갱신";
  if (seconds < 60) return `${seconds}초 전 갱신`;
  return `${Math.floor(seconds / 60)}분 전 갱신`;
}

/**
 * 볼카운트 도트 배지 — 야구 전광판식. 채운 개수만큼 색이 들어온다(B 3칸/S 2칸/O 2칸).
 * 한섯아빠 요청: 텍스트 `B0 S2 O1` → 도트 `B ●●○ / S ●○ / O ●○`.
 */
function CountDots({
  label,
  filled,
  total,
  colorClass,
}: {
  label: string;
  filled: number;
  total: number;
  colorClass: string;
}) {
  return (
    <span data-qa={`count-${label.toLowerCase()}`} className="flex items-center gap-1">
      <span className="text-[10px] font-bold text-text-tertiary">{label}</span>
      <span className="flex gap-0.5">
        {Array.from({ length: total }, (_, i) => (
          <span
            key={i}
            data-filled={i < filled}
            className={clsx(
              "h-2 w-2 rounded-full",
              i < filled ? colorClass : "bg-bg-tertiary ring-1 ring-inset ring-border",
            )}
          />
        ))}
      </span>
    </span>
  );
}

export default function CurrentAtBatCard({
  batterName,
  pitcherName,
  pitches,
  balls,
  strikes,
  outs,
  updatedAt,
  scrollOnUpdate = false,
}: {
  batterName: string;
  pitcherName?: string | null;
  pitches: PitchDetail[];
  balls: number;
  strikes: number;
  outs: number;
  updatedAt?: string;
  scrollOnUpdate?: boolean;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const cardRef = useRef<HTMLElement>(null);
  const latestPitchRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (scrollOnUpdate) {
      (latestPitchRef.current ?? cardRef.current)?.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      });
    }
  }, [batterName, pitches.length, scrollOnUpdate]);

  const latestCount = pitches[pitches.length - 1]?.count;
  const count = useMemo(() => ({
    balls: latestCount?.ball ?? balls,
    strikes: latestCount?.strike ?? strikes,
    outs: latestCount?.out ?? outs,
  }), [latestCount, balls, strikes, outs]);

  return (
    <section
      ref={cardRef}
      data-qa="current-at-bat"
      className="mx-3 mb-2 overflow-hidden rounded-2xl border border-accent/30 bg-bg-secondary shadow-sm"
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <span className="shrink-0 rounded-md bg-accent px-1.5 py-1 text-[10px] font-black text-black">
          현재 타석
        </span>
        <span className="min-w-0 truncate text-sm font-bold text-text-primary">{batterName}</span>
        {pitcherName && (
          <>
            <span className="text-[10px] text-text-tertiary">vs</span>
            <span className="min-w-0 truncate text-xs font-semibold text-text-secondary">{pitcherName}</span>
          </>
        )}
        <div data-qa="count-badge" className="ml-auto flex shrink-0 items-center gap-2">
          <CountDots label="B" filled={Math.min(count.balls, 3)} total={3} colorClass="bg-emerald-400" />
          <CountDots label="S" filled={Math.min(count.strikes, 2)} total={2} colorClass="bg-amber-400" />
          <CountDots label="O" filled={Math.min(count.outs, 2)} total={2} colorClass="bg-red-400" />
        </div>
      </div>

      {pitches.length > 0 ? (
        <div className="px-2 py-1">
          <LivePitchList pitches={pitches} highlightLatest latestRowRef={latestPitchRef} />
        </div>
      ) : (
        <p className="px-4 py-4 text-center text-xs text-text-tertiary">
          첫 투구를 기다리고 있어요
        </p>
      )}

      <div className="flex items-center justify-between border-t border-border px-3 py-2 text-[10px] text-text-tertiary">
        <span className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-accent" />
          새 투구가 들어오면 자동 추가
        </span>
        <span data-qa="relay-updated-at">{formatUpdatedAge(updatedAt, nowMs)}</span>
      </div>
    </section>
  );
}
