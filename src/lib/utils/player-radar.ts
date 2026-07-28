// Pure radar-stat calculators for the player profile hexagon chart.
// Extracted from PlayerRadar.tsx so values can be regression-tested.
// All axis values MUST be clamped to [0,100] — an unclamped value (e.g. a
// high-strikeout batter making 안정감 go negative) draws the vertex past the
// center and folds the hexagon inward.

export interface BatterStatsRaw {
  avg: string | number;
  obp: string | number;
  slg: string | number;
  pa: number;
  bb: number;
  so: number;
  sb: number;
  [key: string]: string | number | undefined;
}

export interface PitcherStatsRaw {
  era: string | number;
  whip: string | number;
  ip: string | number;
  so: number;
  bb: number;
  [key: string]: string | number | undefined;
}

export interface RadarAxis {
  label: string;
  value: number;
}

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

export function calcBatterRadar(s: BatterStatsRaw): RadarAxis[] {
  const avg = parseFloat(String(s.avg)) || 0;
  const obp = parseFloat(String(s.obp)) || 0;
  const slg = parseFloat(String(s.slg)) || 0;
  const pa = s.pa || 1;
  const bb = s.bb || 0;
  const so = s.so || 0;
  const sb = s.sb || 0;

  return [
    { label: "타격", value: clamp((avg / 0.320) * 100) },
    { label: "파워", value: clamp((slg / 0.550) * 100) },
    { label: "선구안", value: clamp(((bb / pa) / 0.12) * 100) },
    { label: "주루", value: clamp((sb / 30) * 100) },
    { label: "안정감", value: clamp((1 - (so / pa) / 0.25) * 100) },
    { label: "출루", value: clamp((obp / 0.420) * 100) },
  ];
}

export function calcPitcherRadar(s: PitcherStatsRaw): RadarAxis[] {
  const era = parseFloat(String(s.era)) || 5;
  const whip = parseFloat(String(s.whip)) || 1.5;
  const ip = parseFloat(String(s.ip)) || 1;
  const so = s.so || 0;
  const bb = s.bb || 0;

  return [
    { label: "제구", value: clamp((1 - (bb / ip) / 0.5) * 100) },
    { label: "구위", value: clamp((so / ip / 1.2) * 100) },
    { label: "탈삼진", value: clamp((so / Math.max(ip, 1)) / 1.0 * 100) },
    { label: "체력", value: clamp((ip / 180) * 100) },
    { label: "안정감", value: clamp((1 - era / 6.0) * 100) },
    { label: "지배력", value: clamp((1 - whip / 1.8) * 100) },
  ];
}
