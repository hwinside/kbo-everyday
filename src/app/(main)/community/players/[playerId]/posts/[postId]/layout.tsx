import type { Metadata } from "next";
import { buildPostMetadata } from "@/lib/share/post-og";

interface Props {
  params: Promise<{ playerId: string; postId: string }>;
  children: React.ReactNode;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { playerId, postId } = await params;
  return buildPostMetadata(Number(postId), `/community/players/${playerId}/posts/${postId}`);
}

export default function PlayerPostLayout({ children }: Props) {
  return children;
}
