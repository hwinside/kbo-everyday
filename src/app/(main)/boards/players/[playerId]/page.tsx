import { permanentRedirect } from "next/navigation";

export default async function LegacyPlayerPage({ params }: { params: Promise<{ playerId: string }> }) {
  const { playerId } = await params;
  permanentRedirect(`/community/players/${playerId}`);
}
