"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { ExternalLink, ChevronLeft } from "lucide-react";
import { getTeamBySlug } from "@/lib/constants/teams";
import GlassCard from "@/components/ui/GlassCard";

interface NewsItem {
  title: string;
  description: string;
  link: string;
  pubDate: string;
}

export default function TeamNewsPage() {
  const params = useParams();
  const router = useRouter();
  const teamSlug = params.teamId as string;
  const team = getTeamBySlug(teamSlug);
  const [news, setNews] = useState<NewsItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!team) return;
    fetch(`/api/news?team=${encodeURIComponent(team.shortName)}`)
      .then((r) => r.json())
      .then((d) => {
        const seen = new Set<string>();
        const unique = (d.items || []).filter((item: NewsItem) => {
          if (seen.has(item.link)) return false;
          seen.add(item.link);
          return true;
        });
        setNews(unique);
      })
      .catch(() => setNews([]))
      .finally(() => setLoading(false));
  }, [team]);

  if (!team) {
    return (
      <div className="flex items-center justify-center py-40 text-text-tertiary">
        존재하지 않는 구단입니다
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg pb-24">
      <header className="flex items-center gap-2 px-5 py-4">
        <button onClick={() => { if (window.history.length > 1) router.back(); else router.push(`/teams/${teamSlug}`); }} className="rounded-full p-1 text-text-secondary hover:bg-bg-tertiary transition-colors">
          <ChevronLeft size={24} />
        </button>
        <h1 className="text-lg font-bold text-text-primary">
          {team.shortName} 뉴스
        </h1>
      </header>

      <div className="px-5">
        {loading ? (
          <div className="py-20 text-center text-sm text-text-tertiary">
            로딩 중...
          </div>
        ) : news.length === 0 ? (
          <div className="py-20 text-center text-sm text-text-tertiary">
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
    </div>
  );
}
