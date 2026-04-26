/**
 * 1회성 채널 풀 시딩 — 검증된 KBO 야구 채널 등록
 * Usage: npx tsx scripts/seed-channel-pool.ts
 *
 * 모든 channel_id는 RSS(youtube.com/feeds/videos.xml?channel_id=X) 200 확인 완료.
 * 추가 채널 발굴은 YouTube search API batch 1회로 확장 가능.
 */

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

interface ChannelSeed {
  channel_id: string;
  channel_name: string;
  tier: number;
  team_affinity: string[] | null;
}

// ── Tier 1: 10개 구단 공식 채널 ──
const OFFICIAL: ChannelSeed[] = [
  { channel_id: "UCL6QZZxb-HR4hCh_eFAnQWA", channel_name: "LG Twins", tier: 1, team_affinity: ["LG"] },
  { channel_id: "UCsebzRfMhwYfjeBIxNX1brg", channel_name: "두산 베어스", tier: 1, team_affinity: ["두산"] },
  { channel_id: "UCvScyjGkBUx2CJDMNAi9Twg", channel_name: "kt wiz", tier: 1, team_affinity: ["KT"] },
  { channel_id: "UCt8iRtgjVqm5rJHNl1TUojg", channel_name: "SSG 랜더스", tier: 1, team_affinity: ["SSG"] },
  { channel_id: "UC8_FRgynMX8wlGsU6Jh3zKg", channel_name: "NC 다이노스", tier: 1, team_affinity: ["NC"] },
  { channel_id: "UCKp8knO8a6tSI1oaLjfd9XA", channel_name: "KIA 타이거즈", tier: 1, team_affinity: ["KIA"] },
  { channel_id: "UCAZQZdSY5_YrziMPqXi-Zfw", channel_name: "롯데 자이언츠", tier: 1, team_affinity: ["롯데"] },
  { channel_id: "UCMWAku3a3h65QpLm63Jf2pw", channel_name: "삼성 라이온즈", tier: 1, team_affinity: ["삼성"] },
  { channel_id: "UCdq4Ji3772xudYRUatdzRrg", channel_name: "한화 이글스", tier: 1, team_affinity: ["한화"] },
  { channel_id: "UC_MA8-XEaVmvyayPzG66IKg", channel_name: "키움 히어로즈", tier: 1, team_affinity: ["키움"] },
];

// ── Tier 1: 방송사 + KBO 공식 ──
const BROADCASTERS: ChannelSeed[] = [
  { channel_id: "UCBkyj16n2snkRg1BAzpovXQ", channel_name: "SPOTV", tier: 1, team_affinity: null },
  { channel_id: "UCoVz66yWHzVsXAFG8WhJK9g", channel_name: "KBO 공식", tier: 1, team_affinity: null },
];

// ── Tier 2: 인기 야구 유튜버 (RSS 200 확인) ──
const YOUTUBERS: ChannelSeed[] = [
  { channel_id: "UCWyAKKYySb5_2tOvm4HzR8w", channel_name: "크보톡 KBO Talk", tier: 2, team_affinity: null },
  { channel_id: "UCGw0LGOF_2UdChOPd2sGiDg", channel_name: "크보오프너", tier: 2, team_affinity: null },
  { channel_id: "UCcQ33wSuym1EpXFHwKXbdQg", channel_name: "독수리약사_독약TV", tier: 2, team_affinity: ["한화"] },
];

// ── Tier 3: 팬채널 — 추후 YouTube search batch로 발굴 추가 ──
const FAN_CHANNELS: ChannelSeed[] = [];

const ALL_CHANNELS = [...OFFICIAL, ...BROADCASTERS, ...YOUTUBERS, ...FAN_CHANNELS];

async function main() {
  console.log(`Seeding ${ALL_CHANNELS.length} channels...`);

  const { error } = await supabase
    .from("channel_pool")
    .upsert(
      ALL_CHANNELS.map((c) => ({
        channel_id: c.channel_id,
        channel_name: c.channel_name,
        tier: c.tier,
        team_affinity: c.team_affinity,
        is_active: true,
      })),
      { onConflict: "channel_id" },
    );

  if (error) {
    console.error("Seed error:", error.message);
    process.exit(1);
  }

  console.log(`Done. ${ALL_CHANNELS.length} channels upserted.`);
}

main();
