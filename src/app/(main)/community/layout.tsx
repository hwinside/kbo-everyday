"use client";

import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { motion } from "framer-motion";
import { ChevronLeft, MessageSquare, Users, User, Ticket, MapPin } from "lucide-react";

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
  const router = useRouter();

  function handleBack() {
    // 항상 back 노출. 히스토리가 없으면 홈으로.
    if (typeof window !== "undefined" && window.history.length > 1) {
      router.back();
    } else {
      router.push("/");
    }
  }

  // Only show tabs on top-level community pages, not deep nested (e.g. post detail)
  const isHubLevel = COMMUNITY_TABS.some(
    (tab) =>
      pathname === tab.href ||
      // teams/[teamId], players/[playerId], stadiums/[stadiumId] - one level deep
      (pathname.startsWith(tab.href + "/") &&
        !pathname.includes("/posts/"))
  );

  // Stadium detail is a dedicated page — hide the community tabs to avoid "tab under tab"
  const hideCommunityTabs =
    pathname.startsWith("/community/stadiums/") && pathname !== "/community/stadiums";

  return (
    <div>
      {isHubLevel && !hideCommunityTabs && (
        <div
          className="sticky top-0 z-30 bg-bg-primary border-b border-border"
          style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
        >
          <div className="mx-auto max-w-lg">
            {/* Header (루트 메뉴들과 동일 규격) */}
            <div className="flex items-center gap-3 px-5 py-3">
              <button
                onClick={handleBack}
                className="rounded-full p-1 text-text-secondary hover:bg-bg-tertiary transition-colors"
                aria-label="뒤로가기"
              >
                <ChevronLeft size={24} />
              </button>
              <h1 className="text-3xl font-extrabold text-text-primary tracking-tight">커뮤니티</h1>
            </div>

            {/* Community tabs (헤더 아래 2번째 줄) */}
            <div className="flex px-5 gap-1 overflow-x-auto hide-scrollbar">
              {COMMUNITY_TABS.map((tab) => {
                const isActive = pathname === tab.href || pathname.startsWith(tab.href + "/");
                const Icon = tab.icon;
                return (
                  <Link
                    key={tab.key}
                    href={tab.href}
                    className={`relative flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium whitespace-nowrap transition-colors ${
                      isActive ? "text-text-primary" : "text-text-tertiary"
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
