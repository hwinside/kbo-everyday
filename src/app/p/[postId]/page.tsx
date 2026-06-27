import type { Metadata } from "next";
import { fetchSharePost, buildPostMetadata } from "@/lib/share/post-og";
import { getPostDetailPath } from "@/lib/utils/post-share";
import ShareRedirect from "./ShareRedirect";

interface Props {
  params: Promise<{ postId: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { postId } = await params;
  return buildPostMetadata(Number(postId), `/p/${postId}`);
}

export default async function SharePostPage({ params }: Props) {
  const { postId } = await params;
  const post = await fetchSharePost(Number(postId));
  const target = post
    ? getPostDetailPath({ id: post.id, board_type: post.boardType, board_id: post.boardId })
    : "/community";
  return <ShareRedirect to={target} />;
}
