import { NextRequest, NextResponse } from "next/server";
import type { PostgrestError } from "@supabase/supabase-js";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { supabaseErrorResponse } from "@/lib/supabase/error";
import { isAdminRequest } from "@/lib/admin/pin";
import { getKSTToday, toKSTDateString } from "@/lib/utils/date-kst";

function verifyPin(req: NextRequest): boolean {
  return isAdminRequest(req);
}

// Supabase는 쿼리당 최대 1000행만 반환 → 초과분은 range 페이지네이션으로 수집
const PAGE_SIZE = 1000;

async function fetchAllRows<T>(
  makePage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: PostgrestError | null }>,
): Promise<{ data: T[]; error: PostgrestError | null }> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await makePage(from, from + PAGE_SIZE - 1);
    if (error) return { data: rows, error };
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) return { data: rows, error: null };
  }
}

export async function GET(req: NextRequest) {
  if (!verifyPin(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const days = Number(req.nextUrl.searchParams.get("days") ?? "30");
  const todayKST = getKSTToday();
  const sinceDate = new Date(new Date(todayKST + "T00:00:00+09:00").getTime() - days * 86400000);
  const since = sinceDate.toISOString().slice(0, 10);

  // Posts
  const { data: posts, error: postsError } = await fetchAllRows((from, to) =>
    supabase
      .from("posts")
      .select("created_at, content_type, board_id, author_id")
      .neq("board_type", "announcement") // 새소식 댓글용 브리지 포스트 제외
      .gte("created_at", since)
      .order("created_at", { ascending: true })
      .range(from, to),
  );

  if (postsError) return supabaseErrorResponse(postsError);

  // Comments
  const { data: comments, error: commentsError } = await fetchAllRows((from, to) =>
    supabase
      .from("comments")
      .select("created_at, author_id")
      .gte("created_at", since)
      .order("created_at", { ascending: true })
      .range(from, to),
  );

  if (commentsError) return supabaseErrorResponse(commentsError);

  // 크관(경기 중계) 채팅: room_id LIKE 'game:%'
  const { data: chats, error: chatsError } = await fetchAllRows((from, to) =>
    supabase
      .from("chat_messages")
      .select("created_at, user_id")
      .like("room_id", "game:%")
      .gte("created_at", since)
      .order("created_at", { ascending: true })
      .range(from, to),
  );

  if (chatsError) return supabaseErrorResponse(chatsError);

  // 게시글 좋아요
  const { data: likes, error: likesError } = await fetchAllRows((from, to) =>
    supabase
      .from("likes")
      .select("created_at, user_id")
      .gte("created_at", since)
      .order("created_at", { ascending: true })
      .range(from, to),
  );

  if (likesError) return supabaseErrorResponse(likesError);

  // Daily aggregation (counts + unique users)
  interface DailyEntry {
    posts: number; comments: number; photos: number; chats: number; likes: number;
    postUsers: Set<string>; generalPostUsers: Set<string>; commentUsers: Set<string>;
    photoUsers: Set<string>; chatUsers: Set<string>; likeUsers: Set<string>;
  }
  const dailyMap = new Map<string, DailyEntry>();

  const makeEntry = (): DailyEntry => ({
    posts: 0, comments: 0, photos: 0, chats: 0, likes: 0,
    postUsers: new Set(), generalPostUsers: new Set(), commentUsers: new Set(),
    photoUsers: new Set(), chatUsers: new Set(), likeUsers: new Set(),
  });

  for (const post of posts ?? []) {
    const date = toKSTDateString(post.created_at);
    const entry = dailyMap.get(date) ?? makeEntry();
    entry.posts += 1;
    if (post.author_id) entry.postUsers.add(post.author_id);
    if (post.content_type === "photo") {
      entry.photos += 1;
      if (post.author_id) entry.photoUsers.add(post.author_id);
    } else {
      if (post.author_id) entry.generalPostUsers.add(post.author_id);
    }
    dailyMap.set(date, entry);
  }

  for (const comment of comments ?? []) {
    const date = toKSTDateString(comment.created_at);
    const entry = dailyMap.get(date) ?? makeEntry();
    entry.comments += 1;
    if (comment.author_id) entry.commentUsers.add(comment.author_id);
    dailyMap.set(date, entry);
  }

  for (const chat of chats ?? []) {
    const date = toKSTDateString(chat.created_at);
    const entry = dailyMap.get(date) ?? makeEntry();
    entry.chats += 1;
    if (chat.user_id) entry.chatUsers.add(chat.user_id);
    dailyMap.set(date, entry);
  }

  for (const like of likes ?? []) {
    const date = toKSTDateString(like.created_at);
    const entry = dailyMap.get(date) ?? makeEntry();
    entry.likes += 1;
    if (like.user_id) entry.likeUsers.add(like.user_id);
    dailyMap.set(date, entry);
  }

  const dailyPosts = Array.from(dailyMap.entries())
    .map(([date, e]) => ({
      date,
      posts: e.posts, comments: e.comments, photos: e.photos, chats: e.chats, likes: e.likes,
      postUserCount: e.postUsers.size, generalPostUserCount: e.generalPostUsers.size,
      commentUserCount: e.commentUsers.size, photoUserCount: e.photoUsers.size,
      chatUserCount: e.chatUsers.size, likeUserCount: e.likeUsers.size,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Popular posts top 10
  const { data: popularPosts, error: popularError } = await supabase
    .from("posts")
    .select("id, title, board_id, board_type, like_count, comment_count, created_at, image_urls")
    .neq("board_type", "announcement") // 새소식 댓글용 브리지 포스트 제외
    .order("like_count", { ascending: false })
    .limit(10);

  if (popularError) return supabaseErrorResponse(popularError);

  // Team activity: count posts grouped by board_id
  const boardMap = new Map<string, number>();
  for (const post of posts ?? []) {
    const key = post.board_id;
    boardMap.set(key, (boardMap.get(key) ?? 0) + 1);
  }
  const teamActivity = Array.from(boardMap.entries()).map(
    ([board_id, count]) => ({ board_id, count }),
  );

  return NextResponse.json({
    dailyPosts,
    popularPosts,
    teamActivity,
  });
}
