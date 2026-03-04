// @ts-nocheck
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || "";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const CRON_SECRET = process.env.CRON_SECRET || "";

const QUERIES: Record<string, string> = {
  LG: "LG 트윈스 하이라이트",
  "두산": "두산 베어스 하이라이트",
  KT: "KT 위즈 하이라이트",
  SSG: "SSG 랜더스 하이라이트",
  NC: "NC 다이노스 하이라이트",
  KIA: "KIA 타이거즈 하이라이트",
  "삼성": "삼성 라이온즈 하이라이트",
  "롯데": "롯데 자이언츠 하이라이트",
  "한화": "한화 이글스 하이라이트",
  "키움": "키움 히어로즈 하이라이트",
  "_ALL": "프로야구 하이라이트",
};

function decodeHtml(s: string) {
  return s.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&apos;/g, "'");
}

async function fetchYouTube(query: string) {
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=30&order=date&videoDuration=short&videoEmbeddable=true&key=${YOUTUBE_API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return (data.items || []).map((item: any) => ({
    video_id: item.id.videoId,
    title: decodeHtml(item.snippet.title),
    thumbnail: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.default?.url,
    channel: item.snippet.channelTitle,
    published_at: item.snippet.publishedAt,
  }));
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!YOUTUBE_API_KEY) {
    return NextResponse.json({ error: "YouTube API not configured" }, { status: 500 });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  const results: Record<string, number> = {};

  for (const [team, query] of Object.entries(QUERIES)) {
    try {
      const videos = await fetchYouTube(query);
      if (videos.length > 0) {
        await supabase.from("highlights").delete().eq("team", team);
        await supabase.from("highlights").insert(
          videos.slice(0, 30).map((v: any) => ({ ...v, team }))
        );
      }
      results[team] = videos.length;
    } catch {
      results[team] = -1;
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  return NextResponse.json({ ok: true, timestamp: new Date().toISOString(), results });
}
