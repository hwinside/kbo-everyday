"use client";

import { useEffect, useState } from "react";
import { Play } from "lucide-react";
import ReelViewer from "@/components/home/ReelViewer";
import { handleExternalAnchorClick } from "@/lib/open-external";

interface Video {
  id: string;
  title: string;
  thumbnail: string;
  publishedAt: string;
  durationSeconds?: number;
  viewToken?: string;
}

/** 초 → "3:24" / 1시간 이상은 "1:02:30" */
function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const ss = String(s).padStart(2, "0");
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${ss}`;
  return `${m}:${ss}`;
}

function DurationBadge({ seconds }: { seconds?: number }) {
  if (!seconds || seconds <= 0) return null;
  return (
    <div className="absolute bottom-1.5 right-1.5 rounded bg-black/80 px-1.5 py-0.5 text-[11px] font-medium leading-none text-white">
      {formatDuration(seconds)}
    </div>
  );
}

/** 업로드 시점 → 하루 안 "n시간 전"(1시간 미만은 "n분 전"/"방금 전") · 하루~일주일 "n일 전" · 일주일↑ "6월 21일"(KST). 미래/빈/invalid는 미표시 */
function formatUploadedAgo(publishedAt?: string): string | null {
  if (!publishedAt) return null;
  const date = new Date(publishedAt);
  const ms = date.getTime();
  if (Number.isNaN(ms)) return null;

  const diff = Date.now() - ms;
  if (diff < 0) return null; // 미래 시각(잘못된 데이터)은 미표시
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diff < hour) {
    const minutes = Math.floor(diff / minute);
    return minutes < 1 ? "방금 전" : `${minutes}분 전`;
  }
  if (diff < day) return `${Math.floor(diff / hour)}시간 전`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}일 전`;

  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "long",
    day: "numeric",
  }).format(date);
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
      {/* 롱폼: 세로 썸네일 → 유튜브 이동 */}
      {longVideos.length > 0 && (
        <section className="mb-6">
          <div className="space-y-3">
            {longVideos.map((v) => {
              const uploadedAgo = formatUploadedAgo(v.publishedAt);
              return (
              <a
                key={v.id}
                href={`https://www.youtube.com/watch?v=${v.id}`}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => handleExternalAnchorClick(e, `https://www.youtube.com/watch?v=${v.id}`)}
                className="block group"
              >
                <div className="relative w-full rounded-xl overflow-hidden">
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
                  <DurationBadge seconds={v.durationSeconds} />
                </div>
                <p className="mt-1.5 text-sm text-text-primary line-clamp-2 leading-snug">
                  {v.title}
                </p>
                {uploadedAgo && (
                  <p className="mt-0.5 text-xs text-text-tertiary">{uploadedAgo}</p>
                )}
              </a>
              );
            })}
          </div>
        </section>
      )}

      {/* 숏츠: 세로형 썸네일 → 인앱 ReelViewer */}
      {shortVideos.length > 0 && (
        <section className="mb-6">
          <h2 className="text-base font-bold text-text-primary mb-3">📱 숏츠</h2>
          <div className="flex gap-2.5 overflow-x-auto hide-scrollbar pb-2">
            {shortVideos.map((v, i) => {
              const uploadedAgo = formatUploadedAgo(v.publishedAt);
              return (
              <button
                key={v.id}
                onClick={() => setReelIndex(i)}
                className="shrink-0 group flex flex-col w-[120px]"
              >
                <div className="relative w-[120px] h-[213px] rounded-xl overflow-hidden">
                  <img
                    src={v.thumbnail}
                    alt={v.title}
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                  />
                  <div className="absolute inset-0 bg-black/10 group-hover:bg-black/30 transition-colors flex items-end p-2">
                    <div className="w-7 h-7 rounded-full bg-white/90 flex items-center justify-center">
                      <Play size={12} className="text-black ml-0.5" fill="black" />
                    </div>
                  </div>
                  <DurationBadge seconds={v.durationSeconds} />
                </div>
                <p className="mt-1.5 text-[11px] text-text-secondary line-clamp-2 leading-snug text-left">
                  {v.title}
                </p>
                {uploadedAgo && (
                  <p className="mt-0.5 text-[10px] text-text-tertiary text-left">{uploadedAgo}</p>
                )}
              </button>
              );
            })}
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
            viewToken: v.viewToken,
          }))}
          startIndex={reelIndex}
          onClose={() => setReelIndex(null)}
        />
      )}
    </>
  );
}
