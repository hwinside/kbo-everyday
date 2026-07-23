"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, Play } from "lucide-react";
import { useAuth } from "@/lib/supabase/AuthContext";
import { getSafeSession } from "@/lib/supabase/client";
import { getTeamById, getTeamBgColor } from "@/lib/constants/teams";
import VenueStoryComposer from "./VenueStoryComposer";
import VenueStoryViewer from "./VenueStoryViewer";
import type { VenueStory } from "@/lib/venue-stories/types";

interface Props {
  gameId: string;
}

// iOS 실기기 키보드 QA(?storyQaKeyboard=1) 전용 mock — game-chat 의 chatQaKeyboard 패턴.
// 실제 스토리/로그인 없이도 뷰어 입력바의 focus→키보드→submit→blur 를 검증한다.
// src 없는 video 라 자동진행/종료가 없어 뷰어가 측정 동안 열려 있다(id -1 은
// 서버에 없는 스토리 — 댓글 GET 404/POST 비로그인 차단이라 쓰기 부작용 0).
function buildQaKeyboardStory(gameId: string): VenueStory {
  return {
    id: -1,
    gameId,
    userId: "00000000-0000-0000-0000-000000000000",
    mediaType: "video",
    mediaUrl: "data:video/mp4;base64,",
    thumbUrl: null,
    durationMs: null,
    width: null,
    height: null,
    caption: null,
    venueVerified: false,
    createdAt: new Date().toISOString(),
    author: { nickname: "QA", avatarUrl: null, teamId: null },
  };
}

export default function VenueStorySection({ gameId }: Props) {
  const { user } = useAuth();
  const storyQaKeyboard =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("storyQaKeyboard") === "1";
  const [stories, setStories] = useState<VenueStory[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [viewerIndex, setViewerIndex] = useState<number | null>(
    storyQaKeyboard ? 0 : null,
  );
  const [toast, setToast] = useState<string | null>(null);

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

        {stories.map((s, i) => {
          const team = s.author.teamId != null ? getTeamById(s.author.teamId) : undefined;
          const teamColor = team ? getTeamBgColor(team, "dark") : null;
          return (
            <button
              key={s.id}
              onClick={() => setViewerIndex(i)}
              className="shrink-0 w-[68px] flex flex-col items-center gap-1"
            >
              <div className="relative w-[68px] h-[104px] rounded-xl overflow-hidden bg-bg-tertiary ring-2 ring-red-500/60">
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

      {viewerIndex !== null && (storyQaKeyboard || stories[viewerIndex]) && (
        <VenueStoryViewer
          stories={storyQaKeyboard ? [buildQaKeyboardStory(gameId)] : stories}
          startIndex={viewerIndex}
          currentUserId={user?.id ?? null}
          onClose={() => setViewerIndex(null)}
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
