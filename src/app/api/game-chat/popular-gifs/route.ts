import { NextResponse } from "next/server";
import { unstable_cache } from "next/cache";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { normalizePopularGiphyIds } from "@/lib/community/giphy";

// Cache only our aggregate GIF IDs. No GIPHY response, URL or media is fetched
// or retained here; the browser resolves IDs directly against GIPHY each time.
const getPopularIds = unstable_cache(async () => {
  // query-guard: bounded -- SQL aggregates the full 30-day window and returns
  // at most 24 IDs (no PostgREST 1,000-row sample truncation).
  const { data, error } = await getSupabaseAdmin()
    .rpc("popular_game_chat_giphy_ids")
    .abortSignal(AbortSignal.timeout(4_000));
  if (error || !Array.isArray(data)) throw new Error("Popular GIF IDs unavailable");
  return normalizePopularGiphyIds(data.map((row: { gif_id: unknown }) => row.gif_id));
}, ["game-chat-popular-giphy-ids-v1"], { revalidate: 300 });

export async function GET() {
  try {
    return NextResponse.json({ ids: await getPopularIds() }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    // Missing migration/DB failure is not cached as real popularity.
    return NextResponse.json({ error: "popular_gifs_unavailable" }, {
      status: 503, headers: { "Cache-Control": "no-store" },
    });
  }
}
