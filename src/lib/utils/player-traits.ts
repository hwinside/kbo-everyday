/** 선수 특성 뱃지 자동 부여 */

export interface PlayerTrait {
  emoji: string;
  label: string;
  desc: string;
  criteria: string;
  statKey: string;
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

  // 최소 출전 필터
  if (stats.games < 10 || pa < 30) return traits;
  const g162 = 162; // 풀시즌 기준
  const pace = (g: number) => stats.games >= 50 ? Math.round(g / stats.games * g162) : 0; // 162경기 페이스 환산

  // 💣 파워히터 (홈런 15+)
  if (stats.hr >= 15 || (stats.games >= 10 && pace(stats.hr) >= 20)) traits.push({ emoji: "💣", label: "파워히터", statKey: "hr", desc: `${stats.hr}홈런`, criteria: "시즌 15홈런 이상" });
  
  // 🏏 방망이장인 (타율 .300+)
  if (avg >= 0.300) traits.push({ emoji: "🏏", label: "방망이장인", statKey: "avg", desc: `타율 ${stats.avg}`, criteria: "시즌 타율 .300 이상" });

  // 👁️ 선구안 (볼넷/삼진 비율 0.5+ & 볼넷 40+)
  if ((stats.bb >= 40 || pace(stats.bb) >= 50) && stats.bb / Math.max(stats.so, 1) >= 0.4) traits.push({ emoji: "👁️", label: "선구안", statKey: "bb", desc: `${stats.bb}볼넷`, criteria: "40볼넷+ & BB/K 0.5 이상" });

  // 🏃 도루왕 (도루 20+)
  if (stats.sb >= 20 || (stats.games >= 10 && pace(stats.sb) >= 25)) traits.push({ emoji: "🏃", label: "도루왕", statKey: "sb", desc: `${stats.sb}도루`, criteria: "시즌 20도루 이상" });

  // 🦶 쾌속 (도루 10+)
  if ((stats.sb >= 10 || pace(stats.sb) >= 12) && stats.sb < 20 && pace(stats.sb) < 25) traits.push({ emoji: "🦶", label: "쾌속", statKey: "sb", desc: `${stats.sb}도루`, criteria: "시즌 10~19도루" });

  // 🚶 산책왕 (볼넷 60+)
  if (stats.bb >= 60 || pace(stats.bb) >= 70) traits.push({ emoji: "🚶", label: "산책왕", statKey: "bb", desc: `${stats.bb}볼넷`, criteria: "시즌 60볼넷 이상" });

  // 📊 출루기계 (출루율 .380+)
  if (obp >= 0.380) traits.push({ emoji: "📊", label: "출루기계", statKey: "obp", desc: `출루율 ${stats.obp}`, criteria: "출루율 .380 이상" });

  // 🧹 청소부 (타점 80+)
  if (stats.rbi >= 80 || (stats.games >= 10 && pace(stats.rbi) >= 90)) traits.push({ emoji: "🧹", label: "청소부", statKey: "rbi", desc: `${stats.rbi}타점`, criteria: "시즌 80타점 이상" });

  // 🦵 장타제조기 (2루타+3루타 30+)
  if (stats.doubles + stats.triples >= 30 || pace(stats.doubles + stats.triples) >= 35) traits.push({ emoji: "🦵", label: "장타제조기", statKey: "doubles", desc: `${stats.doubles}이루타 ${stats.triples}삼루타`, criteria: "2루타+3루타 30개 이상" });

  // 🎯 컨택장인 (삼진율 10% 이하 & 타율 .270+)
  if (kRate <= 0.10 && avg >= 0.270) traits.push({ emoji: "🎯", label: "컨택장인", statKey: "avg", desc: `삼진율 ${(kRate * 100).toFixed(1)}%`, criteria: "삼진율 10% 이하 & 타율 .270+" });

  // 💀 삼진머신 (삼진 120+ — 풀스윙 파워형)
  if (stats.so >= 120 || pace(stats.so) >= 130) traits.push({ emoji: "💀", label: "삼진머신", statKey: "so_batter", desc: `${stats.so}삼진`, criteria: "시즌 120삼진 이상 (풀스윙형)" });

  // 🍀 BABIP신 (BABIP .350+)
  if (babip >= 0.350) traits.push({ emoji: "🍀", label: "BABIP신", statKey: "avg", desc: `BABIP ${babip.toFixed(3)}`, criteria: "BABIP .350 이상" });

  // 🧲 존압박 (사구 10+)
  if (stats.hbp >= 10) traits.push({ emoji: "🧲", label: "존압박", statKey: "hbp", desc: `${stats.hbp}사구`, criteria: "시즌 10사구 이상" });

