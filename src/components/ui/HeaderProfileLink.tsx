"use client";

import Link from "next/link";
import { Bell, User } from "lucide-react";
import { useAuth } from "@/lib/supabase/AuthContext";
import { getAvatarPath } from "@/lib/constants/avatars";
import { TEAMS } from "@/lib/constants/teams";

/**
 * 1뎁스 헤더 우측에 배치하는 🔔 알림 + 프로필 아바타 링크
 * useAuth()를 내부적으로 사용하므로 props 불필요
 */
export default function HeaderProfileLink() {
  const { user, profile } = useAuth();

  const avatarPath = user && profile ? getAvatarPath(profile.avatar_url) : null;
  const initial = profile?.nickname?.charAt(0) || "?";
  const bgColor = profile?.team_id
    ? (TEAMS.find((t) => t.id === profile.team_id)?.colorPrimary ?? "#6366f1")
    : "#6366f1";

  return (
    <div className="flex items-center gap-1">
      <button className="rounded-full p-2 text-text-secondary hover:bg-bg-tertiary transition-colors">
        <Bell size={22} />
      </button>
      <Link href="/my" className="rounded-full p-2 hover:bg-bg-tertiary transition-colors">
        {!user || !profile ? (
          <User size={22} className="text-text-secondary" />
        ) : avatarPath ? (
          <img src={avatarPath} alt="" className="w-[22px] h-[22px] rounded-full object-cover" />
        ) : (
          <div
            className="w-[22px] h-[22px] rounded-full flex items-center justify-center text-[11px] font-bold text-white"
            style={{ backgroundColor: bgColor }}
          >
            {initial}
          </div>
        )}
      </Link>
    </div>
  );
}
