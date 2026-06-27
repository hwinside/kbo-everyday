import type { Metadata } from "next";
import { buildPostMetadata } from "@/lib/share/post-og";

interface Props {
  params: Promise<{ teamId: string; postId: string }>;
  children: React.ReactNode;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { teamId, postId } = await params;
  return buildPostMetadata(Number(postId), `/community/teams/${teamId}/posts/${postId}`);
}

export default function TeamPostLayout({ children }: Props) {
  return children;
}
