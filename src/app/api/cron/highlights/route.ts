import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { YouTubeSearchItem, HighlightRow } from "@/types/api";
import { startJob, finishJob } from "@/lib/admin/job-logger";
import { reserveQuota } from "@/lib/video/youtube-quota";

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || "";
const CRON_SECRET = process.env.CRON_SECRET || "";

// ── RSS 기반: 구단 공식 채널 (quota 0) ──
const TEAM_CHANNELS: Record<string, string> = {
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

// ── API 기반: 범용 검색 (quota 사용) ──
const API_QUERIES: Record<string, string> = {
  "_ALL": "프로야구 하이라이트",
};

function decodeHtml(s: string) {
  return s.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&apos;/g, "'");
}

// ── RSS fetch (quota 0) ──
interface RssEntry {
  video_id: string;
  title: string;
  thumbnail: string;
  channel: string;
  published_at: string;
}

async function fetchRss(channelId: string): Promise<RssEntry[]> {
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`RSS fetch failed: ${res.status}`);
  const xml = await res.text();

  const entries: RssEntry[] = [];
  const entryBlocks = xml.split("<entry>").slice(1);

  for (const block of entryBlocks) {
    const videoId = block.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1] || "";
    const title = decodeHtml(block.match(/<title>([^<]+)<\/title>/)?.[1] || "");
    const thumbnail = block.match(/<media:thumbnail url="([^"]+)"/)?.[1] || "";
    const channel = decodeHtml(block.match(/<name>([^<]+)<\/name>/)?.[1] || "");
    const publishedAt = block.match(/<published>([^<]+)<\/published>/)?.[1] || "";

    if (videoId) {
      entries.push({
        video_id: videoId,
        title,
        thumbnail,
        channel,
        published_at: publishedAt,
      });
    }
  }

  return entries;
}

// ── YouTube API fetch (quota 100/call) ──
async function fetchYouTube(query: string) {
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=30&order=date&videoDuration=short&videoEmbeddable=true&key=${YOUTUBE_API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return (data.items || []).map((item: YouTubeSearchItem) => ({
    video_id: item.id.videoId,
    title: decodeHtml(item.snippet.title),
    thumbnail: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.default?.url,
    channel: item.snippet.channelTitle,
    published_at: item.snippet.publishedAt,
  }));
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const logId = await startJob("youtube-highlights");

  const supabase = supabaseAdmin;
  const results: Record<string, number> = {};
  let errorCount = 0;
  let rssCount = 0;
  let apiCount = 0;

  try {
    // 1) RSS: 구단 공식 채널 (quota 0)
    for (const [team, channelId] of Object.entries(TEAM_CHANNELS)) {
      try {
        const videos = await fetchRss(channelId);
        if (videos.length > 0) {
          await supabase.from("highlights").delete().eq("team", team);
          await supabase.from("highlights").insert(
            videos.slice(0, 15).map((v) => ({ ...v, team }))
          );
        }
        results[team] = videos.length;
        rssCount++;
      } catch {
        results[team] = -1;
        errorCount++;
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    // 2) API: 범용 검색 (quota 100/query) — 공유 원장으로 예약(잔여 없으면 skip)
    if (YOUTUBE_API_KEY) {
      for (const [team, query] of Object.entries(API_QUERIES)) {
        const reservation = await reserveQuota(supabase, 100);
        if (!reservation.allowed) {
          results[team] = -2; // quota 원장 cap → skip (에러 아님)
          continue;
        }
        try {
          const videos = await fetchYouTube(query);
          if (videos.length > 0) {
            await supabase.from("highlights").delete().eq("team", team);
            await supabase.from("highlights").insert(
              videos.slice(0, 30).map((v: HighlightRow) => ({ ...v, team }))
            );
          }
          results[team] = videos.length;
          apiCount++;
        } catch {
          results[team] = -1;
          errorCount++;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    const totalVideos = Object.values(results).filter((n) => n > 0).reduce((a, b) => a + b, 0);
    const totalTeams = Object.keys(TEAM_CHANNELS).length + Object.keys(API_QUERIES).length;
    // RSS 실패는 에러, API(_ALL) 실패/skip은 경고 (quota 소진 허용)
    const rssErrors = Object.entries(results)
      .filter(([team, count]) => team in TEAM_CHANNELS && count === -1).length;
    const apiErrors = errorCount - rssErrors;
    const apiSkipped = Object.entries(results)
      .filter(([team, count]) => team in API_QUERIES && count === -2).length;
    // quota degrade(_ALL 실패 또는 원장 skip)는 warning, RSS 실패만 error
    const status: "success" | "warning" | "error" =
      rssErrors > 0 ? "error" : apiErrors > 0 || apiSkipped > 0 ? "warning" : "success";
    const warnings =
      apiErrors > 0 ? ` (API ${apiErrors}건 실패-quota)` : apiSkipped > 0 ? ` (API ${apiSkipped}건 skip-quota원장)` : "";
    await finishJob(
      logId,
      status,
      `${totalTeams}팀 처리 (RSS ${rssCount}팀, API ${apiCount}팀), 총 ${totalVideos}개 영상${warnings}`,
      rssErrors > 0 ? `RSS ${rssErrors}팀 실패` : undefined,
    );
  } catch (e) {
    await finishJob(logId, "error", undefined, (e as Error).message);
  }

  return NextResponse.json({ ok: true, timestamp: new Date().toISOString(), results });
}
