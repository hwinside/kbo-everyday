"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { ArrowLeft, Sparkles, ChevronRight } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";

interface Announcement {
  id: string;
  title: string;
  summary: string;
  body: string;
  cta_label: string | null;
  cta_path: string | null;
  published_at: string;
}

/** HTML-escape to prevent XSS from admin-authored content */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
}

export default function WhatsNewPage() {
  const router = useRouter();
  const pathname = usePathname();
  const [items, setItems] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/whats-new")
      .then((r) => r.json())
      .then((data: Announcement[]) => {
        setItems(data);
        if (data.length > 0) {
          localStorage.setItem("whats-new-seen-id", data[0].id);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="min-h-screen px-5 pt-4 pb-24">
      {/* Header */}
      <div className="mb-5 flex items-center gap-3">
        <button onClick={() => router.back()} className="text-text-secondary">
          <ArrowLeft size={22} />
        </button>
        <h1 className="flex items-center gap-2 text-lg font-bold text-text-primary">
          <Sparkles size={18} className="text-amber-400" />
          새 소식
        </h1>
      </div>

      {loading ? (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="glass-card p-5 animate-pulse">
              <div className="h-4 w-2/3 rounded bg-white/10 mb-2" />
              <div className="h-3 w-full rounded bg-white/10 mb-1" />
              <div className="h-3 w-4/5 rounded bg-white/10" />
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="mt-20 text-center text-text-tertiary text-sm">
          아직 새 소식이 없어요
        </div>
      ) : (
        <div className="space-y-4">
          {items.map((item) => (
            <GlassCard key={item.id}>
              <div className="mb-1 text-xs text-text-tertiary">
                {formatDate(item.published_at)}
              </div>
              <h2 className="text-base font-semibold text-text-primary mb-2">
                {escapeHtml(item.title)}
              </h2>
              <p
                className="text-sm text-text-secondary whitespace-pre-line leading-relaxed"
                dangerouslySetInnerHTML={{ __html: escapeHtml(item.body).replace(/\n/g, "<br />") }}
              />
              {item.cta_label && item.cta_path && item.cta_path !== pathname && (
                <button
                  onClick={() => router.push(item.cta_path!)}
                  className="mt-4 flex items-center gap-1 rounded-lg bg-white/10 px-4 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-white/15"
                >
                  {escapeHtml(item.cta_label)}
                  <ChevronRight size={16} />
                </button>
              )}
            </GlassCard>
          ))}
        </div>
      )}
    </div>
  );
}
