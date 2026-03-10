"use client";

import { useRouter } from "next/navigation";
import { FileText, MessageCircle, Mail, Heart, Trophy, GraduationCap, ChevronRight } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";

const MENU_ITEMS: { icon: LucideIcon; label: string; count?: number | null; detail?: string; href?: string }[] = [
  { icon: FileText, label: "내가 쓴 글", count: 23 },
  { icon: Mail, label: "쪽지함", href: "/messages" },
  { icon: MessageCircle, label: "내 댓글", count: 89 },
  { icon: Heart, label: "좋아요한 글", count: 156 },
  { icon: Trophy, label: "예측 전적", count: null, detail: "67% 적중" },
  { icon: GraduationCap, label: "야구 쉽게 배우기", count: null, detail: "NEW", href: "/learn" },
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
