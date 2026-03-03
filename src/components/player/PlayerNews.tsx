"use client";

import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";
import { TEAMS } from "@/lib/constants/teams";

interface NewsItem {
  title: string;
  description: string;
  link: string;
  pubDate: string;
}

interface PlayerNewsProps {
  playerName: string;
  teamId?: number;
}

export default function PlayerNews({ playerName, teamId }: PlayerNewsProps) {
  const [news, setNews] = useState<NewsItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const teamObj = teamId ? TEAMS.find(t => t.id === teamId) : null;
    const teamName = teamObj ? `${teamObj.shortName} ${teamObj.name}` : "";
    const searchQuery = teamName ? `${teamName} ${playerName}` : `KBO ${playerName}`;
    
    console.log('[PlayerNews] Search query:', searchQuery);
    
    fetch(`/api/news?q=${encodeURIComponent(searchQuery)}`)
      .then(r => r.json())
      .then(d => {
        console.log('[PlayerNews] Items:', d.items?.length || 0);
        
        // 중복 제거 (link 기준)
        const seen = new Set<string>();
        const unique = (d.items || []).filter((item: NewsItem) => {
          if (seen.has(item.link)) return false;
          seen.add(item.link);
          return true;
        });
        
        console.log('[PlayerNews] Unique items:', unique.length);
        setNews(unique.slice(0, 5));
        setLoading(false);
      })
      .catch(e => {
        console.error('[PlayerNews] Error:', e);
        setLoading(false);
      });
  }, [playerName, teamId]);

  if (loading) {
    return (
      <div className="mt-6 mb-20">
        <h3 className="text-base font-bold text-text-primary mb-3">관련 기사</h3>
        <div className="text-sm text-text-tertiary">로딩 중...</div>
      </div>
    );
  }

  return (
    <div className="mt-6 mb-20">
      <h3 className="text-base font-bold text-text-primary mb-3">관련 기사</h3>
      {news.length === 0 ? (
        <div className="text-sm text-text-tertiary text-center py-4">
          관련 기사가 없습니다
        </div>
      ) : (
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
      )}
    </div>
  );
}
