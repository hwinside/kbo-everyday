"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Sparkles, ChevronRight } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";

interface Announcement {
  id: string;
  title: string;
  summary: string;
  cta_label: string | null;
  cta_path: string | null;
  published_at: string;
}

const SEEN_KEY = "whats-new-seen-id";

export default function WhatsNewCard() {
  const router = useRouter();
  const [item, setItem] = useState<Announcement | null>(null);

  useEffect(() => {
    fetch("/api/whats-new")
      .then((r) => r.json())
      .then((data: Announcement[]) => {
        if (data.length === 0) return;
        const latest = data[0];
        const seenId = localStorage.getItem(SEEN_KEY);
        if (seenId !== latest.id) setItem(latest);
      })
      .catch(() => {});
  }, []);

  const handleClick = () => {
    if (item) localStorage.setItem(SEEN_KEY, item.id);
    router.push("/whats-new");
  };

  if (!item) return null;

  return (
    <div className="mb-3">
      <GlassCard
        pressable
        onClick={handleClick}
        className="relative overflow-hidden"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex items-center gap-1.5">
              <Sparkles size={14} className="text-amber-400 shrink-0" />
              <span className="text-xs font-medium text-amber-400">새 소식</span>
            </div>
            <h3 className="text-sm font-semibold text-text-primary truncate">
              {item.title}
            </h3>
            <p className="mt-0.5 text-xs text-text-secondary line-clamp-2">
              {item.summary}
            </p>
          </div>
          <ChevronRight size={18} className="mt-1 shrink-0 text-text-tertiary" />
        </div>

        {item.cta_label && item.cta_path && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              router.push(item.cta_path!);
            }}
            className="mt-3 rounded-lg bg-white/10 px-3 py-1.5 text-xs font-medium text-text-primary transition-colors hover:bg-white/15"
          >
            {item.cta_label}
          </button>
        )}
      </GlassCard>
    </div>
  );
}
