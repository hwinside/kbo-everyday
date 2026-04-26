/**
 * 채널 풀 확장 — YouTube Search API로 KBO 관련 채널 발굴
 * Usage: npx tsx scripts/discover-channels.ts
 *
 * 검색어 목록으로 shorts 검색 → 결과에서 channel_id 추출 → 중복 제거 → channel_pool에 추가
 * 1회성 batch. quota 비용: search.list 100 units × 쿼리 수
 */

import { createClient } from "@supabase/supabase-js";

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY!;
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// 검색어 목록 — 다양한 KBO 관련 숏츠 검색
const QUERIES = [
  "KBO 숏츠",
  "프로야구 숏츠",
  "프로야구 하이라이트",
  "KBO 하이라이트 2026",
  "야구 숏츠 2026",
  // 팀별
  "LG 트윈스 숏츠",
  "두산 베어스 숏츠",
  "KT 위즈 숏츠",
  "SSG 랜더스 숏츠",
  "NC 다이노스 숏츠",
  "KIA 타이거즈 숏츠",
  "롯데 자이언츠 숏츠",
  "삼성 라이온즈 숏츠",
  "한화 이글스 숏츠",
  "키움 히어로즈 숏츠",
  // 인기 선수
  "박해민 숏츠",
  "김도영 숏츠",
  "오스틴 숏츠",
  "양현종 숏츠",
  "구자욱 숏츠",
  // 밈/팬 콘텐츠
  "크보 밈",
  "KBO 웃긴",
  "야구 짤",
  "크보 레전드",
];

interface ChannelInfo {
  channel_id: string;
  channel_name: string;
  count: number; // 검색에 등장한 횟수
}

async function searchYouTube(query: string): Promise<Array<{ channelId: string; channelTitle: string }>> {
  const url =
    `https://www.googleapis.com/youtube/v3/search` +
    `?part=snippet&q=${encodeURIComponent(query)}` +
    `&type=video&maxResults=50&order=relevance&videoDuration=short` +
    `&key=${YOUTUBE_API_KEY}`;

  const res = await fetch(url);
  const data = await res.json();

  if (data.error) {
    console.error(`  Error for "${query}": ${data.error.message}`);
    return [];
  }

  return (data.items || []).map((item: any) => ({
    channelId: item.snippet.channelId,
    channelTitle: item.snippet.channelTitle,
  }));
}

async function main() {
  // 1. Load existing channels to skip
  const { data: existing } = await supabase
    .from("channel_pool")
    .select("channel_id");
  const existingIds = new Set((existing ?? []).map((r) => r.channel_id));
  console.log(`Existing channels: ${existingIds.size}`);

  // 2. Search and collect channels
  const channelMap = new Map<string, ChannelInfo>();
  let totalQueries = 0;

  for (const query of QUERIES) {
    console.log(`Searching: "${query}"...`);
    const results = await searchYouTube(query);
    totalQueries++;

    for (const r of results) {
      if (existingIds.has(r.channelId)) continue; // skip existing
      const info = channelMap.get(r.channelId);
      if (info) {
        info.count++;
      } else {
        channelMap.set(r.channelId, {
          channel_id: r.channelId,
          channel_name: r.channelTitle,
          count: 1,
        });
      }
    }

    // Rate limit: 100ms between requests
    await new Promise((r) => setTimeout(r, 100));
  }

  console.log(`\nQueries: ${totalQueries} (est. ${totalQueries * 100} quota units)`);
  console.log(`New channels discovered: ${channelMap.size}`);

  if (channelMap.size === 0) {
    console.log("No new channels found.");
    return;
  }

  // 3. Sort by frequency (channels appearing in more searches = more relevant)
  const sorted = Array.from(channelMap.values()).sort((a, b) => b.count - a.count);

  // 4. Verify channels via RSS (filter out dead channels)
  console.log("\nVerifying channels via RSS...");
  const verified: ChannelInfo[] = [];
  for (const ch of sorted) {
    try {
      const res = await fetch(
        `https://www.youtube.com/feeds/videos.xml?channel_id=${ch.channel_id}`,
        { method: "HEAD" },
      );
      if (res.ok) {
        verified.push(ch);
        console.log(`  ✓ ${ch.channel_name} (${ch.count}회 등장)`);
      } else {
        console.log(`  ✗ ${ch.channel_name} (RSS ${res.status})`);
      }
    } catch {
      console.log(`  ✗ ${ch.channel_name} (fetch error)`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  console.log(`\nVerified channels: ${verified.length}`);

  if (verified.length === 0) {
    console.log("No verified channels to add.");
    return;
  }

  // 5. Assign tiers based on frequency
  //    3+ appearances → tier 2 (popular)
  //    1-2 appearances → tier 3 (fan/niche)
  const rows = verified.map((ch) => ({
    channel_id: ch.channel_id,
    channel_name: ch.channel_name,
    tier: ch.count >= 3 ? 2 : 3,
    is_active: true,
    team_affinity: null as string[] | null,
  }));

  // 6. Upsert to channel_pool
  const { error } = await supabase
    .from("channel_pool")
    .upsert(rows, { onConflict: "channel_id" });

  if (error) {
    console.error("Upsert error:", error.message);
    process.exit(1);
  }

  console.log(`\nDone. ${verified.length} channels added to channel_pool.`);
  console.log(`  Tier 2 (popular): ${rows.filter((r) => r.tier === 2).length}`);
  console.log(`  Tier 3 (fan/niche): ${rows.filter((r) => r.tier === 3).length}`);
  console.log(`\nTotal quota used: ~${totalQueries * 100} units`);
}

main();
