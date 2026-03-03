"use client";

import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";

interface NewsItem {
  title: string;
  description: string;
  link: string;
  pubDate: string;
}

interface PlayerNewsProps {
  playerName: string;
}

export default function PlayerNews({ playerName }: PlayerNewsProps) {
  const [news, setNews] = useState<NewsItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/news?player=${encodeURIComponent(playerName)}`)
      .then(r => r.json())
      .then(d => {
        setNews((d.items || []).slice(0, 5));
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [playerName]);

  if (loading) {
    return (
      <div className="mt-6 mb-20">
        <h3 className="text-base font-bold text-text-primary mb-3">관련 기사</h3>
        <div className="text-sm text-text-tertiary">로딩 중...</div>
      </div>
    );
  }

  if (news.length === 0) return null;

  return (
    <div className="mt-6 mb-20">
      <h3 className="text-base font-bold text-text-primary mb-3">관련 기사</h3>
      <div className="space-y-2">
        {news.map((item, i) => (
          <a key={i} href={item.link} target="_blank" rel="noopener noreferrer">
            <GlassCard pressable className="p-3">
              <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-text-primary line-clamp-2">
                    {item.title}
                  </p>
                  <p className="text-xs text-text-tertiary mt-1 line-clamp-1">
                    {item.description}
                  </p>
                  <p className="text-xs text-text-tertiary mt-1">
                    {new Date(item.pubDate).toLocaleDateString("ko-KR")}
                  </p>
                </div>
                <ExternalLink size={16} className="text-text-tertiary shrink-0 mt-1" />
              </div>
            </GlassCard>
          </a>
        ))}
      </div>
    </div>
  );
}
