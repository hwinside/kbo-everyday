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
  video_urls?: string[];
  like_count: number;
  comment_count: number;
  created_at: string;
  updated_at?: string | null;
  // meme editor fields
  game_id?: string | null;
  player_tags?: string[];
  hashtags?: string[];
  seat_info?: { zone: string; block?: string; row?: string; seat?: string } | null;
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
  updated_at?: string | null;
  parent_id?: number | null;
  like_count?: number;
  liked_by_me?: boolean;
  nickname?: string;
  team_id?: number;
  grade?: string;
  avatar_url?: string;
  replies?: Comment[];
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
        .select("id, author_id, board_type, board_id, content_type, title, content, image_urls, video_urls, like_count, comment_count, created_at, is_hidden, game_id, player_tags, hashtags, author_team_id_snapshot, profiles(nickname, team_id, grade, points)")
        .eq("board_type", boardType)
        .eq("board_id", boardId)
        .eq("content_type", contentType)
        .neq("is_hidden", true)
        .order("created_at", { ascending: false })
        .limit(30);

      if (cancelled) return;
      if (data) {
        setPosts(data.map((p) => {
          const prof = p.profiles as unknown as Record<string, unknown> | null;
          const snap = (p as Record<string, unknown>).author_team_id_snapshot as number | null | undefined;
          return {
            ...p,
            content_type: (p.content_type ?? "general") as "general" | "photo",
            image_urls: (p.image_urls ?? []) as string[],
            video_urls: ((p as Record<string, unknown>).video_urls ?? []) as string[],
            nickname: prof?.nickname as string | undefined,
            team_id: (snap ?? (prof?.team_id as number | undefined)) as number | undefined,
            grade: prof?.grade as string | undefined,
            points: (prof?.points as number) ?? 0,
          };
        }));
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
      .select("id, author_id, board_type, board_id, content_type, title, content, image_urls, video_urls, like_count, comment_count, created_at, is_hidden, game_id, player_tags, hashtags, author_team_id_snapshot, profiles(nickname, team_id, grade, points)")
      .eq("board_type", boardType)
      .eq("board_id", boardId)
      .eq("content_type", contentType)
      .neq("is_hidden", true)
      .order("created_at", { ascending: false })
      .limit(30);

    if (data) {
      setPosts(data.map((p) => {
        const prof = p.profiles as unknown as Record<string, unknown> | null;
        const snap = (p as Record<string, unknown>).author_team_id_snapshot as number | null | undefined;
        return {
          ...p,
          content_type: (p.content_type ?? "general") as "general" | "photo",
          image_urls: (p.image_urls ?? []) as string[],
          video_urls: ((p as Record<string, unknown>).video_urls ?? []) as string[],
          nickname: prof?.nickname as string | undefined,
          team_id: (snap ?? (prof?.team_id as number | undefined)) as number | undefined,
          grade: prof?.grade as string | undefined,
          points: (prof?.points as number) ?? 0,
        };
      }));
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
        const prof = p.profiles as unknown as Record<string, unknown> | null;
        const snap = (p as Record<string, unknown>).author_team_id_snapshot as number | null | undefined;
        setPost({
          ...p,
          image_urls: p.image_urls ?? [],
          video_urls: (p as Record<string, unknown>).video_urls as string[] ?? [],
          nickname: prof?.nickname as string | undefined,
          team_id: (snap ?? (prof?.team_id as number | undefined)) as number | undefined,
          grade: prof?.grade as string | undefined,
        });
      }

      // 댓글
      const { data: c } = await supabase
        .from("comments")
        .select("*, profiles!comments_author_id_fkey(nickname, team_id, grade, avatar_url)")
        .eq("post_id", postId)
        .order("created_at", { ascending: true });

      // 내가 좋아요한 댓글 ID 목록
      let myCommentLikeIds: Set<number> = new Set();
      if (user && c?.length) {
        const { data: cls } = await supabase
          .from("comment_likes")
          .select("comment_id")
          .eq("user_id", user.id)
          .in("comment_id", c.map((cm) => cm.id));
        if (cls) myCommentLikeIds = new Set(cls.map((cl: { comment_id: number }) => cl.comment_id));
      }

      if (c) {
        setComments(c.map((cm) => ({
          ...cm,
          nickname: (cm.profiles as unknown as Record<string, unknown> | null)?.nickname as string | undefined,
          team_id: (cm.profiles as unknown as Record<string, unknown> | null)?.team_id as number | undefined,
          grade: (cm.profiles as unknown as Record<string, unknown> | null)?.grade as string | undefined,
          avatar_url: (cm.profiles as unknown as Record<string, unknown> | null)?.avatar_url as string | undefined,
          liked_by_me: myCommentLikeIds.has(cm.id),
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
  videoUrls?: string[];
  imageHashes?: string[];
  contentType?: "general" | "photo";
  gameId?: string;
  teamTags?: string[];
  playerTags?: string[];
  hashtags?: string[];
  seatInfo?: { zone: string; block?: string; row?: string; seat?: string };
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
    video_urls: params.videoUrls ?? [],
    image_hashes: params.imageHashes ?? [],
    // 태그 기반(V3): 팀태그 배열. board_type/board_id는 레거시 호환용으로 계속 채움.
    team_tags: params.teamTags ?? [],
  };

  if (params.gameId) row.game_id = params.gameId;
  if (params.playerTags?.length) row.player_tags = params.playerTags;
  if (params.hashtags?.length) row.hashtags = params.hashtags;
  if (params.seatInfo) row.seat_info = params.seatInfo;

  const { data, error } = await supabase
    .from("posts")
    .insert(row)
    .select()
    .single();

  if (error) throw error;

  // 초대 활성화 체크 (fire-and-forget)
  const { data: { session } } = await supabase.auth.getSession();
  fetch("/api/invite/activate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
    },
  }).catch(() => {});

  return data;
}

/** 게시글 수정 (본인만)
 *  v1: title/content만 수정. 이미지/태그 재편집은 v2.
 */
export async function updatePost(
  postId: number,
  params: {
    title?: string;
    content?: string;
    imageUrls?: string[];
    seatInfo?: { zone: string; block?: string; row?: string; seat?: string } | null;
  },
) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("로그인 필요");

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof params.title === "string") {
    // 제목 필드 제거(⑥) → 빈 제목 허용(제목을 본문으로 흡수하며 비우는 케이스).
    patch.title = params.title.trim();
  }
  if (typeof params.content === "string") {
    patch.content = params.content; // trim은 UI에서 처리 (사진게시법은 빈 content 허용)
  }
  if (typeof params.imageUrls !== "undefined") {
    patch.image_urls = params.imageUrls; // 빈 배열로 전달 시 이미지 전체 제거
  }
  if (typeof params.seatInfo !== "undefined") {
    patch.seat_info = params.seatInfo; // null 허용 (좌석정보 해제)
  }

  const { error } = await supabase
    .from("posts")
    .update(patch)
    .eq("id", postId)
    .eq("author_id", user.id);

  if (error) throw error;
}

