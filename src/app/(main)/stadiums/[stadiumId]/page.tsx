import { redirect } from "next/navigation";

export default async function LegacyStadiumPage({ params }: { params: Promise<{ stadiumId: string }> }) {
  const { stadiumId } = await params;
  redirect(`/community/stadiums/${stadiumId}`);
}
