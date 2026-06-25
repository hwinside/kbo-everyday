"use client";

import { useEffect, useRef, useState } from "react";
import { toWeeklyTrend, type WeeklyTrendRow } from "@/lib/stats/weekly-trend";

/**
 * 규정 미달 카드 인라인 미니 추이 스파크라인.
 * 투수=주간 ERA / 타자=주간 타율. 선수 개인 게임로그 기반이라 규정 자격과 무관.
 * 화면에 보일 때만 게임로그를 fetch한다(미달 목록 213행 동시 요청 방지, IntersectionObserver).
 * 자리(60×18)는 항상 확보해 레이아웃 시프트를 막는다.
 */
export default function MiniWeeklyTrend({
  playerId,
  isPitcher,
  color,
}: {
  playerId: string;
  isPitcher: boolean;
  color: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  const [series, setSeries] = useState<number[] | null>(null); // null=미로드, []=데이터부족

  useEffect(() => {
    const el = ref.current;
    if (!el || shown) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShown(true);
          io.disconnect();
        }
      },
      { rootMargin: "120px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [shown]);

  useEffect(() => {
    if (!shown || !playerId) return;
    let alive = true;
    const pos = isPitcher ? "투수" : "타자";
    fetch(`/api/player-game-logs?id=${encodeURIComponent(playerId)}&pos=${pos}`)
      .then((r) => (r.ok ? r.json() : { rows: [] }))
      .then((d) => {
        if (!alive) return;
        const rows = (Array.isArray(d.rows) ? d.rows : []) as WeeklyTrendRow[];
        const trend = toWeeklyTrend(rows, isPitcher) as Array<{ era?: number; avg?: number }>;
        const vals = trend.map((t) => (isPitcher ? t.era ?? 0 : t.avg ?? 0));
        setSeries(vals.length >= 2 ? vals : []);
      })
      .catch(() => {
        if (alive) setSeries([]);
      });
    return () => {
      alive = false;
    };
  }, [shown, playerId, isPitcher]);

  const W = 60;
  const H = 18;
  const PAD = 2;

  // 미로드/데이터부족 → 빈 슬롯(자리 확보). 미로드 상태에만 observer ref를 단다.
  if (series === null) return <div ref={ref} className="h-[18px] w-[60px] flex-shrink-0" />;
  if (series.length < 2) return <div className="h-[18px] w-[60px] flex-shrink-0" />;

  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = max - min || 1;
  const yOf = (v: number) => H - PAD - ((v - min) / span) * (H - 2 * PAD);
  const pts = series
    .map((v, i) => `${(PAD + (i * (W - 2 * PAD)) / (series.length - 1)).toFixed(1)},${yOf(v).toFixed(1)}`)
    .join(" ");
  const first = series[0];
  const last = series[series.length - 1];
  // 투수 ERA는 낮을수록, 타자 타율은 높을수록 좋음 → 마지막 점 색으로 추세 방향 표시.
  const improving = isPitcher ? last <= first : last >= first;

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="flex-shrink-0 overflow-visible" aria-hidden>
      <polyline
        points={pts}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.9"
      />
      <circle cx={W - PAD} cy={yOf(last)} r="1.7" fill={improving ? "#22c55e" : "#ef4444"} />
    </svg>
  );
}
