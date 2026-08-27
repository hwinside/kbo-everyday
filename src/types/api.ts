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
    channelId?: string;
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
  /** 언론사 원문 URL — 클릭은 link(네이버) 우선이되 출처 표기는 이 값 기준 */
  originalLink?: string;
  pubDate: string;
  thumbnailUrl?: string | null;
}

/** KBO game-live raw game object from KBO GetKboGameList API */
export interface KboRawGame {
  G_ID: string;
  G_DT: string;
  G_TM: string;
  S_NM: string;
  AWAY_ID: string;
  HOME_ID: string;
  AWAY_NM: string;
  HOME_NM: string;
  T_SCORE_CN: string;
  B_SCORE_CN: string;
  GAME_INN_NO: number;
  GAME_TB_SC: string;
  GAME_STATE_SC: string;
  CANCEL_SC_ID: string;
  /**
   * 취소 사유 원문(예: `우천취소`/`폭염취소`/`그라운드사정`). 정상 경기는 빈 문자열.
   * optional 인 이유: KBO 응답 부분열화/폴백 경로에서 필드 자체가 없을 수 있다.
   */
  CANCEL_SC_NM?: string;
  T_PIT_P_NM: string;
  B_PIT_P_NM: string;
  W_PIT_P_NM: string;
  L_PIT_P_NM: string;
  SV_PIT_P_NM: string;
  STRIKE_CN: number;
  BALL_CN: number;
  OUT_CN: number;
  B1_BAT_ORDER_NO: number;
  B2_BAT_ORDER_NO: number;
  B3_BAT_ORDER_NO: number;
  B_P_NM: string;
  T_P_NM: string;
  T_RANK_NO: number;
  B_RANK_NO: number;
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
