/** 선수 특성 뱃지 자동 부여 */

export interface PlayerTrait {
  emoji: string;
  label: string;
  desc: string;
}

/** 타자 특성 판별 */
export function getBatterTraits(stats: {
  avg: string; games: number; pa: number; ab: number;
  hr: number; sb: number; bb: number; so: number;
  rbi: number; runs: number; hits: number;
  doubles: number; triples: number; tb: number;
  hbp: number; obp: string; slg: string; ops: string;
}): PlayerTrait[] {
  const traits: PlayerTrait[] = [];
  const avg = parseFloat(stats.avg) || 0;
  const obp = parseFloat(stats.obp) || 0;
  const slg = parseFloat(stats.slg) || 0;
  const ops = parseFloat(stats.ops) || 0;
  const pa = stats.pa || 1;
  const ab = stats.ab || 1;
  const kRate = stats.so / ab;
  const bbRate = stats.bb / pa;
  const isoP = slg - avg; // Isolated Power
  const babip = stats.ab - stats.so - stats.hr > 0
    ? (stats.hits - stats.hr) / (stats.ab - stats.so - stats.hr)
    : 0;

  // 최소 출전 필터 (규정타석 근처)
  if (stats.games < 30 || pa < 100) return traits;

  // 💣 파워히터 (홈런 15+)
  if (stats.hr >= 15) traits.push({ emoji: "💣", label: "파워히터", desc: `${stats.hr}홈런` });
  
  // 🏏 방망이장인 (타율 .300+)
  if (avg >= 0.300) traits.push({ emoji: "🏏", label: "방망이장인", desc: `타율 ${stats.avg}` });

  // 👁️ 선구안 (볼넷/삼진 비율 0.5+ & 볼넷 40+)
  if (stats.bb >= 40 && stats.bb / Math.max(stats.so, 1) >= 0.5) traits.push({ emoji: "👁️", label: "선구안", desc: `${stats.bb}볼넷` });

  // 🏃 도루왕 (도루 20+)
  if (stats.sb >= 20) traits.push({ emoji: "🏃", label: "도루왕", desc: `${stats.sb}도루` });

  // 🦶 쾌속 (도루 10+)
  if (stats.sb >= 10 && stats.sb < 20) traits.push({ emoji: "🦶", label: "쾌속", desc: `${stats.sb}도루` });

  // 🚶 산책왕 (볼넷 60+)
  if (stats.bb >= 60) traits.push({ emoji: "🚶", label: "산책왕", desc: `${stats.bb}볼넷` });

  // 📊 출루기계 (출루율 .380+)
  if (obp >= 0.380) traits.push({ emoji: "📊", label: "출루기계", desc: `출루율 ${stats.obp}` });

  // 🧹 청소부 (타점 80+)
  if (stats.rbi >= 80) traits.push({ emoji: "🧹", label: "청소부", desc: `${stats.rbi}타점` });

  // 🦵 장타제조기 (2루타+3루타 30+)
  if (stats.doubles + stats.triples >= 30) traits.push({ emoji: "🦵", label: "장타제조기", desc: `${stats.doubles}이루타 ${stats.triples}삼루타` });

  // 🎯 컨택장인 (삼진율 10% 이하 & 타율 .270+)
  if (kRate <= 0.10 && avg >= 0.270) traits.push({ emoji: "🎯", label: "컨택장인", desc: `삼진율 ${(kRate * 100).toFixed(1)}%` });

  // 💀 삼진머신 (삼진 120+ — 풀스윙 파워형)
  if (stats.so >= 120) traits.push({ emoji: "💀", label: "삼진머신", desc: `${stats.so}삼진` });

  // 🍀 BABIP신 (BABIP .350+)
  if (babip >= 0.350) traits.push({ emoji: "🍀", label: "BABIP신", desc: `BABIP ${babip.toFixed(3)}` });

  // 🧲 존압박 (사구 10+)
  if (stats.hbp >= 10) traits.push({ emoji: "🧲", label: "존압박", desc: `${stats.hbp}사구` });

  // 🔋 풀타임 (경기 140+)
  if (stats.games >= 140) traits.push({ emoji: "🔋", label: "풀타임", desc: `${stats.games}경기 출전` });

  // 💎 OPS 괴물 (OPS .900+)
  if (ops >= 0.900) traits.push({ emoji: "💎", label: "OPS 괴물", desc: `OPS ${stats.ops}` });

  // 🏠 홈런아티스트 (홈런/타수 비율 상위)
  if (stats.hr >= 10 && stats.hr / ab >= 0.04) traits.push({ emoji: "🏠", label: "홈런아티스트", desc: `${(stats.hr / ab * 100).toFixed(1)}% 홈런율` });

  // 🎪 득점기계 (득점 80+)
  if (stats.runs >= 80) traits.push({ emoji: "🎪", label: "득점기계", desc: `${stats.runs}득점` });

  return traits.slice(0, 4); // 최대 4개
}

