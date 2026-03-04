// @ts-nocheck
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || "";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const CRON_SECRET = process.env.CRON_SECRET || "";

const TEAM_NAMES: Record<string, string> = {
  LG: "LG 트윈스", "두산": "두산 베어스", KT: "KT 위즈", SSG: "SSG 랜더스",
  NC: "NC 다이노스", KIA: "KIA 타이거즈", "삼성": "삼성 라이온즈",
  "롯데": "롯데 자이언츠", "한화": "한화 이글스", "키움": "키움 히어로즈",
};

const FALLBACK_STARS: Record<string, string[]> = {
  LG: ["박해민", "문보경", "홍창기"],
  "두산": ["양의지", "허경민", "박찬호"],
  KT: ["강백호", "소형준", "쿠에바스"],
  SSG: ["최정", "추신수", "김광현"],
  NC: ["박건우", "구창모", "손아섭"],
  KIA: ["김도영", "나성범", "양현종"],
  "삼성": ["구자욱", "김영웅", "원태인"],
  "롯데": ["전준우", "한동희", "박세웅"],
  "한화": ["노시환", "문동주", "채은성"],
  "키움": ["이형종", "안우진", "하영민"],
};

function decodeHtml(s: string) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

async function fetchYouTube(query: string, maxResults = 20) {
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=${maxResults}&order=date&videoDuration=short&videoEmbeddable=true&key=${YOUTUBE_API_KEY}`;
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

async function getStarPlayers(supabase: ReturnType<typeof createClient>, team: string): Promise<string[]> {
  const { data } = await supabase.from("team_stars").select("players").eq("team", team).single() as any;
  if (data?.players?.length > 0) return data.players;
  return FALLBACK_STARS[team] || [];
}

async function updateStarsFromStats(supabase: ReturnType<typeof createClient>) {
  try {
    const res = await fetch(
      "https://www.koreabaseball.com/ws/Main.asmx/GetKboPlayerRankByBackUp?leagueId=1&playerId=0&gameFlag=1&sortKey=HRA&teamId=0",
      { signal: AbortSignal.timeout(5000) }
    );
    const text = await res.text();
    if (!text.includes("<PlayerName>")) return;

    const re = /<PlayerName>([^<]+)<\/PlayerName>[\s\S]*?<TeamName>([^<]+)<\/TeamName>/g;
    const tp: Record<string, string[]> = {};
    let m;
    while ((m = re.exec(text)) !== null) {
      const name = m[1];
      const teamName = m[2];
      const tk = Object.entries(TEAM_NAMES).find(([, v]) => v.includes(teamName))?.[0];
      if (tk) {
        if (!tp[tk]) tp[tk] = [];
        if (tp[tk].length < 3) tp[tk].push(name);
      }
    }

    for (const [team, players] of Object.entries(tp)) {
      if (players.length > 0) {
        await supabase.from("team_stars").upsert<any>(
          { team, players, updated_at: new Date().toISOString() },
          { onConflict: "team" }
        );
      }
    }
  } catch {
    // fallback maintained
  }
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

  await updateStarsFromStats(supabase);

  for (const [team, fullName] of Object.entries(TEAM_NAMES)) {
    try {
      const stars = await getStarPlayers(supabase, team);
      const [teamVids, starVids] = await Promise.all([
        fetchYouTube(`${fullName} 하이라이트`, 15).catch(() => [] as any[]),
        fetchYouTube(`${team} ${stars.join(" ")}`, 15).catch(() => [] as any[]),
      ]);

      const seen = new Set<string>();
      const all = [...teamVids, ...starVids].filter((v) => {
        if (seen.has(v.video_id)) return false;
        seen.add(v.video_id);
        return true;
      });

      if (all.length > 0) {
        await supabase.from("highlights").delete<any>().eq("team", team);
        await supabase.from("highlights").insert<any>(
          all.slice(0, 30).map((v) => ({ ...v, team }))
        );
      }
      results[team] = all.length;
    } catch {
      results[team] = -1;
    }

    await new Promise((r) => setTimeout(r, 500));
  }

  return NextResponse.json({
    ok: true,
    timestamp: new Date().toISOString(),
    results,
  });
}