  // 🔋 풀타임 (경기 140+)
  if (stats.games >= 140 || pace(stats.games) >= 155) traits.push({ emoji: "🔋", label: "풀타임", statKey: "games_batter", desc: `${stats.games}경기 출전`, criteria: "시즌 140경기 이상 출전" });

  // 💎 OPS 괴물 (OPS .900+)
  if (ops >= 0.900) traits.push({ emoji: "💎", label: "OPS 괴물", statKey: "ops", desc: `OPS ${stats.ops}`, criteria: "OPS .900 이상" });

  // 🏠 홈런아티스트 (홈런/타수 비율 상위)
  if (stats.hr >= 10 && stats.hr / ab >= 0.04) traits.push({ emoji: "🏠", label: "홈런아티스트", statKey: "hr", desc: `${(stats.hr / ab * 100).toFixed(1)}% 홈런율`, criteria: "타수 대비 홈런 4% 이상" });

  // 🎪 득점기계 (득점 80+)
  if (stats.runs >= 80 || (stats.games >= 10 && pace(stats.runs) >= 90)) traits.push({ emoji: "🎪", label: "득점기계", statKey: "runs", desc: `${stats.runs}득점`, criteria: "시즌 80득점 이상" });

  return traits;
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
  if (stats.wins >= 10 && era <= 3.50) traits.push({ emoji: "👑", label: "에이스", statKey: "wins", desc: `${stats.wins}승 ERA ${stats.era}`, criteria: "10승+ & ERA 3.50 이하" });

  // 🔥 탈삼진 (K/9 8.0+)
  if (k9 >= 8.0 && stats.so >= 50) traits.push({ emoji: "🔥", label: "탈삼진", statKey: "so_pitcher", desc: `K/9 ${k9.toFixed(1)}`, criteria: "K/9 8.0 이상" });

  // 🎯 제구력 (BB/9 2.0 이하 & 이닝 40+)
  if (bb9 <= 2.0 && ip >= 40) traits.push({ emoji: "🎯", label: "제구력", statKey: "whip", desc: `BB/9 ${bb9.toFixed(1)}`, criteria: "BB/9 2.0 이하 (40이닝+)" });

  // 🧊 포커페이스 (WHIP 1.10 이하)
  if (whip <= 1.10 && ip >= 50) traits.push({ emoji: "🧊", label: "포커페이스", statKey: "whip", desc: `WHIP ${stats.whip}`, criteria: "WHIP 1.10 이하 (50이닝+)" });

  // 💪 마무리 (세이브 20+)
  if (stats.saves >= 20) traits.push({ emoji: "💪", label: "마무리", statKey: "saves", desc: `${stats.saves}세이브`, criteria: "시즌 20세이브 이상" });

  // 🧱 벽 (홀드 20+)
  if (stats.holds >= 20) traits.push({ emoji: "🧱", label: "벽", statKey: "holds", desc: `${stats.holds}홀드`, criteria: "시즌 20홀드 이상" });

  // 🏔️ 이닝이터 (이닝 150+)
  if (ip >= 150) traits.push({ emoji: "🏔️", label: "이닝이터", statKey: "ip", desc: `${stats.ip}이닝`, criteria: "시즌 150이닝 이상" });

  // 😤 다승 (15승+)
  if (stats.wins >= 15) traits.push({ emoji: "😤", label: "다승", statKey: "wins", desc: `${stats.wins}승`, criteria: "시즌 15승 이상" });

  // 🛡️ 철벽 (ERA 2.50 이하 & 이닝 50+)
  if (era <= 2.50 && ip >= 50) traits.push({ emoji: "🛡️", label: "철벽", statKey: "era", desc: `ERA ${stats.era}`, criteria: "ERA 2.50 이하 (50이닝+)" });

  // 🧨 폭탄해체반 (K/BB 4.0+)
  if (kbb >= 4.0 && stats.so >= 50) traits.push({ emoji: "🧨", label: "폭탄해체반", statKey: "so_pitcher", desc: `K/BB ${kbb.toFixed(1)}`, criteria: "K/BB 4.0 이상" });

  // 🔋 풀타임 (경기 60+, 불펜)
  if (stats.games >= 60) traits.push({ emoji: "🔋", label: "불펜철인", statKey: "games_pitcher", desc: `${stats.games}경기 등판`, criteria: "시즌 60경기 이상 등판" });

  // 🏆 완봉 (완봉 1+)
  if (stats.sho >= 1) traits.push({ emoji: "🏆", label: "완봉장인", statKey: "wins", desc: `${stats.sho}완봉`, criteria: "시즌 1완봉 이상" });

  // 💣 피홈런 많음 (HR 20+ — 특성이지만 개성)
  if (stats.hr >= 20) traits.push({ emoji: "🎰", label: "도박투수", statKey: "era", desc: `피홈런 ${stats.hr}개`, criteria: "피홈런 20개 이상" });

  return traits;
}
