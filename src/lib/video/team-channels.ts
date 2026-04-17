/**
 * KBO 10개 구단 공식 YouTube 채널 ID
 * 출처: 기존 /api/cron/highlights TEAM_CHANNELS (2026-04-17 분리)
 */

export const TEAM_OFFICIAL_CHANNELS: Record<string, string> = {
  LG: "UCL6QZZxb-HR4hCh_eFAnQWA",
  "두산": "UCsebzRfMhwYfjeBIxNX1brg",
  KT: "UCvScyjGkBUx2CJDMNAi9Twg",
  SSG: "UCt8iRtgjVqm5rJHNl1TUojg",
  NC: "UC8_FRgynMX8wlGsU6Jh3zKg",
  KIA: "UCKp8knO8a6tSI1oaLjfd9XA",
  "삼성": "UCMWAku3a3h65QpLm63Jf2pw",
  "롯데": "UCAZQZdSY5_YrziMPqXi-Zfw",
  "한화": "UCdq4Ji3772xudYRUatdzRrg",
  "키움": "UC_MA8-XEaVmvyayPzG66IKg",
};

/** team_id → channel_id 역매핑 */
export const OFFICIAL_CHANNEL_IDS: ReadonlySet<string> = new Set(
  Object.values(TEAM_OFFICIAL_CHANNELS),
);

export function isOfficialChannel(channelId: string | null | undefined): boolean {
  if (!channelId) return false;
  return OFFICIAL_CHANNEL_IDS.has(channelId);
}
