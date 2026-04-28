"use client";

import { useRouter } from "next/navigation";
import { GraduationCap, ChevronRight, Sparkles } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";

const MENU_ITEMS: { icon: LucideIcon; label: string; count?: number | null; detail?: string; href?: string }[] = [
  { icon: GraduationCap, label: "야구 쉽게 배우기", count: null, href: "/learn" },
  { icon: Sparkles, label: "새 소식", count: null, href: "/whats-new" },
];

export default function MenuSection() {
  const router = useRouter();

  return (
    <div className="space-y-3">
      {MENU_ITEMS.map(({ icon: Icon, label, count, detail, href }) => (
        <GlassCard key={label} pressable onClick={() => href && router.push(href)} className="flex items-center justify-between p-5">
          <div className="flex items-center gap-4">
            <Icon size={22} className="text-text-secondary" />
            <span className="text-base text-text-primary">{label}</span>
          </div>
          <div className="flex items-center gap-1 text-text-tertiary">
            {count !== null && <span className="text-base">{count}</span>}
            {detail && <span className="text-base text-accent-gold">{detail}</span>}
            <ChevronRight size={22} />
          </div>
        </GlassCard>
      ))}
    </div>
  );
}
