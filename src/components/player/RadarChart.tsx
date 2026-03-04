"use client";

interface RadarChartProps {
  stats: { label: string; value: number }[];
  size?: number;
  color?: string;
  teamColor?: string;
}

export default function RadarChart({ stats, size = 220, color = "#E8697F", teamColor }: RadarChartProps) {
  const padding = size * 0.22; // 라벨+숫자 공간 확보
  const cx = size / 2;
  const cy = size / 2;
  const r = (size - padding * 2) / 2;
  const levels = 5;
  const n = stats.length;
  const angleStep = (Math.PI * 2) / n;
  const startAngle = -Math.PI / 2;

  const getPoint = (i: number, pct: number) => {
    const angle = startAngle + angleStep * i;
    return { x: cx + r * pct * Math.cos(angle), y: cy + r * pct * Math.sin(angle) };
  };

  const gridLines = Array.from({ length: levels }, (_, lv) => {
    const pct = (lv + 1) / levels;
    const pts = Array.from({ length: n }, (_, i) => { const p = getPoint(i, pct); return `${p.x},${p.y}`; }).join(" ");
    return <polygon key={lv} points={pts} fill="none" stroke="#333" strokeWidth={0.5} opacity={0.4} />;
  });

  const axes = Array.from({ length: n }, (_, i) => {
    const p = getPoint(i, 1);
    return <line key={i} x1={cx} y1={cy} x2={p.x} y2={p.y} stroke="#333" strokeWidth={0.5} opacity={0.4} />;
  });

  const dataPoints = stats.map((s, i) => {
    const p = getPoint(i, Math.min(s.value, 100) / 100);
    return `${p.x},${p.y}`;
  }).join(" ");

  const fc = teamColor || color;

  return (
    <svg viewBox={`0 0 ${size} ${size}`} width="100%" style={{ maxWidth: size }} className="mx-auto">
      {gridLines}
      {axes}
      <polygon points={dataPoints} fill={fc} fillOpacity={0.2} stroke={fc} strokeWidth={1.5} />
      {stats.map((s, i) => {
        const p = getPoint(i, Math.min(s.value, 100) / 100);
        return <circle key={`d${i}`} cx={p.x} cy={p.y} r={2.5} fill={fc} />;
      })}
      {stats.map((s, i) => {
        const p = getPoint(i, 1.35);
        return (
          <g key={`l${i}`}>
            <text x={p.x} y={p.y - 6} textAnchor="middle" dominantBaseline="central"
              fill="#999" fontSize={11} fontWeight={500}>{s.label}</text>
            <text x={p.x} y={p.y + 8} textAnchor="middle" dominantBaseline="central"
              fill={fc} fontSize={11} fontWeight={700}>{s.value}</text>
          </g>
        );
      })}
    </svg>
  );
}
