/** Shared types for API routes */

/** Player entry from players-roster.json */
export interface RosterPlayer {
  name: string;
  kboId: string;
  team: string;
  teamId: number;
  position: string;
  backNo: string;
}

/** YouTube search result item (from YouTube Data API v3) */
export interface YouTubeSearchItem {
  id: { videoId: string };
  snippet: {
    title: string;
    channelTitle: string;
    publishedAt: string;
    thumbnails?: {
      default?: { url: string };
      medium?: { url: string };
      high?: { url: string };
    };
  };
}

/** Normalized highlight video (used across highlights, team-videos, cron) */
export interface HighlightVideo {
  id: string;
  title: string;
  thumbnail: string | undefined;
  channel?: string;
  publishedAt: string;
}

/** Highlight row for Supabase cron insert */
export interface HighlightRow {
  video_id: string;
  title: string;
  thumbnail: string | undefined;
  channel: string;
  published_at: string;
}

/** Naver News API item (raw response) */
export interface NaverNewsRawItem {
  title: string;
  description: string;
  originallink?: string;
  link: string;
  pubDate: string;
}

/** Cleaned news item after HTML stripping */
export interface NewsItem {
  title: string;
  description: string;
  link: string;
  pubDate: string;
}

/** KBO game-live raw game object from KBO WebSocket API */
export interface KboRawGame {
  G_ID: string;
  AWAY_NM: string;
  HOME_NM: string;
  AWAY_SCORE: string;
  HOME_SCORE: string;
  INN_NO: string;
  TB_SC: string;
  BALL_CN: string;
  STRIKE_CN: string;
  OUT_CN: string;
  BASE1_NM: string;
  BASE2_NM: string;
  BASE3_NM: string;
  BAT_NM: string;
  PIT_NM: string;
  G_DT: string;
  STADIUM_NM: string;
}

/** Push subscription row from Supabase */
export interface PushSubscriptionRow {
  subscription: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  };
}

/** WebPushError shape from web-push library */
export interface WebPushError extends Error {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  endpoint: string;
}
