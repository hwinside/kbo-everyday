"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { clsx } from "clsx";
import { Home, CalendarDays, BarChart3, MessageSquare, Users, Shield, type LucideIcon } from "lucide-react";
import { useAuth } from "@/lib/supabase/AuthContext";
import { getTeamById, getTeamBgColor } from "@/lib/constants/teams";

interface TabItem {
  href: string;
  label: string;
  icon: LucideIcon;
  badge?: boolean;
}

const tabs: TabItem[] = [
  { href: "/", label: "홈", icon: Home },
  { href: "/games", label: "경기", icon: CalendarDays },
  { href: "/teams", label: "팀", icon: Shield },
  { href: "/community", label: "커뮤니티", icon: MessageSquare },
  { href: "/players", label: "선수", icon: Users },
  { href: "/standings", label: "순위", icon: BarChart3 },
];

export default function TabBar() {
  const pathname = usePathname();
  const { profile } = useAuth();


  // 지정팀 컬러 (없으면 시스템 accent)
  const team = profile?.team_id ? getTeamById(profile.team_id) : undefined;
  const teamColor = team ? getTeamBgColor(team) : undefined;

  function isActive(href: string) {
    if (href === "/") return pathname === "/";
    return pathname.startsWith(href);
  }

  return (
    <nav data-global-tabbar className="fixed bottom-0 left-0 right-0 z-50 rounded-none border-t border-border pb-[env(safe-area-inset-bottom,0px)]">
      {/*
        Defensive iOS WKWebView hardening: keep the fixed <nav> free of compositing
        effects while preserving the glass appearance on an inner absolute layer.
        backdrop-filter has not been established as the cause of the reported float;
        do not move it back without an iOS device regression check (#420/#445). */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-[rgba(248,248,250,0.85)] dark:bg-[rgba(10,10,11,0.85)] backdrop-blur-xl"
      />
      {/* h-[50px] + nav 1px top border = --global-tabbar-h(51px) in globals.css — keep in sync */}
      <div className="mx-auto flex h-[50px] max-w-lg items-center justify-around">
        {tabs.map((tab) => {
          const active = isActive(tab.href);
          const Icon = tab.icon;
          return (
            <Link prefetch={false}
              key={tab.href}
              href={tab.href}
              className={clsx(
                "relative flex flex-col items-center gap-0.5 px-1.5 py-1.5 transition-colors min-w-0",
                active ? (teamColor ? "" : "text-accent") : "text-text-secondary",
              )}
              style={active && teamColor ? { color: teamColor } : undefined}
            >
              <div className="relative">
                <Icon size={22} strokeWidth={active ? 2 : 1.5} fill={active ? "currentColor" : "none"} className={active ? "opacity-90" : ""} />

              </div>
              <span className="text-[9px] font-medium truncate">{tab.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
