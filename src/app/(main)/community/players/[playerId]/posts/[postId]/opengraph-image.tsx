import { fetchSharePost } from "@/lib/share/post-og";
import { renderPostOgImage } from "@/lib/share/og-render";

export const runtime = "edge";
export const alt = "크보팬 게시글";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OpengraphImage({ params }: { params: Promise<{ playerId: string; postId: string }> }) {
  const { postId } = await params;
  const post = await fetchSharePost(Number(postId));
  return renderPostOgImage(post, "card");
}
