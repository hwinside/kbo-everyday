"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { clsx } from "clsx";
import { Home, Gamepad2, BarChart3, User, Circle, type LucideIcon } from "lucide-react";
import { getTeamById } from "@/lib/constants/teams";

const MY_TEAM_ID = 1; // LG 트윈스 (목업)

interface TabItem {
  href: string;
  label: string;
  icon: LucideIcon | null;
  isMyTeam?: boolean;
}

const tabs: TabItem[] = [
  { href: "/", label: "홈", icon: Home },
  { href: "/games", label: "경기", icon: Gamepad2 },
  { href: "/my-team", label: "마이팀", icon: null, isMyTeam: true },
  { href: "/standings", label: "순위", icon: BarChart3 },
  { href: "/my", label: "MY", icon: User },
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
                "flex flex-col items-center gap-1 px-3 py-2 transition-colors",
                active ? "text-accent" : "text-text-secondary",
              )}
            >
              {tab.isMyTeam ? (
                MY_TEAM_ID ? (
                  (() => {
                    const myTeam = getTeamById(MY_TEAM_ID);
                    return myTeam ? (
                      <div
                        className={clsx(
                          "flex h-[22px] w-[22px] items-center justify-center rounded-full bg-white p-0.5",
                          active && "ring-2 ring-accent ring-offset-1 ring-offset-bg-primary",
                        )}
                      >
                        <Image
                          src={myTeam.logoPath}
                          alt={myTeam.name}
                          width={18}
                          height={18}
                          unoptimized
                          className="object-contain"
                        />
                      </div>
                    ) : (
                      <Circle size={22} strokeWidth={active ? 2.5 : 1.5} />
                    );
                  })()
                ) : (
                  <Circle size={22} strokeWidth={active ? 2.5 : 1.5} />
                )
              ) : (
                Icon && <Icon size={22} strokeWidth={active ? 2.5 : 1.5} />
              )}
              <span className="text-[10px] font-medium">{tab.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
