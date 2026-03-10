import { User } from "lucide-react";
import { TEAMS, getTeamBgColor } from "@/lib/constants/teams";
import { getAvatarPath } from "@/lib/constants/avatars";
import type { User as SupabaseUser } from "@supabase/supabase-js";

interface AuthProfile {
  nickname: string;
  team_id: number;
  avatar_url: string | null;
}

export default function HeaderAvatar({ user, profile }: { user: SupabaseUser | null; profile: AuthProfile | null }) {
  if (!user || !profile) {
    return <User size={22} className="text-text-secondary" />;
  }

  const avatarPath = getAvatarPath(profile.avatar_url);
  const initial = profile.nickname?.charAt(0) || '?';
  const team = profile.team_id ? TEAMS.find(t => t.id === profile.team_id) : undefined;
  const bgColor = team ? getTeamBgColor(team) : '#6366f1';

  if (avatarPath) {
    return (
      <img
        src={avatarPath}
        alt=""
        className="w-[22px] h-[22px] rounded-full object-cover"
      />
    );
  }

  return (
    <div
      className="w-[22px] h-[22px] rounded-full flex items-center justify-center text-[11px] font-bold text-white"
      style={{ backgroundColor: bgColor }}
    >
      {initial}
    </div>
  );
}
