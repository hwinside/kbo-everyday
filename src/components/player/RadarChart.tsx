"use client";

interface RadarChartProps {
  stats: { label: string; value: number; max?: number }[];  // value: 0~100
  size?: number;
  color?: string;
  teamColor?: string;
}

export default function RadarChart({ stats, size = 200, color = "#E8697F", teamColor }: RadarChartProps) {
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.38;
  const levels = 5;
  const n = stats.length;
  const angleStep = (Math.PI * 2) / n;
  const startAngle = -Math.PI / 2; // 12시 방향 시작

  const getPoint = (i: number, pct: number) => {
    const angle = startAngle + angleStep * i;
    return {
      x: cx + r * pct * Math.cos(angle),
      y: cy + r * pct * Math.sin(angle),
    };
  };

  // 배경 격자
  const gridLines = [];
  for (let lv = 1; lv <= levels; lv++) {
    const pct = lv / levels;
    const points = Array.from({ length: n }, (_, i) => {
      const p = getPoint(i, pct);
      return `${p.x},${p.y}`;
    }).join(" ");
    gridLines.push(
      <polygon key={lv} points={points} fill="none" stroke="#333" strokeWidth={0.5} opacity={0.5} />
    );
  }

  // 축선
  const axes = Array.from({ length: n }, (_, i) => {
    const p = getPoint(i, 1);
    return <line key={i} x1={cx} y1={cy} x2={p.x} y2={p.y} stroke="#333" strokeWidth={0.5} opacity={0.5} />;
  });

  // 데이터 폴리곤
  const dataPoints = stats.map((s, i) => {
    const pct = Math.min(s.value, 100) / 100;
    const p = getPoint(i, pct);
    return `${p.x},${p.y}`;
  }).join(" ");

  // 라벨
  const labels = stats.map((s, i) => {
    const p = getPoint(i, 1.32);
    return (
      <text key={i} x={p.x} y={p.y} textAnchor="middle" dominantBaseline="central"
        fill="#ccc" fontSize={size * 0.055} fontWeight={500}>
        {s.label}
      </text>
    );
  });

  // 수치
  const values = stats.map((s, i) => {
    const p = getPoint(i, 1.18);
    return (
      <text key={`v${i}`} x={p.x} y={p.y + size * 0.065} textAnchor="middle" dominantBaseline="central"
        fill={teamColor || color} fontSize={size * 0.05} fontWeight={700}>
        {s.value}
      </text>
    );
  });

  const fillColor = teamColor || color;

  return (
    <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} className="mx-auto">
      {gridLines}
      {axes}
      <polygon points={dataPoints} fill={fillColor} fillOpacity={0.2} stroke={fillColor} strokeWidth={1.5} />
      {stats.map((s, i) => {
        const pct = Math.min(s.value, 100) / 100;
        const p = getPoint(i, pct);
        return <circle key={`d${i}`} cx={p.x} cy={p.y} r={2.5} fill={fillColor} />;
      })}
      {labels}
      {values}
    </svg>
  );
}