/** 투수 특성 판별 */
export function getPitcherTraits(stats: {
  era: string; games: number; wins: number; losses: number;
  saves: number; holds: number; so: number; bb: number;
  ip: string; hits: number; hr: number; whip: string;
  cg: number; sho: number;
}): PlayerTrait[] {
  const traits: PlayerTrait[] = [];
  const era = parseFloat(stats.era) || 99;
  const whip = parseFloat(stats.whip) || 99;
  const ip = parseFloat(stats.ip) || 1;
  const k9 = (stats.so / ip) * 9;
  const bb9 = (stats.bb / ip) * 9;
  const kbb = stats.bb > 0 ? stats.so / stats.bb : stats.so;

  // 최소 출전 필터
  if (stats.games < 10) return traits;

  // 👑 에이스 (10승+ & ERA 3.5 이하)
  if (stats.wins >= 10 && era <= 3.50) traits.push({ emoji: "👑", label: "에이스", desc: `${stats.wins}승 ERA ${stats.era}` });

  // 🔥 탈삼진 (K/9 8.0+)
  if (k9 >= 8.0 && stats.so >= 50) traits.push({ emoji: "🔥", label: "탈삼진", desc: `K/9 ${k9.toFixed(1)}` });

  // 🎯 제구력 (BB/9 2.0 이하 & 이닝 40+)
  if (bb9 <= 2.0 && ip >= 40) traits.push({ emoji: "🎯", label: "제구력", desc: `BB/9 ${bb9.toFixed(1)}` });

  // 🧊 포커페이스 (WHIP 1.10 이하)
  if (whip <= 1.10 && ip >= 50) traits.push({ emoji: "🧊", label: "포커페이스", desc: `WHIP ${stats.whip}` });

  // 💪 마무리 (세이브 20+)
  if (stats.saves >= 20) traits.push({ emoji: "💪", label: "마무리", desc: `${stats.saves}세이브` });

  // 🧱 벽 (홀드 20+)
  if (stats.holds >= 20) traits.push({ emoji: "🧱", label: "벽", desc: `${stats.holds}홀드` });

  // 🏔️ 이닝이터 (이닝 150+)
  if (ip >= 150) traits.push({ emoji: "🏔️", label: "이닝이터", desc: `${stats.ip}이닝` });

  // 😤 다승 (15승+)
  if (stats.wins >= 15) traits.push({ emoji: "😤", label: "다승", desc: `${stats.wins}승` });

  // 🛡️ 철벽 (ERA 2.50 이하 & 이닝 50+)
  if (era <= 2.50 && ip >= 50) traits.push({ emoji: "🛡️", label: "철벽", desc: `ERA ${stats.era}` });

  // 🧨 폭탄해체반 (K/BB 4.0+)
  if (kbb >= 4.0 && stats.so >= 50) traits.push({ emoji: "🧨", label: "폭탄해체반", desc: `K/BB ${kbb.toFixed(1)}` });

  // 🔋 풀타임 (경기 60+, 불펜)
  if (stats.games >= 60) traits.push({ emoji: "🔋", label: "불펜철인", desc: `${stats.games}경기 등판` });

  // 🏆 완봉 (완봉 1+)
  if (stats.sho >= 1) traits.push({ emoji: "🏆", label: "완봉장인", desc: `${stats.sho}완봉` });

  // 💣 피홈런 많음 (HR 20+ — 특성이지만 개성)
  if (stats.hr >= 20) traits.push({ emoji: "🎰", label: "도박투수", desc: `피홈런 ${stats.hr}개` });

  return traits.slice(0, 4); // 최대 4개
}
