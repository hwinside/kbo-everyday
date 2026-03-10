"use client";

import { useEffect, useState, useCallback } from "react";
import { supabase } from "./client";
import { useAuth } from "./AuthContext";

export interface Post {
  id: number;
  author_id: string;
  board_type: string;
  board_id: string;
  content_type: "general" | "photo";
  title: string;
  content: string;
  image_urls: string[];
  like_count: number;
  comment_count: number;
  created_at: string;
  // meme editor fields
  game_id?: string | null;
  player_tags?: string[];
  hashtags?: string[];
  // joined
  nickname?: string;
  team_id?: number;
  grade?: string;
  points?: number;
}

export interface Comment {
  id: number;
  post_id: number;
  author_id: string;
  content: string;
  created_at: string;
  nickname?: string;
  team_id?: number;
  grade?: string;
  avatar_url?: string;
}

/** 게시글 목록 */
export function usePosts(boardType: string, boardId: string, contentType: "general" | "photo" = "general") {
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function fetchPosts() {
      setLoading(true);
      const { data } = await supabase
        .from("posts")
        .select("id, author_id, board_type, board_id, content_type, title, content, image_urls, like_count, comment_count, created_at, is_hidden, game_id, player_tags, hashtags, profiles(nickname, team_id, grade, points)")
        .eq("board_type", boardType)
        .eq("board_id", boardId)
        .eq("content_type", contentType)
        .neq("is_hidden", true)
        .order("created_at", { ascending: false })
        .limit(30);

      if (cancelled) return;
      if (data) {
        setPosts(data.map((p) => ({
          ...p,
          content_type: (p.content_type ?? "general") as "general" | "photo",
          image_urls: (p.image_urls ?? []) as string[],
          nickname: (p.profiles as unknown as Record<string, unknown> | null)?.nickname as string | undefined,
          team_id: (p.profiles as unknown as Record<string, unknown> | null)?.team_id as number | undefined,
          grade: (p.profiles as unknown as Record<string, unknown> | null)?.grade as string | undefined,
          points: ((p.profiles as unknown as Record<string, unknown> | null)?.points as number) ?? 0,
        })));
      }
      setLoading(false);
    }

    fetchPosts();
    return () => { cancelled = true; };
  }, [boardType, boardId, contentType]);

  const reload = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from("posts")
      .select("id, author_id, board_type, board_id, content_type, title, content, image_urls, like_count, comment_count, created_at, is_hidden, game_id, player_tags, hashtags, profiles(nickname, team_id, grade, points)")
      .eq("board_type", boardType)
      .eq("board_id", boardId)
      .eq("content_type", contentType)
      .neq("is_hidden", true)
      .order("created_at", { ascending: false })
      .limit(30);

    if (data) {
      setPosts(data.map((p) => ({
        ...p,
        content_type: (p.content_type ?? "general") as "general" | "photo",
        image_urls: (p.image_urls ?? []) as string[],
        nickname: (p.profiles as unknown as Record<string, unknown> | null)?.nickname as string | undefined,
        team_id: (p.profiles as unknown as Record<string, unknown> | null)?.team_id as number | undefined,
        grade: (p.profiles as unknown as Record<string, unknown> | null)?.grade as string | undefined,
        points: ((p.profiles as unknown as Record<string, unknown> | null)?.points as number) ?? 0,
      })));
    }
    setLoading(false);
  }, [boardType, boardId, contentType]);

  return { posts, loading, reload };
}

/** 게시글 상세 + 댓글 */
export function usePostDetail(postId: number) {
  const [post, setPost] = useState<Post | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(true);
  const [liked, setLiked] = useState(false);
  const { user } = useAuth();

  useEffect(() => {
    async function load() {
      // 게시글
      const { data: p } = await supabase
        .from("posts")
        .select("*, profiles(nickname, team_id, grade)")
        .eq("id", postId)
        .single();

      if (p) {
        setPost({
          ...p,
          image_urls: p.image_urls ?? [],
          nickname: (p.profiles as unknown as Record<string, unknown> | null)?.nickname as string | undefined,
          team_id: (p.profiles as unknown as Record<string, unknown> | null)?.team_id as number | undefined,
          grade: (p.profiles as unknown as Record<string, unknown> | null)?.grade as string | undefined,
        });
      }

      // 댓글
      const { data: c } = await supabase
        .from("comments")
        .select("*, profiles(nickname, team_id, grade, avatar_url)")
        .eq("post_id", postId)
        .order("created_at", { ascending: true });

      if (c) {
        setComments(c.map((cm) => ({
          ...cm,
          nickname: (cm.profiles as unknown as Record<string, unknown> | null)?.nickname as string | undefined,
          team_id: (cm.profiles as unknown as Record<string, unknown> | null)?.team_id as number | undefined,
          grade: (cm.profiles as unknown as Record<string, unknown> | null)?.grade as string | undefined,
          avatar_url: (cm.profiles as unknown as Record<string, unknown> | null)?.avatar_url as string | undefined,
        })));
      }

      // 좋아요 여부
      if (user) {
        const { data: like } = await supabase
          .from("likes")
          .select("id")
          .eq("post_id", postId)
          .eq("user_id", user.id)
          .single();
        setLiked(!!like);
      }

      setLoading(false);
    }
    load();
  }, [postId, user]);

  return { post, comments, loading, liked, setLiked, setComments };
}

/** 글 작성 */
export async function createPost(params: {
  boardType: string;
  boardId: string;
  title: string;
  content: string;
  imageUrls?: string[];
  contentType?: "general" | "photo";
  gameId?: string;
  playerTags?: string[];
  hashtags?: string[];
}) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("로그인 필요");

  const row: Record<string, unknown> = {
    author_id: user.id,
    board_type: params.boardType,
    board_id: params.boardId,
    content_type: params.contentType ?? "general",
    title: params.title,
    content: params.content,
    image_urls: params.imageUrls ?? [],
  };

  if (params.gameId) row.game_id = params.gameId;
  if (params.playerTags?.length) row.player_tags = params.playerTags;
  if (params.hashtags?.length) row.hashtags = params.hashtags;

  const { data, error } = await supabase
    .from("posts")
    .insert(row)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/** 이미지 업로드 (Supabase Storage) */
export async function uploadImages(files: File[]): Promise<string[]> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("로그인 필요");

  const urls: string[] = [];
  for (const file of files) {
    const ext = file.name.split(".").pop() || "jpg";
    const path = `${user.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

    const { error } = await supabase.storage
      .from("photos")
      .upload(path, file, { contentType: file.type });

    if (error) throw error;

    const { data: urlData } = supabase.storage
      .from("photos")
      .getPublicUrl(path);

    urls.push(urlData.publicUrl);
  }
  return urls;
}

/** 댓글 작성 */
export async function createComment(postId: number, content: string) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("로그인 필요");

  const { error } = await supabase.from("comments").insert({
    post_id: postId,
    author_id: user.id,
    content,
  });

  if (error) throw error;

}

/** 좋아요 토글 */
export async function toggleLike(postId: number): Promise<boolean> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("로그인 필요");

  // 이미 좋아요?
  const { data: existing } = await supabase
    .from("likes")
    .select("id")
    .eq("post_id", postId)
    .eq("user_id", user.id)
    .single();

  if (existing) {
    await supabase.from("likes").delete().eq("id", existing.id);

    return false;
  } else {
    await supabase.from("likes").insert({ post_id: postId, user_id: user.id });

    return true;
  }
}
