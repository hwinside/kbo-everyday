import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { isAdminRequest } from "@/lib/admin/pin";

/**
 * GET /api/admin/today-detail?type=posts|comments|photos|chats
 * 오늘 KST 기준 상세 목록 반환
 */

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
  if (!isAdminRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const type = req.nextUrl.searchParams.get("type");
  if (!type || !["posts", "comments", "photos", "chats"].includes(type)) {
    return NextResponse.json({ error: "invalid type" }, { status: 400 });
  }

  const { start, end } = getTodayKSTRange();

  if (type === "posts") {
    const { data, error } = await supabase
      .from("posts")
      .select("id, title, content, content_type, board_type, board_id, created_at, author_id, profiles(nickname)")
      .neq("content_type", "photo")
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
      link: `/community/${p.board_type === "player" ? "players" : "teams"}/${p.board_id}/posts/${p.id}`,
    }));

    return NextResponse.json({ items });
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

    const [profilesRes, postsRes] = await Promise.all([
      authorIds.length > 0
        ? supabase.from("profiles").select("id, nickname").in("id", authorIds)
        : { data: [] },
      postIds.length > 0
        ? supabase.from("posts").select("id, board_type, board_id").in("id", postIds)
        : { data: [] },
    ]);

    const profileMap = new Map((profilesRes.data ?? []).map((p: { id: string; nickname: string }) => [p.id, p.nickname]));
    const postMap = new Map((postsRes.data ?? []).map((p: { id: number; board_type: string; board_id: string }) => [p.id, p]));

    const items = (data ?? []).map((c: { id: number; content: string; post_id: number; created_at: string; author_id: string }) => {
      const post = postMap.get(c.post_id);
      return {
        id: c.id,
        time: c.created_at,
        nickname: profileMap.get(c.author_id) ?? "익명",
        title: "",
        content: c.content ?? "",
        link: post
          ? `/community/${post.board_type === "player" ? "players" : "teams"}/${post.board_id}/posts/${c.post_id}`
          : "",
      };
    });

    return NextResponse.json({ items });
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
      link: `/community/${p.board_type === "player" ? "players" : "teams"}/${p.board_id}/posts/${p.id}`,
      imageUrls: (p.image_urls as string[]) ?? [],
    }));

    return NextResponse.json({ items });
  }

  if (type === "chats") {
    const { data, error } = await supabase
      .from("chat_messages")
      .select("id, content, room_id, created_at, user_id, profiles(nickname)")
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
        link: gameId ? `/game/${gameId}` : "",
      };
    });

    return NextResponse.json({ items });
  }

  return NextResponse.json({ items: [] });
}
