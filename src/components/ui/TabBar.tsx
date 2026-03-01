"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { clsx } from "clsx";
import { Home, Gamepad2, BarChart3, Sparkles, Play, type LucideIcon } from "lucide-react";

interface TabItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

const tabs: TabItem[] = [
  { href: "/", label: "홈", icon: Home },
  { href: "/games", label: "경기", icon: Gamepad2 },
  { href: "/standings", label: "순위", icon: BarChart3 },
  { href: "/predict", label: "예측", icon: Sparkles },
  { href: "/highlights", label: "영상", icon: Play },
];

export default function TabBar() {
  const pathname = usePathname();

  function isActive(href: string) {
    if (href === "/") return pathname === "/";
    return pathname.startsWith(href);
  }

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 glass-card rounded-none border-t border-border">
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
              <Icon size={22} strokeWidth={active ? 2.5 : 1.5} />
              <span className="text-xs font-medium">{tab.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
