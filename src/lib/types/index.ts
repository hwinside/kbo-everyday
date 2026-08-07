/* ===== User ===== */
export interface User {
  id: string;
  nickname: string;
  avatarUrl: string | null;
  myTeamId: number | null;
  level: number;
  points: number;
  title: string;
  createdAt: string;
  updatedAt: string;
}

/* ===== Team ===== */
export interface Team {
  id: number;
  name: string;
  shortName: string;
  colorPrimary: string;
  colorSecondary: string;
  logoUrl: string;
  youtubeChannelId: string;
}

/* ===== Player ===== */
export interface Player {
  id: number;
  teamId: number;
  name: string;
  nameEn: string | null;
  number: number;
  position: string;
  throwsBats: string;
  birthDate: string | null;
  photoUrl: string | null;
  isActive: boolean;
}

/* ===== Post ===== */
export type BoardType = "team" | "player" | "game" | "free" | "poll";

export interface Post {
  id: number;
  boardType: BoardType;
  boardId: string;
  authorId: string;
  title: string | null;
  content: string;
  imageUrls: string[];
  videoUrls?: string[];
  likeCount: number;
  commentCount: number;
  isReported: boolean;
  createdAt: string;
  author?: PostAuthor;
  /**
   * 글 공개범위 SSOT 입력(post-scope). 카드가 부모가 주입한 라벨을 그리면 같은 글이 화면마다
   * 다른 배지를 달게 된다 — 그래서 태그를 글에 실어 보내고 카드가 직접 계산한다.
   * 누락(레거시 글)이면 `scopeInputForPost` 가 board_type/board_id 로 복원한다.
   */
  teamTags?: string[] | null;
  playerTags?: string[] | null;
}

export interface PostAuthor {
  nickname: string;
  avatarUrl: string | null;
  myTeamId: number | null;
  level: number;
  title: string;
  grade?: string;
}

/* ===== Comment ===== */
export interface Comment {
  id: number;
  postId: number;
  authorId: string;
  content: string;
  likeCount: number;
  createdAt: string;
  author?: PostAuthor;
}

/* ===== Game ===== */
export type GameStatus = "scheduled" | "live" | "final" | "postponed";

export interface Game {
  id: string;
  date: string;
  time: string;
  homeTeamId: number;
  awayTeamId: number;
  status: GameStatus;
  inning: string | null;
  homeScore: number;
  awayScore: number;
  stadium: string;
  updatedAt: string;
}

export interface GameState {
  gameId: string;
  balls: number;
  strikes: number;
  outs: number;
  runner1b: boolean;
  runner2b: boolean;
  runner3b: boolean;
  runner1bName?: string | null;
  runner2bName?: string | null;
  runner3bName?: string | null;
  currentBatter: string | null;
  currentPitcher: string | null;
}

export interface GamePlay {
  id: number;
  gameId: string;
  inning: string;
  sequence: number;
  description: string;
  isHighlight: boolean;
  batter: string | null;
  pitcher: string | null;
  createdAt: string;
}

export interface GameInning {
  gameId: string;
  inning: number;
  topScore: number | null;
  bottomScore: number | null;
}

/* ===== Prediction ===== */
export interface Prediction {
  id: number;
  userId: string;
  gameId: string;
  predictedTeamId: number;
  isCorrect: boolean | null;
  pointsEarned: number;
  createdAt: string;
}

export interface PredictionSummary {
  gameId: string;
  homeCount: number;
  awayCount: number;
  totalCount: number;
}

export interface UserStreak {
  userId: string;
  currentStreak: number;
  maxStreak: number;
  totalPredictions: number;
  totalCorrect: number;
}

/* ===== News ===== */
export interface NewsArticle {
  id: number;
  teamId: number | null;
  title: string;
  source: string;
  sourceUrl: string;
  thumbnailUrl: string | null;
  publishedAt: string;
  createdAt: string;
}

export interface YouTubeVideo {
  id: string;
  teamId: number;
  title: string;
  thumbnailUrl: string;
  viewCount: number;
  publishedAt: string;
}

/* ===== Stats ===== */
export interface PlayerSeasonStats {
  playerId: number;
  season: number;
  games: number;
  // Batter
  avg: number | null;
  obp: number | null;
  slg: number | null;
  ops: number | null;
  hr: number | null;
  rbi: number | null;
  sb: number | null;
  hits: number | null;
  ab: number | null;
  // Pitcher
  era: number | null;
  whip: number | null;
  kPer9: number | null;
  wins: number | null;
  losses: number | null;
  ip: number | null;
  so: number | null;
}

export interface TeamStanding {
  teamId: number;
  season: number;
  rank: number;
  wins: number;
  losses: number;
  draws: number;
  pct: number;
  gb: number;
  streak: string;
  last10: string;
}
