"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { motion } from "framer-motion";
import { ChevronLeft, MessageSquare, Users, User, Ticket, MapPin, FileText } from "lucide-react";
import HeaderProfileLink from "@/components/ui/HeaderProfileLink";
import { getTeamById, getTeamBySlug } from "@/lib/constants/teams";
import { useAuth } from "@/lib/supabase/AuthContext";
import { getTeamBorderColor } from "@/lib/utils/team-border-color";

const COMMUNITY_TABS = [
  { key: "all-posts", label: "전체글", href: "/community/all-posts", icon: FileText },
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
    if (typeof window === "undefined") { router.push("/"); return; }

    // 하위 페이지(선수 페이지 등)에서는 항상 히스토리 back 우선
    const isSubPage = window.location.pathname.split("/").filter(Boolean).length > 2;
    // e.g. /community/teams = 2 segments, /community/players/12345 = 3 segments

    if (isSubPage && window.history.length > 1) {
      router.back();
      return;
    }

    try {
      // direct-entry 플래그: 커뮤니티 최상위에서만 적용
      if (sessionStorage.getItem("community-direct-entry") === "1") {
        sessionStorage.removeItem("community-direct-entry");
        router.push("/");
        return;
      }

      // /community(root) → redirect 루프 방어
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

    router.push("/");
  }

  // Extract team color: URL team → fallback to user's myTeam
  const teamSlugMatch = pathname.match(/^\/community\/teams\/([^/]+)/);
  const currentTeam = teamSlugMatch ? getTeamBySlug(teamSlugMatch[1]) : undefined;
  const myTeam = profile?.team_id ? getTeamById(profile.team_id) : undefined;
  const headerTeam = currentTeam || myTeam;
  const headerBorderColor = headerTeam?.colorPrimary ? getTeamBorderColor(headerTeam.colorPrimary, headerTeam.colorLight) : undefined;

  // 태그 기반 전환(V3): 팀/선수 탭 통합 → 최애팀 단일 탭.
  // 최애팀 탭은 그 팀 team_tags 글(팀 글 + 그 팀 선수 글)을 보여준다. 로그인 전엔 일반 "팀" 탭으로 폴백.
  const myTeamTab = myTeam
    ? { key: "my-team", label: myTeam.name, href: `/community/teams/${myTeam.slug}`, icon: Users }
    : { key: "teams", label: "팀", href: "/community/teams", icon: Users };
  const displayTabs = [
    myTeamTab,
    { key: "all-posts", label: "전체글", href: "/community/all-posts", icon: FileText },
    { key: "tickets", label: "티켓", href: "/community/tickets", icon: Ticket },
    { key: "stadiums", label: "구장", href: "/community/stadiums", icon: MapPin },
    { key: "free", label: "자유", href: "/community/free", icon: MessageSquare },
  ];

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
    // 선수 상세: /community/players/[playerId] (독립 페이지로 취급)
    (pathname.startsWith("/community/players/") && pathname !== "/community/players") ||
    (pathname.startsWith("/community/stadiums/") && pathname !== "/community/stadiums") ||
    (pathname.startsWith("/community/free/") && pathname !== "/community/free");

  return (
    <div>
      {isHubLevel && !isDetailPage && (
        <div
          className="sticky top-0 z-30 bg-bg-primary"
          data-team-border={!!headerBorderColor}
          // main layout already applies safe-area padding-top. Here we keep the notch-safe background
          // without pushing the title row down (baseline alignment with other root menus).
          style={{
            paddingTop: "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))",
            marginTop: "calc(var(--safe-area-inset-top, env(safe-area-inset-top, 0px)) * -1)",
          }}
        >
          <div className="mx-auto max-w-lg">
            {/* Header (루트 메뉴들과 동일 규격) */}
            <div className="flex items-center gap-3 px-5 min-h-[44px] border-b" style={{ borderColor: headerBorderColor || 'var(--color-border)' }}>
              <button
                onClick={handleBack}
                className="flex h-11 w-11 items-center justify-center rounded-full text-text-secondary hover:bg-bg-tertiary transition-colors"
                aria-label="뒤로가기"
              >
                <ChevronLeft size={24} />
              </button>
              <h1 className="truncate text-lg font-bold text-text-primary tracking-tight flex-1">커뮤니티</h1>
              <HeaderProfileLink />
            </div>
          </div>
        </div>
      )}
      {/* Community tabs — 삼순 NO-GO: sticky wrapper 밖 바디로 내려 본문과 함ꔀ 스크롤(고정 시 142px로 축소 목적 무너짐) */}
      {isHubLevel && !isDetailPage && (
        <div className="mx-auto max-w-lg border-b" style={{ borderColor: headerBorderColor || 'var(--color-border)' }}>
          <div className="flex px-5 gap-1 overflow-x-auto hide-scrollbar">
            {displayTabs.map((tab) => {
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
      )}
      {children}
    </div>
  );
}
