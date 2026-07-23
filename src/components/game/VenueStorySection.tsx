"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Play } from "lucide-react";
import { useAuth } from "@/lib/supabase/AuthContext";
import { getSafeSession } from "@/lib/supabase/client";
import { getTeamById, getTeamBgColor } from "@/lib/constants/teams";
import VenueStoryComposer from "./VenueStoryComposer";
import VenueStoryViewer from "./VenueStoryViewer";
import type { VenueStory } from "@/lib/venue-stories/types";
import { loadSeenIds, markStorySeen, orderBySeen } from "@/lib/venue-stories/seen";

interface Props {
  gameId: string;
}

export default function VenueStorySection({ gameId }: Props) {
  const { user } = useAuth();
  const [stories, setStories] = useState<VenueStory[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // 본/안 본 스토리 (인스타 동일 — 하린아빠 21:52 지시). 뷰어 열려있는 동안엔 재정렬하지
  // 않도록(인덱스 어긋남 방지) 뷰어 닫힐 때만 seenIds를 다시 로드한다.
  const [seenIds, setSeenIds] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    setSeenIds(loadSeenIds(gameId));
  }, [gameId]);

  const fetchStories = useCallback(async () => {
    try {
      // 로그인 상태면 bearer 전달 → 서버가 차단 유저 필터(getVerifiedUserFromRequest 는 Bearer-only)
      const session = await getSafeSession();
      const token = session?.access_token;
      const res = await fetch(`/api/venue-stories?gameId=${encodeURIComponent(gameId)}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      const data = await res.json();
      setStories(Array.isArray(data.stories) ? data.stories : []);
    } catch {
      // 무시 — 섹션은 조용히 비워둠
    } finally {
      setLoaded(true);
    }
  }, [gameId]);

  useEffect(() => {
    fetchStories();
  }, [fetchStories]);

  // 안 본 스토리 좌측 전진배치. 뷰어/트레이가 같은 배열을 쓰므로 인덱스 일치.
  const orderedStories = useMemo(() => orderBySeen(stories, seenIds), [stories, seenIds]);

  const handleStorySeen = useCallback(
    (storyId: string | number) => {
      // 즉시 localStorage 기록만 하고, 트레이 재정렬(seenIds 상태 갱신)은 뷰어 닫힐 때.
      markStorySeen(gameId, storyId);
    },
    [gameId],
  );

  const handleUploadClick = () => {
    if (!user) {
      setToast("로그인 후 이용해주세요");
      setTimeout(() => setToast(null), 1800);
      return;
    }
    setComposerOpen(true);
  };

  // 로드 전이거나(첫 렌더 깜빡임 방지) 스토리 없고 비로그인이면 최소 노출
  if (!loaded && stories.length === 0) return null;

  return (
    <div className="px-4 pt-1 pb-3">
      <div className="flex items-center gap-1.5 mb-2">
        <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
        <h3 className="text-sm font-semibold text-text-primary">직관 라이브</h3>
        <span className="text-[11px] text-text-tertiary">현장에서 온 짧은 중계</span>
      </div>

      <div className="flex gap-2 overflow-x-auto scrollbar-hide -mx-1 px-1 pb-1">
        {/* 올리기 타일 */}
        <button
          onClick={handleUploadClick}
          className="shrink-0 w-[68px] flex flex-col items-center gap-1"
        >
          <div className="w-[68px] h-[104px] rounded-xl border-2 border-dashed border-border flex items-center justify-center bg-bg-tertiary/50 active:bg-bg-tertiary">
            <Plus size={22} className="text-text-tertiary" />
          </div>
          <span className="text-[11px] text-text-tertiary">올리기</span>
        </button>

        {orderedStories.map((s, i) => {
          const team = s.author.teamId != null ? getTeamById(s.author.teamId) : undefined;
          const teamColor = team ? getTeamBgColor(team, "dark") : null;
          return (
            <button
              key={s.id}
              onClick={() => setViewerIndex(i)}
              className="shrink-0 w-[68px] flex flex-col items-center gap-1"
            >
              <div
                className={`relative w-[68px] h-[104px] rounded-xl overflow-hidden bg-bg-tertiary ring-2 ${
                  seenIds.has(String(s.id)) ? "ring-gray-500/50" : "ring-red-500/60"
                }`}
              >
                {s.thumbUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={s.thumbUrl} alt="" className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-text-tertiary text-xs">
                    {s.mediaType === "video" ? "🎬" : "📷"}
                  </div>
                )}
                {team && teamColor && (
                  <span
                    className="absolute top-1 left-1 px-1.5 py-0.5 rounded-md text-[9px] font-extrabold text-white leading-none shadow"
                    style={{ backgroundColor: teamColor }}
                  >
                    {team.shortName}
                  </span>
                )}
                {s.mediaType === "video" && (
                  <span className="absolute bottom-1 right-1 w-5 h-5 rounded-full bg-black/60 flex items-center justify-center">
                    <Play size={11} className="text-white fill-white" />
                  </span>
                )}
              </div>
              <span className="text-[11px] text-text-secondary truncate w-full text-center">
                {s.author.nickname ?? "익명"}
              </span>
            </button>
          );
        })}

        {loaded && stories.length === 0 && (
          <div className="shrink-0 flex items-center px-3">
            <p className="text-xs text-text-tertiary">
              직관 오셨나요? 현장을 공유해보세요 📣
            </p>
          </div>
        )}
      </div>

      <VenueStoryComposer
        gameId={gameId}
        isOpen={composerOpen}
        onClose={() => setComposerOpen(false)}
        onUploaded={fetchStories}
      />

      {viewerIndex !== null && orderedStories[viewerIndex] && (
        <VenueStoryViewer
          stories={orderedStories}
          startIndex={viewerIndex}
          currentUserId={user?.id ?? null}
          onStorySeen={handleStorySeen}
          onClose={() => {
            setViewerIndex(null);
            // 닫힐 때만 재정렬/테두리 갱신 (뷰어 열려있는 동안 인덱스 어긋남 방지)
            setSeenIds(loadSeenIds(gameId));
          }}
          onChanged={fetchStories}
        />
      )}

      {toast && (
        <div className="fixed bottom-24 left-0 right-0 z-[70] flex justify-center pointer-events-none">
          <div className="bg-black/80 text-white text-sm px-4 py-2 rounded-full">{toast}</div>
        </div>
      )}
    </div>
  );
}
