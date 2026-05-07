// Phase 0 hotfix: AI 경기예측에서 부상자 hard exclude.
// Phase 1에서 KBO 공홈 /Player/Injury.aspx 자동 동기화 + Supabase injury_list 로 대체 예정.

export interface InjuryEntry {
  name: string;
  team: string; // teams.shortName (LG, KT, ...)
  kboId?: string;
  reason?: string;
  since?: string; // YYYY-MM-DD
}

export const INJURY_BLOCKLIST: InjuryEntry[] = [
  { name: "유영찬", team: "LG", kboId: "50106", reason: "팔꿈치", since: "2026-05-07" },
];

export const INJURY_BLOCKLIST_KEYS = new Set(
  INJURY_BLOCKLIST.map((e) => `${e.team}:${e.name}`)
);
