import { clsx } from "clsx";
import type { PitchDetail } from "@/lib/game/pitch-provider";

/**
 * 타석 투구 시퀀스 렌더 — 구종·구속·투구결과 pill.
 *
 * 기록 탭(RelayInningCard)과 문자중계(RelayPlayLine, KgwanTab)가 공유하는 단일 소스.
 * 소스 무관(PitchDetail[])이라 네이버/스포츠투아이 어느 provider든 그대로 재사용한다.
 * 두 화면이 같은 마크업을 쓰도록 여기 한 곳만 고치면 drift 가 없다(삼순 리뷰: 단일 컴포넌트).
 */

/** 구질 카테고리 → 배지 색. text 기반 파생(kind)이라 원문 code 의미 불안정과 무관. */
export function pitchKindClass(kind: PitchDetail["kind"]): string {
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

/** 볼카운트 배지 (진행 중 타석 헤더용) — B ●●○ / S ●○. count 없으면 렌더 안 함. */
export function CountBadge({ count }: { count?: PitchDetail["count"] }) {
  if (!count) return null;
  const dots = (filled: number, total: number, on: string) =>
    Array.from({ length: total }, (_, i) => (
      <span
        key={i}
        className={clsx("h-2 w-2 rounded-full", i < filled ? on : "bg-bg-tertiary")}
      />
    ));
  return (
    <span className="flex items-center gap-1 shrink-0 tabular-nums">
      <span className="text-[10px] font-semibold text-text-tertiary">B</span>
      <span className="flex gap-0.5">{dots(Math.min(count.ball, 3), 3, "bg-emerald-500")}</span>
      <span className="ml-1 text-[10px] font-semibold text-text-tertiary">S</span>
      <span className="flex gap-0.5">{dots(Math.min(count.strike, 2), 2, "bg-red-500")}</span>
    </span>
  );
}

/** 타석 투구 시퀀스 — 구종·구속·결과 pill. 소스 무관(PitchDetail[]). */
export default function PitchSequence({ pitches }: { pitches: PitchDetail[] }) {
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
            <span className="text-text-tertiary tabular-nums shrink-0">{p.speed}km</span>
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
