import { permanentRedirect } from "next/navigation";

export default async function LegacyPostPage({ params }: { params: Promise<{ playerId: string; postId: string }> }) {
  const { playerId, postId } = await params;
  permanentRedirect(`/community/players/${playerId}/posts/${postId}`);
}
