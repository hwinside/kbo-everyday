// 알림 종류별 설정 (push-notifications-v1 S2) — 키/디폴트 SSOT.
// row 없음 = DEFAULT_PREFS (전부 on, 이닝 묶음 요약만 off — 스펙 §6 확정)

export const PREF_KEYS = [
  "game_start",
  "game_end",
  "my_team_score",
  "my_team_score_inning_summary",
  "fav_player_highlight",
  "fav_player_strikeout",
  "fav_player_post",
  "comment_reply",
  "dm",
] as const;

export type PrefKey = (typeof PREF_KEYS)[number];
export type NotificationPrefs = Record<PrefKey, boolean>;

export const DEFAULT_PREFS: NotificationPrefs = {
  game_start: true,
  game_end: true,
  my_team_score: true,
  my_team_score_inning_summary: false,
  fav_player_highlight: true,
  fav_player_strikeout: true,
  fav_player_post: true,
  comment_reply: true,
  dm: true,
};

/** 마이페이지 토글 UI 라벨 (노출 순서 그대로) */
export const PREF_LABELS: { key: PrefKey; label: string; desc?: string }[] = [
  { key: "game_start", label: "경기 시작" },
  { key: "game_end", label: "경기 종료" },
  { key: "my_team_score", label: "내 팀 득점", desc: "득점마다 바로 알림" },
  { key: "my_team_score_inning_summary", label: "이닝 득점 요약", desc: "이닝 종료 시 묶음 알림" },
  { key: "fav_player_highlight", label: "최애선수 활약" },
  { key: "fav_player_strikeout", label: "최애선수 삼진 (투수)" },
  { key: "fav_player_post", label: "최애선수 관련 글" },
  { key: "comment_reply", label: "댓글/답글" },
  { key: "dm", label: "쪽지" },
];
