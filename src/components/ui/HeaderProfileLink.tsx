"use client";

import Link from "next/link";
import { MessageCircle, User } from "lucide-react";
import { useAuth } from "@/lib/supabase/AuthContext";
import { getAvatarPath } from "@/lib/constants/avatars";
import { TEAMS } from "@/lib/constants/teams";
import { useUnreadDMCount } from "@/lib/supabase/useUnreadDMCount";

/**
 * 1뎁스 헤더 우측에 배치하는 쪽지 + 프로필 아바타 링크
 * useAuth()를 내부적으로 사용하므로 props 불필요
 */
export default function HeaderProfileLink() {
  const { user, profile } = useAuth();

  const avatarPath = user && profile ? getAvatarPath(profile.avatar_url) : null;
  const initial = profile?.nickname?.charAt(0) || "?";
  const bgColor = profile?.team_id
    ? (TEAMS.find((t) => t.id === profile.team_id)?.colorPrimary ?? "#6366f1")
    : "#6366f1";
  const unreadCount = useUnreadDMCount();

  return (
    <div className="flex items-center gap-1">
      <Link href="/messages" className="relative rounded-full p-2 text-text-secondary hover:bg-bg-tertiary transition-colors">
        <MessageCircle size={22} />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-red-500 flex items-center justify-center text-[10px] font-bold text-white leading-none">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </Link>
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
