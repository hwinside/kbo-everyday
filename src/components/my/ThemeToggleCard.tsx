"use client";

import { Moon, Sun, Monitor } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";
import { useTheme } from "@/components/ThemeProvider";

const options = [
  { value: "light" as const, icon: Sun, label: "라이트" },
  { value: "dark" as const, icon: Moon, label: "다크" },
  { value: "system" as const, icon: Monitor, label: "시스템" },
];

export default function ThemeToggleCard() {
  const { theme, setTheme } = useTheme();

  return (
    <GlassCard className="p-5">
      <p className="text-sm font-medium text-text-secondary mb-3">테마 설정</p>
      <div className="flex gap-2">
        {options.map(({ value, icon: Icon, label }) => {
          const active = theme === value;
          return (
            <button
              key={value}
              onClick={() => setTheme(value)}
              className={`flex-1 flex items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-medium transition-colors ${
                active
                  ? "bg-accent text-white"
                  : "bg-bg-tertiary text-text-secondary hover:text-text-primary"
              }`}
            >
              <Icon size={16} />
              {label}
            </button>
          );
        })}
      </div>
    </GlassCard>
  );
}
