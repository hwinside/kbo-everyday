/**
 * 선수 타이틀(부문 랭킹) 정의 — 랭킹 페이지(rankings/[stat])와
 * 홈 최애선수 카드 타이틀 라벨이 동일 부문/정렬/뱃지 기준을 공유하도록 SSOT로 분리.
 */

export type StatType = "batter" | "pitcher";

export interface StatDef {
  label: string;
  emoji: string;
  desc: string;
  criteria: string;
  key: string;
  type: StatType;
  format?: (v: number) => string;
  higherIsBetter: boolean;
}

export const STAT_DEFS: Record<string, StatDef> = {
  hr: { label: "파워히터", emoji: "💣", desc: "홈런 랭킹", criteria: "시즌 15홈런 이상이면 💣 파워히터 뱃지 획득", key: "hr", type: "batter", higherIsBetter: true },
  avg: { label: "방망이장인", emoji: "🏏", desc: "타율 랭킹", criteria: "시즌 타율 .300 이상이면 🏏 방망이장인 뱃지 획득", key: "avg", type: "batter", format: (v) => v.toFixed(3), higherIsBetter: true },
  sb: { label: "도루왕", emoji: "🏃", desc: "도루 랭킹", criteria: "시즌 20도루 이상이면 🏃 도루왕 뱃지 획득", key: "sb", type: "batter", higherIsBetter: true },
  bb: { label: "선구안", emoji: "👁️", desc: "볼넷 랭킹", criteria: "40볼넷+ & BB/K 0.5 이상이면 👁️ 선구안 뱃지 획득", key: "bb", type: "batter", higherIsBetter: true },
  obp: { label: "출루기계", emoji: "📊", desc: "출루율 랭킹", criteria: "출루율 .380 이상이면 📊 출루기계 뱃지 획득", key: "obp", type: "batter", format: (v) => v.toFixed(3), higherIsBetter: true },
  rbi: { label: "청소부", emoji: "🧹", desc: "타점 랭킹", criteria: "시즌 80타점 이상이면 🧹 청소부 뱃지 획득", key: "rbi", type: "batter", higherIsBetter: true },
  ops: { label: "OPS 괴물", emoji: "💎", desc: "OPS 랭킹", criteria: "OPS .900 이상이면 💎 OPS 괴물 뱃지 획득", key: "ops", type: "batter", format: (v) => v.toFixed(3), higherIsBetter: true },
  runs: { label: "득점기계", emoji: "🎪", desc: "득점 랭킹", criteria: "시즌 80득점 이상이면 🎪 득점기계 뱃지 획득", key: "runs", type: "batter", higherIsBetter: true },
  so_batter: { label: "삼진머신", emoji: "💀", desc: "삼진 랭킹 (타자)", criteria: "시즌 120삼진 이상이면 💀 삼진머신 뱃지 (풀스윙형)", key: "so", type: "batter", higherIsBetter: true },
  hbp: { label: "존압박", emoji: "🧲", desc: "사구 랭킹", criteria: "시즌 10사구 이상이면 🧲 존압박 뱃지 획득", key: "hbp", type: "batter", higherIsBetter: true },
  doubles: { label: "장타제조기", emoji: "🦵", desc: "2루타+3루타 랭킹", criteria: "2루타+3루타 30개 이상이면 🦵 장타제조기 뱃지 획득", key: "doubles", type: "batter", higherIsBetter: true },
  wins: { label: "에이스", emoji: "👑", desc: "승수 랭킹", criteria: "10승+ & ERA 3.50 이하이면 👑 에이스 뱃지 획득", key: "wins", type: "pitcher", higherIsBetter: true },
  era: { label: "철벽", emoji: "🛡️", desc: "ERA 랭킹", criteria: "ERA 2.50 이하 (50이닝+)이면 🛡️ 철벽 뱃지 획득", key: "era", type: "pitcher", format: (v) => v.toFixed(2), higherIsBetter: false },
  so_pitcher: { label: "탈삼진", emoji: "🔥", desc: "탈삼진 랭킹", criteria: "K/9 8.0 이상이면 🔥 탈삼진 뱃지 획득", key: "so", type: "pitcher", higherIsBetter: true },
  saves: { label: "마무리", emoji: "💪", desc: "세이브 랭킹", criteria: "시즌 20세이브 이상이면 💪 마무리 뱃지 획득", key: "saves", type: "pitcher", higherIsBetter: true },
  holds: { label: "벽", emoji: "🧱", desc: "홀드 랭킹", criteria: "시즌 20홀드 이상이면 🧱 벽 뱃지 획득", key: "holds", type: "pitcher", higherIsBetter: true },
  ip: { label: "이닝이터", emoji: "🏔️", desc: "이닝 랭킹", criteria: "시즌 150이닝 이상이면 🏔️ 이닝이터 뱃지 획득", key: "ip", type: "pitcher", format: (v) => v.toFixed(1), higherIsBetter: true },
  whip: { label: "포커페이스", emoji: "🧊", desc: "WHIP 랭킹", criteria: "WHIP 1.10 이하 (50이닝+)이면 🧊 포커페이스 뱃지 획득", key: "whip", type: "pitcher", format: (v) => v.toFixed(2), higherIsBetter: false },
  games_batter: { label: "풀타임", emoji: "🔋", desc: "출전경기 랭킹", criteria: "시즌 140경기 이상 출전이면 🔋 풀타임 뱃지 획득", key: "games", type: "batter", higherIsBetter: true },
  games_pitcher: { label: "불펜철인", emoji: "🔋", desc: "등판수 랭킹", criteria: "시즌 60경기 이상 등판이면 🔋 불펜철인 뱃지 획득", key: "games", type: "pitcher", higherIsBetter: true },
};
