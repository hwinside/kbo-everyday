import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { isAdminAuthedRequest } from "@/lib/admin/pin";

/**
 * GET /api/admin/today-detail?type=posts|comments|photos|chats|venue_videos|venue_photos
 * 오늘 KST 기준 상세 목록 반환
 */

/** teamId(1-10) ↔ KBO 2자 코드 → 짧은 팀명. gameId(YYYYMMDD{AWAY}{HOME}N) 라벨용. */
const KBO_CODE_TO_SHORT: Record<string, string> = {
  LG: "LG", OB: "두산", KT: "KT", SK: "SSG", NC: "NC",
  HT: "KIA", LT: "롯데", SS: "삼성", HH: "한화", WO: "키움",
};

/** gameId → "7.26 한화 vs LG"처럼 사람이 읽는 경기 라벨. 파싱 실패 시 원본 gameId. */
function gameLabel(gameId: string, stadium?: string | null): string {
  const m = gameId.match(/^(\d{4})(\d{2})(\d{2})([A-Z]{2})([A-Z]{2})\d$/);
  if (!m) return stadium ? `${gameId} · ${stadium}` : gameId;
  const [, , mo, d, away, home] = m;
  const awayName = KBO_CODE_TO_SHORT[away] ?? away;
  const homeName = KBO_CODE_TO_SHORT[home] ?? home;
  const dateStr = `${Number(mo)}.${Number(d)}`;
  const base = `${dateStr} ${awayName} vs ${homeName}`;
  return stadium ? `${base} · ${stadium}` : base;
}

function postLink(boardType: unknown, boardId: unknown, postId: unknown, newsUrl?: string): string {
  if (boardType === "announcement") return "/whats-new"; // 새소식 댓글용 브리지 포스트
  if (boardType === "news") return newsUrl || "/";
  if (boardType === "free") return `/community/free/${postId}`;
  if (boardType === "player") return `/community/players/${boardId}/posts/${postId}`;
  return `/community/teams/${boardId}/posts/${postId}`;
}

function topAuthors(items: { nickname: string }[], limit = 5) {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item.nickname, (counts.get(item.nickname) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([nickname, count]) => ({ nickname, count }));
}

function getTodayKSTRange() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const dateStr = kst.toISOString().slice(0, 10);
  return {
    start: `${dateStr}T00:00:00+09:00`,
    end: `${dateStr}T23:59:59+09:00`,
  };
}

