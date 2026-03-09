"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { motion } from "framer-motion";
import { ChevronLeft, MessageSquare, Users, User, Ticket, MapPin } from "lucide-react";
import HeaderProfileLink from "@/components/ui/HeaderProfileLink";
import { getTeamById, getTeamBySlug } from "@/lib/constants/teams";
import { useAuth } from "@/lib/supabase/AuthContext";

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
  const { profile } = useAuth();

  useEffect(() => {
    // 새 탭에서 /community 직접 진입 + 서버 redirect로 /community/teams로 온 케이스는
    // referrer가 비어있고 history가 2 정도로 잡히는 경우가 있어 back 루프가 발생할 수 있음.
    // 이 경우 첫 back은 홈으로 보내기 위한 세션 플래그를 심어둔다.
    if (typeof window === "undefined") return;
    try {
      const ref = document.referrer;
      const hasReferrer = !!ref;
      if (!hasReferrer && window.location.pathname.startsWith("/community") && window.history.length <= 2) {
        sessionStorage.setItem("community-direct-entry", "1");
      }
    } catch {
      // ignore
    }
  }, []);

  function handleBack() {
    // 항상 back 노출. 히스토리가 없거나, /community → redirect 케이스면 홈으로.
    if (typeof window !== "undefined") {
      try {
        // 1) direct-entry 플래그가 있으면 첫 back은 무조건 홈
        if (sessionStorage.getItem("community-direct-entry") === "1") {
          sessionStorage.removeItem("community-direct-entry");
          router.push("/");
          return;
        }

        // 2) /community(root) → redirect 케이스는 back 루프가 될 수 있으니 referrer로도 방어
        const ref = document.referrer;
        if (ref) {
          const u = new URL(ref);
          if (u.origin === window.location.origin && u.pathname === "/community") {
            router.push("/");
            return;
          }
        }
      } catch {
        // ignore
      }

      if (window.history.length > 1) {
        router.back();
        return;
      }
    }

    router.push("/");
  }

  // Extract team color: URL team → fallback to user's myTeam
  const teamSlugMatch = pathname.match(/^\/community\/teams\/([^/]+)/);
  const currentTeam = teamSlugMatch ? getTeamBySlug(teamSlugMatch[1]) : undefined;
  const myTeam = profile?.team_id ? getTeamById(profile.team_id) : undefined;
  const headerTeam = currentTeam || myTeam;
  const headerBorderColor = headerTeam?.colorPrimary ? `${headerTeam.colorPrimary}40` : undefined;

  // Only show tabs on top-level community pages, not deep nested (e.g. post detail)
  const isHubLevel = COMMUNITY_TABS.some(
    (tab) =>
      pathname === tab.href ||
      // teams/[teamId], players/[playerId], stadiums/[stadiumId] - one level deep
      (pathname.startsWith(tab.href + "/") &&
        !pathname.includes("/posts/"))
  );

  // 상세 페이지에서는 1뎁스 헤더+탭 전체 숨김
  const isDetailPage =
    pathname.includes("/posts/") ||
    (pathname.startsWith("/community/stadiums/") && pathname !== "/community/stadiums") ||
    (pathname.startsWith("/community/free/") && pathname !== "/community/free");

  return (
    <div>
      {isHubLevel && !isDetailPage && (
        <div
          className="sticky top-0 z-30 bg-bg-primary border-b"
          data-team-border={!!headerBorderColor}
          // main layout already applies safe-area padding-top. Here we keep the notch-safe background
          // without pushing the title row down (baseline alignment with other root menus).
          style={{
            paddingTop: "env(safe-area-inset-top, 0px)",
            marginTop: "calc(env(safe-area-inset-top, 0px) * -1)",
            borderColor: headerBorderColor || 'var(--color-border)',
          }}
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
              <h1 className="text-2xl font-bold text-text-primary tracking-tight flex-1">커뮤니티</h1>
              <HeaderProfileLink />
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
