import { permanentRedirect } from "next/navigation";

export default async function LegacyStadiumPage({ params }: { params: Promise<{ stadiumId: string }> }) {
  const { stadiumId } = await params;
  permanentRedirect(`/community/stadiums/${stadiumId}`);
}
