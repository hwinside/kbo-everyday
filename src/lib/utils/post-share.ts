type ShareablePost = {
  id: number;
  board_type?: string | null;
  board_id?: string | null;
  boardType?: string | null;
  boardId?: string | null;
  title?: string | null;
  content?: string | null;
};

export type PostShareResult = "shared" | "copied" | "cancelled";

export function getPostDetailPath(post: ShareablePost): string {
  const boardType = post.board_type ?? post.boardType;
  const boardId = post.board_id ?? post.boardId;
  const postId = encodeURIComponent(String(post.id));

  if (boardType === "free") return `/community/free/${postId}`;
  if (boardType === "player" && boardId) {
    return `/community/players/${encodeURIComponent(boardId)}/posts/${postId}`;
  }
  if (boardType === "team" && boardId) {
    return `/community/teams/${encodeURIComponent(boardId)}/posts/${postId}`;
  }

  return `/community/free/${postId}`;
}

export function getPostShareUrl(post: ShareablePost, origin: string): string {
  return `${origin}${getPostDetailPath(post)}`;
}

export function getPostShareTitle(post: ShareablePost): string {
  const title = post.title?.trim();
  if (title) return title;

  const firstLine = post.content?.trim().split(/\r?\n/)[0]?.trim();
  if (firstLine) return firstLine.slice(0, 60);

  return "크보팬 게시글";
}

export async function sharePost(post: ShareablePost): Promise<PostShareResult> {
  if (typeof window === "undefined") return "cancelled";

  const url = getPostShareUrl(post, window.location.origin);
  const title = getPostShareTitle(post);

  if (navigator.share) {
    try {
      await navigator.share({ title, text: title, url });
      return "shared";
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return "cancelled";
      }
    }
  }

  await navigator.clipboard.writeText(url);
  return "copied";
}
