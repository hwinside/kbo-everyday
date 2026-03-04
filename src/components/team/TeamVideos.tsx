"use client";

import { useEffect, useState } from "react";
import { Play } from "lucide-react";
import ReelViewer from "@/components/home/ReelViewer";

interface Video {
  id: string;
  title: string;
  thumbnail: string;
  publishedAt: string;
}

export default function TeamVideos({ teamSlug }: { teamSlug: string }) {
  const [longVideos, setLongVideos] = useState<Video[]>([]);
  const [shortVideos, setShortVideos] = useState<Video[]>([]);
  const [reelIndex, setReelIndex] = useState<number | null>(null);

  useEffect(() => {
    fetch(`/api/team-videos?team=${teamSlug}&type=long`)
      .then(r => r.json())
      .then(d => setLongVideos(d.items || []))
      .catch(() => {});
    fetch(`/api/team-videos?team=${teamSlug}&type=short`)
      .then(r => r.json())
      .then(d => setShortVideos(d.items || []))
      .catch(() => {});
  }, [teamSlug]);

  return (
    <>
      {/* 롱폼: 가로 썸네일 → 유튜브 이동 */}
      {longVideos.length > 0 && (
        <section className="mb-6">
          <h2 className="text-base font-bold text-text-primary mb-3">📺 공식 영상</h2>
          <div className="flex gap-3 overflow-x-auto hide-scrollbar pb-2">
            {longVideos.map((v) => (
              <a
                key={v.id}
                href={`https://www.youtube.com/watch?v=${v.id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 group"
              >
                <div className="relative w-[220px] rounded-xl overflow-hidden">
                  <img
                    src={v.thumbnail}
                    alt={v.title}
                    className="w-full aspect-video object-cover group-hover:scale-105 transition-transform"
                  />
                  <div className="absolute inset-0 bg-black/20 group-hover:bg-black/40 transition-colors flex items-center justify-center">
                    <div className="w-10 h-10 rounded-full bg-white/90 flex items-center justify-center">
                      <Play size={18} className="text-black ml-0.5" fill="black" />
                    </div>
                  </div>
                </div>
                <p className="mt-2 text-xs text-text-secondary line-clamp-2 w-[220px] leading-relaxed">
                  {v.title}
                </p>
              </a>
            ))}
          </div>
        </section>
      )}

      {/* 숏츠: 세로형 썸네일 → 인앱 ReelViewer */}
      {shortVideos.length > 0 && (
        <section className="mb-6">
          <h2 className="text-base font-bold text-text-primary mb-3">📱 숏츠</h2>
          <div className="flex gap-2.5 overflow-x-auto hide-scrollbar pb-2">
            {shortVideos.map((v, i) => (
              <button
                key={v.id}
                onClick={() => setReelIndex(i)}
                className="shrink-0 group"
              >
                <div className="relative w-[120px] rounded-xl overflow-hidden">
                  <img
                    src={v.thumbnail}
                    alt={v.title}
                    className="w-full aspect-[9/16] object-cover group-hover:scale-105 transition-transform"
                  />
                  <div className="absolute inset-0 bg-black/10 group-hover:bg-black/30 transition-colors flex items-end p-2">
                    <div className="w-7 h-7 rounded-full bg-white/90 flex items-center justify-center">
                      <Play size={12} className="text-black ml-0.5" fill="black" />
                    </div>
                  </div>
                </div>
                <p className="mt-1.5 text-[11px] text-text-secondary line-clamp-2 w-[120px] leading-snug text-left">
                  {v.title}
                </p>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* 풀스크린 릴스 뷰어 */}
      {reelIndex !== null && (
        <ReelViewer
          videos={shortVideos.map(v => ({
            id: v.id,
            title: v.title,
            thumbnail: v.thumbnail,
            channel: "",
            publishedAt: v.publishedAt,
          }))}
          startIndex={reelIndex}
          onClose={() => setReelIndex(null)}
        />
      )}
    </>
  );
}