export async function GET(req: NextRequest) {
  if (!(await isAdminAuthedRequest(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const type = req.nextUrl.searchParams.get("type");
  if (!type || !["posts", "comments", "photos", "chats", "venue_videos", "venue_photos"].includes(type)) {
    return NextResponse.json({ error: "invalid type" }, { status: 400 });
  }

  const { start, end } = getTodayKSTRange();

  if (type === "posts") {
    const { data, error } = await supabase
      .from("posts")
      .select("id, title, content, content_type, board_type, board_id, created_at, author_id, profiles(nickname)")
      .neq("content_type", "photo")
      .neq("board_type", "announcement")
      .neq("board_type", "news") // 댓글용 브리지 포스트 제외
      .gte("created_at", start)
      .lte("created_at", end)
      .order("created_at", { ascending: false })
      .limit(100);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const items = (data ?? []).map((p: Record<string, unknown>) => ({
      id: p.id,
      time: p.created_at,
      nickname: (p.profiles as { nickname?: string } | null)?.nickname ?? "익명",
      title: p.title || "(제목 없음)",
      content: typeof p.content === "string" ? p.content : "",
      link: postLink(p.board_type, p.board_id, p.id),
    }));

    return NextResponse.json({ items, topAuthors: topAuthors(items) });
  }

  if (type === "comments") {
    // 댓글 + 작성자 닉네임 + 원글 정보 조회
    const { data, error } = await supabase
      .from("comments")
      .select("id, content, post_id, created_at, author_id")
      .gte("created_at", start)
      .lte("created_at", end)
      .order("created_at", { ascending: false })
      .limit(100);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // 별도로 프로필과 원글 정보 조회
    const authorIds = [...new Set((data ?? []).map((c: { author_id: string }) => c.author_id))];
    const postIds = [...new Set((data ?? []).map((c: { post_id: number }) => c.post_id))];

    const [profilesRes, postsRes, newsRes] = await Promise.all([
      authorIds.length > 0
        ? supabase.from("profiles").select("id, nickname").in("id", authorIds)
        : { data: [] },
      postIds.length > 0
        ? supabase.from("posts").select("id, board_type, board_id").in("id", postIds)
        : { data: [] },
      postIds.length > 0
        ? supabase.from("news_discussions").select("post_id, canonical_url").in("post_id", postIds)
        : { data: [] },
    ]);

    const profileMap = new Map((profilesRes.data ?? []).map((p: { id: string; nickname: string }) => [p.id, p.nickname]));
    const postMap = new Map((postsRes.data ?? []).map((p: { id: number; board_type: string; board_id: string }) => [p.id, p]));
    const newsUrlMap = new Map((newsRes.data ?? []).map((n: { post_id: number; canonical_url: string }) => [n.post_id, n.canonical_url]));

    const items = (data ?? []).map((c: { id: number; content: string; post_id: number; created_at: string; author_id: string }) => {
      const post = postMap.get(c.post_id);
      return {
        id: c.id,
        time: c.created_at,
        nickname: profileMap.get(c.author_id) ?? "익명",
        title: "",
        content: c.content ?? "",
        link: post
          ? postLink(post.board_type, post.board_id, c.post_id, newsUrlMap.get(c.post_id))
          : "",
      };
    });

    return NextResponse.json({ items, topAuthors: topAuthors(items) });
  }

  if (type === "photos") {
    const { data, error } = await supabase
      .from("posts")
      .select("id, title, content, board_type, board_id, created_at, image_urls, author_id, profiles(nickname)")
      .eq("content_type", "photo")
      .gte("created_at", start)
      .lte("created_at", end)
      .order("created_at", { ascending: false })
      .limit(100);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const items = (data ?? []).map((p: Record<string, unknown>) => ({
      id: p.id,
      time: p.created_at,
      nickname: (p.profiles as { nickname?: string } | null)?.nickname ?? "익명",
      title: p.title || "(사진)",
      content: typeof p.content === "string" ? p.content : "",
      link: postLink(p.board_type, p.board_id, p.id),
      imageUrls: (p.image_urls as string[]) ?? [],
    }));

    return NextResponse.json({ items, topAuthors: topAuthors(items) });
  }

  if (type === "chats") {
    const { data, error } = await supabase
      .from("chat_messages")
      .select("id, content, room_id, created_at, user_id, profiles!user_id(nickname)")
      .gte("created_at", start)
      .lte("created_at", end)
      .order("created_at", { ascending: false })
      .limit(200);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const items = (data ?? []).map((m: Record<string, unknown>) => {
      // room_id format: "game:{gameId}" or "game:{gameId}:{home|away}"
      const roomId = String(m.room_id ?? "");
      const gameIdMatch = roomId.match(/^game:(.+?)(?::(home|away))?$/);
      const gameId = gameIdMatch ? gameIdMatch[1] : "";
      return {
        id: m.id,
        time: m.created_at,
        nickname: (m.profiles as { nickname?: string } | null)?.nickname ?? "익명",
        title: "",
        content: typeof m.content === "string" ? m.content : "",
        link: gameId ? `/games/${gameId}` : "",
      };
    });

    return NextResponse.json({ items, topAuthors: topAuthors(items) });
  }

  if (type === "venue_videos" || type === "venue_photos") {
    const mediaType = type === "venue_videos" ? "video" : "image";
    // query-guard: bounded -- 오늘 KST 범위(created_at gte/lte) + media_type 필터, created_at desc 고정 200건 상한(페이지네이션 없음).
    const { data, error } = await supabase
      .from("venue_stories")
      .select("id, game_id, media_type, media_url, thumb_url, caption, stadium_name, created_at, user_id")
      .eq("media_type", mediaType)
      .gte("created_at", start)
      .lte("created_at", end)
      .order("created_at", { ascending: false })
      .limit(200);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const rows = data ?? [];
    const userIds = [...new Set(rows.map((r: { user_id: string }) => r.user_id))];
    const nickMap = new Map<string, string>();
    if (userIds.length > 0) {
      // query-guard: bounded -- rows≤200의 distinct user_id(≤200) unique-key(id) 조회.
      const { data: profiles } = await supabase
        .from("profiles")
        .select("id, nickname")
        .in("id", userIds);
      for (const p of (profiles ?? []) as { id: string; nickname: string }[]) {
        nickMap.set(p.id, p.nickname ?? "익명");
      }
    }

    const items = rows.map((r: Record<string, unknown>) => {
      const gameId = String(r.game_id ?? "");
      const label = gameLabel(gameId, r.stadium_name as string | null);
      const caption = typeof r.caption === "string" && r.caption ? r.caption : "";
      // 미리보기: 영상은 thumb_url 우선(없으면 생략), 사진은 media_url.
      const preview =
        mediaType === "video"
          ? (r.thumb_url as string | null) ?? null
          : (r.media_url as string | null) ?? null;
      return {
        id: r.id as number,
        time: r.created_at as string,
        nickname: nickMap.get(r.user_id as string) ?? "익명",
        title: label,
        content: caption,
        link: gameId ? `/games/${gameId}` : "",
        imageUrls: preview ? [preview] : [],
      };
    });

    return NextResponse.json({ items, topAuthors: topAuthors(items) });
  }

  return NextResponse.json({ items: [], topAuthors: [] });
}
