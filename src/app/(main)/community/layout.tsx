"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { motion } from "framer-motion";
import { MessageSquare, Users, User, Ticket, MapPin } from "lucide-react";

const COMMUNITY_TABS = [
  { key: "teams", label: "팀", href: "/community/teams", icon: Users },
  { key: "players", label: "선수", href: "/community/players", icon: User },
  { key: "tickets", label: "티켓", href: "/community/tickets", icon: Ticket },
  { key: "stadiums", label: "구장", href: "/community/stadiums", icon: MapPin },
  { key: "free", label: "자유", href: "/community/free", icon: MessageSquare },
] as const;

export default function CommunityLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  // Only show tabs on top-level community pages, not deep nested (e.g. post detail)
  const isHubLevel = COMMUNITY_TABS.some(
    (tab) =>
      pathname === tab.href ||
      // teams/[teamId], players/[playerId], stadiums/[stadiumId] - one level deep
      (pathname.startsWith(tab.href + "/") &&
        !pathname.includes("/posts/"))
  );

  return (
    <div>
      {isHubLevel && (
        <div className="sticky top-[env(safe-area-inset-top,0px)] z-30 bg-[rgba(10,10,11,0.85)] backdrop-blur-xl border-b border-border">
          <div className="mx-auto max-w-lg">
            <h1 className="px-5 pt-4 pb-2 text-xl font-bold text-text-primary">
              커뮤니티
            </h1>
            <div className="flex px-5 gap-1 overflow-x-auto hide-scrollbar">
              {COMMUNITY_TABS.map((tab) => {
                const isActive =
                  pathname === tab.href ||
                  pathname.startsWith(tab.href + "/");
                const Icon = tab.icon;
                return (
                  <Link
                    key={tab.key}
                    href={tab.href}
                    className={`relative flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium whitespace-nowrap transition-colors ${
                      isActive
                        ? "text-text-primary"
                        : "text-text-tertiary"
                    }`}
                  >
                    <Icon size={16} />
                    {tab.label}
                    {isActive && (
                      <motion.div
                        layoutId="community-tab-indicator"
                        className="absolute bottom-0 left-2 right-2 h-0.5 rounded-full bg-accent"
                        transition={{ type: "spring", stiffness: 500, damping: 35 }}
                      />
                    )}
                  </Link>
                );
              })}
            </div>
          </div>
        </div>
      )}
      {children}
    </div>
  );
}
