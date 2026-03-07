import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getTeamById } from "@/lib/constants/teams";

const MY_TEAM_COOKIE = "kbo-my-team";

export default async function CommunityPage() {
  const cookieStore = await cookies();
  const raw = cookieStore.get(MY_TEAM_COOKIE)?.value;
  const teamId = raw ? parseInt(raw, 10) : null;

  if (teamId) {
    const team = getTeamById(teamId);
    if (team) {
      redirect(`/community/teams/${team.slug}`);
    }
  }

  redirect("/community/teams");
}