/** 게시글 삭제 (본인만)
 *  CASCADE로 comments/likes 자동 삭제.
 *  v1: Storage 이미지/비디오는 고아로 남김 (정리는 별도 cron/v2).
 */
export async function deletePost(postId: number) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("로그인 필요");

  const { error } = await supabase
    .from("posts")
    .delete()
    .eq("id", postId)
    .eq("author_id", user.id);

  if (error) throw error;
}

/** 이미지 업로드 (Supabase Storage) */
async function computeFileHash(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function uploadImages(files: File[]): Promise<string[]> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("로그인 필요");

  // 중복 이미지 검사: 같은 유저가 최근 올린 동일 해시 차단
  const hashes: string[] = [];
  for (const file of files) {
    const hash = await computeFileHash(file);
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: existing } = await supabase
      .from("posts")
      .select("id")
      .eq("author_id", user.id)
      .contains("image_hashes", [hash])
      .gte("created_at", since)
      .limit(1);
    if (existing && existing.length > 0) {
      throw new Error("이미 올린 사진이에요");
    }
    hashes.push(hash);
  }

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

/** 업로드된 이미지들의 해시 계산 (createPost에서 사용) */
export async function computeImageHashes(files: File[]): Promise<string[]> {
  return Promise.all(files.map(computeFileHash));
}

/** 동영상 업로드 (Supabase Storage — videos 버킷) */
export async function uploadVideos(files: File[]): Promise<string[]> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("로그인 필요");

  const urls: string[] = [];
  for (const file of files) {
    const ext = file.name.split(".").pop() || "mp4";
    const path = `${user.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

    const { error } = await supabase.storage
      .from("videos")
      .upload(path, file, { contentType: file.type });

    if (error) throw error;

    const { data: urlData } = supabase.storage
      .from("videos")
      .getPublicUrl(path);

    urls.push(urlData.publicUrl);
  }
  return urls;
}

/** 댓글 수정 (본인만) */
export async function updateComment(commentId: number, content: string) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("로그인 필요");

  const trimmed = content.trim();
  if (!trimmed) throw new Error("빈 댓글");

  const { error } = await supabase
    .from("comments")
    .update({ content: trimmed, updated_at: new Date().toISOString() })
    .eq("id", commentId)
    .eq("author_id", user.id); // RLS + client-side 이중 가드

  if (error) throw error;
}

/** 댓글 삭제 (본인만) */
export async function deleteComment(commentId: number) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("로그인 필요");

  const { error } = await supabase
    .from("comments")
    .delete()
    .eq("id", commentId)
    .eq("author_id", user.id);

  if (error) throw error;
}

/** 댓글 작성 (대댓글: parentId 지정) */
export async function createComment(postId: number, content: string, parentId?: number | null) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("로그인 필요");

  const { data, error } = await supabase.from("comments").insert({
    post_id: postId,
    author_id: user.id,
    content,
    ...(parentId ? { parent_id: parentId } : {}),
  }).select("id").single();

  if (error) throw error;

  // 초대 활성화 체크 (fire-and-forget)
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  fetch("/api/invite/activate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  }).catch(() => {});

  return data!;
}

/** 댓글 좋아요 토글 */
export async function toggleCommentLike(commentId: number): Promise<boolean> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("로그인 필요");

  const { data: existing } = await supabase
    .from("comment_likes")
    .select("comment_id")
    .eq("comment_id", commentId)
    .eq("user_id", user.id)
    .single();

  if (existing) {
    await supabase.from("comment_likes").delete()
      .eq("comment_id", commentId)
      .eq("user_id", user.id);
    return false;
  } else {
    await supabase.from("comment_likes").insert({ comment_id: commentId, user_id: user.id });
    return true;
  }
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
