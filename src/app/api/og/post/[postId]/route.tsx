import { fetchSharePost } from "@/lib/share/post-og";
import { renderPostOgImage, type OgVariant } from "@/lib/share/og-render";

export const runtime = "edge";

/**
 * 게시글 OG 이미지 — 인스타 스토리 공유(파일)용 fetch 엔드포인트.
 * ?variant=story → 1080×1920 세로 카드, 그 외 → 1200×630.
 */
export async function GET(req: Request, { params }: { params: Promise<{ postId: string }> }) {
  const { postId } = await params;
  const variant: OgVariant = new URL(req.url).searchParams.get("variant") === "story" ? "story" : "card";
  const post = await fetchSharePost(Number(postId));
  return renderPostOgImage(post, variant);
}
