import type { Metadata } from "next";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

const SITE_ORIGIN = "https://keubo.fan";

export interface SharePost {
  id: number;
  boardType: string | null;
  boardId: string | null;
  contentType: "general" | "photo";
  title: string | null;
  content: string | null;
  imageUrls: string[];
  videoUrls: string[];
  isHidden: boolean;
  authorNickname: string | null;
  authorTeamId: number | null;
}

/**
 * 공유/OG 용도로 게시글 한 건을 서버에서 조회한다.
 * 숨김(is_hidden) 또는 없는 글은 null.
 */
export async function fetchSharePost(postId: number): Promise<SharePost | null> {
  if (!Number.isFinite(postId)) return null;
  try {
    const supabase = getSupabaseAdmin();
    const { data } = await supabase
      .from("posts")
      .select(
        "id, board_type, board_id, content_type, title, content, image_urls, video_urls, is_hidden, author_team_id_snapshot, profiles(nickname, team_id)"
      )
      .eq("id", postId)
      .single();

    if (!data) return null;

    const profile = (data as { profiles?: { nickname?: string | null; team_id?: number | null } | null }).profiles;
    const snapshotTeam = (data as { author_team_id_snapshot?: number | null }).author_team_id_snapshot;

    return {
      id: data.id as number,
      boardType: (data.board_type ?? null) as string | null,
      boardId: (data.board_id ?? null) as string | null,
      contentType: ((data.content_type ?? "general") as "general" | "photo"),
      title: (data.title ?? null) as string | null,
      content: (data.content ?? null) as string | null,
      imageUrls: ((data.image_urls ?? []) as string[]),
      videoUrls: ((data.video_urls ?? []) as string[]),
      isHidden: Boolean(data.is_hidden),
      authorNickname: profile?.nickname ?? null,
      authorTeamId: snapshotTeam ?? profile?.team_id ?? null,
    };
  } catch {
    return null;
  }
}

/** OG/공유 카드 제목 — 제목 없으면 본문 첫 줄, 그것도 없으면 기본값. */
export function sharePostTitle(post: SharePost | null, fallback = "크보팬 게시글"): string {
  const title = post?.title?.trim();
  if (title) return title;
  const firstLine = post?.content?.trim().split(/\r?\n/)[0]?.trim();
  if (firstLine) return firstLine.slice(0, 60);
  return fallback;
}

/** OG/공유 카드 설명 — 본문 발췌(제목과 중복 시 제외) + 작성자. */
export function sharePostDescription(post: SharePost | null): string {
  if (!post) return "프로야구팬이라면, 크보팬";
  const body = post.content?.trim().replace(/\s+/g, " ") ?? "";
  const stripped = post.title?.trim() && body.startsWith(post.title.trim())
    ? body.slice(post.title.trim().length).trim()
    : body;
  const excerpt = stripped.slice(0, 80);
  const author = post.authorNickname ? `${post.authorNickname} · ` : "";
  return excerpt ? `${author}${excerpt}` : `${author}크보팬에서 함께 응원해요 ⚾`;
}

/**
 * 게시글 상세 라우트용 동적 OG 메타데이터.
 * og:image 는 같은 세그먼트의 opengraph-image.tsx 가 자동 주입한다.
 * (invite 라우트와 동일하게 명시 URL도 함께 넣어 스크레이퍼 호환성 확보)
 */
export async function buildPostMetadata(postId: number, detailPath: string): Promise<Metadata> {
  const post = await fetchSharePost(postId);
  const title = sharePostTitle(post);
  const description = sharePostDescription(post);
  const url = `${SITE_ORIGIN}${detailPath}`;
  const imageUrl = `${url}/opengraph-image`;

  // 숨김/없는 글은 검색 비노출 + 기본 카드
  const hidden = !post || post.isHidden;

  return {
    title,
    description,
    alternates: { canonical: url },
    ...(hidden ? { robots: { index: false, follow: false } } : {}),
    openGraph: {
      title,
      description,
      type: "article",
      url,
      siteName: "크보팬",
      locale: "ko_KR",
      images: [{ url: imageUrl, width: 1200, height: 630, alt: title }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [imageUrl],
    },
  };
}
