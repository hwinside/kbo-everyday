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

export interface PoolChannel {
  channel_id: string;
  channel_name: string;
  tier: number;
  team_affinity: string[] | null;
}

export interface PlayerTagChannel extends PoolChannel {
  is_active: boolean;
}

/** Load active channels from channel_pool */
export async function getActiveChannels(
  supabase: { from: (t: string) => any },
): Promise<PoolChannel[]> {
  const { data } = await supabase
    .from("channel_pool")
    .select("channel_id, channel_name, tier, team_affinity")
    .eq("is_active", true)
    .order("tier", { ascending: true });
  return data ?? [];
}

/** Legacy player-tag 재검증용: inactive 채널도 포함하고 조회 실패는 fail-close. */
export async function getPlayerTagChannels(
  supabase: { from: (t: string) => any },
): Promise<PlayerTagChannel[]> {
  // query-guard: bounded -- channel_pool은 운영 allowlist 전체(수백 행 상한),
  // inactive legacy identity 판정 때문에 페이지 분할 없이 단일 snapshot이 필요하다.
  const { data, error } = await supabase
    .from("channel_pool")
    .select("channel_id, channel_name, tier, team_affinity, is_active")
    .order("tier", { ascending: true });
  if (error) throw new Error(`channel metadata lookup failed: ${error.message}`);
  return data ?? [];
}
