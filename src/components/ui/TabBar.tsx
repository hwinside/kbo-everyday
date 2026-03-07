"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { clsx } from "clsx";
import { Home, CalendarDays, BarChart3, MessageSquare, Users, type LucideIcon } from "lucide-react";

interface TabItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

const tabs: TabItem[] = [
  { href: "/", label: "홈", icon: Home },
  { href: "/games", label: "경기", icon: CalendarDays },
  { href: "/community", label: "커뮤니티", icon: MessageSquare },
  { href: "/players", label: "선수", icon: Users },
  { href: "/standings", label: "순위", icon: BarChart3 },
];

export default function TabBar() {
  const pathname = usePathname();

  function isActive(href: string) {
    if (href === "/") return pathname === "/";
    return pathname.startsWith(href);
  }

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 rounded-none border-t border-border bg-[rgba(10,10,11,0.85)] backdrop-blur-xl">
      <div className="mx-auto flex max-w-lg items-center justify-around pb-[env(safe-area-inset-bottom,0px)]">
        {tabs.map((tab) => {
          const active = isActive(tab.href);
          const Icon = tab.icon;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={clsx(
                "flex flex-col items-center gap-0.5 px-3 py-1.5 transition-colors",
                active ? "text-accent" : "text-text-secondary",
              )}
            >
              <Icon size={22} strokeWidth={active ? 2 : 1.5} fill={active ? "currentColor" : "none"} className={active ? "opacity-90" : ""} />
              <span className="text-xs font-medium">{tab.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
