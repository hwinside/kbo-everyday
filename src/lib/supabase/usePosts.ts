"use client";

import { useEffect, useState, useCallback } from "react";
import { supabase } from "./client";
import { useAuth } from "./AuthContext";

export interface Post {
  id: number;
  author_id: string;
  board_type: string;
  board_id: string;
  title: string;
  content: string;
  image_urls: string[];
  like_count: number;
  comment_count: number;
  created_at: string;
  // joined
  nickname?: string;
  team_id?: number;
  grade?: string;
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
}

/** 게시글 목록 */
export function usePosts(boardType: string, boardId: string) {
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from("posts")
      .select("*, profiles(nickname, team_id, grade)")
      .eq("board_type", boardType)
      .eq("board_id", boardId)
      .order("created_at", { ascending: false })
      .limit(30);

    if (data) {
      setPosts(data.map((p: any) => ({
        ...p,
        image_urls: p.image_urls ?? [],
        nickname: p.profiles?.nickname,
        team_id: p.profiles?.team_id,
        grade: p.profiles?.grade,
      })));
    }
    setLoading(false);
  }, [boardType, boardId]);

  useEffect(() => { load(); }, [load]);

  return { posts, loading, reload: load };
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
          nickname: (p as any).profiles?.nickname,
          team_id: (p as any).profiles?.team_id,
          grade: (p as any).profiles?.grade,
        });
      }

      // 댓글
      const { data: c } = await supabase
        .from("comments")
        .select("*, profiles(nickname, team_id, grade)")
        .eq("post_id", postId)
        .order("created_at", { ascending: true });

      if (c) {
        setComments(c.map((cm: any) => ({
          ...cm,
          nickname: cm.profiles?.nickname,
          team_id: cm.profiles?.team_id,
          grade: cm.profiles?.grade,
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
}) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("로그인 필요");

  const { data, error } = await supabase
    .from("posts")
    .insert({
      author_id: user.id,
      board_type: params.boardType,
      board_id: params.boardId,
      title: params.title,
      content: params.content,
      image_urls: params.imageUrls ?? [],
    })
    .select()
    .single();

  if (error) throw error;
  return data;
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
