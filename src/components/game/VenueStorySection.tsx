"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, Play, Loader2 } from "lucide-react";
import { useAuth } from "@/lib/supabase/AuthContext";
import { getSafeSession } from "@/lib/supabase/client";
import { getTeamById, getTeamBgColor } from "@/lib/constants/teams";
import VenueStoryComposer from "./VenueStoryComposer";
import VenueStoryViewer from "./VenueStoryViewer";
import type { VenueStory } from "@/lib/venue-stories/types";
import { loadSeenIds, markStorySeen, orderBySeen } from "@/lib/venue-stories/seen";
import {
  buildProcessingStory,
  mergePendingStories,
  PENDING_POLL_DELAYS_MS,
} from "@/lib/venue-stories/composer-helpers";

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
  // 본/안 본 스토리 (인스타 동일 — 하린아빠 21:52 지시). 뷰어 열려있는 동안엔 재정렬하지
  // 않도록(인덱스 어긋남 방지) 뷰어 닫힐 때만 seenIds를 다시 로드한다.
  const [seenIds, setSeenIds] = useState<ReadonlySet<string>>(() => new Set());

  // 계정(user.id) 스코프로 로드 — 계정 전환 시에도 즉시 해당 사용자 이력으로 격리 재로드
  const userId = user?.id ?? null;
  useEffect(() => {
    setSeenIds(loadSeenIds(gameId, userId));
  }, [gameId, userId]);

  // 영상 업로드 직후 낙관 '처리중' 카드로 넣은 id 추적 — 서버가 active 로 반환하면 제거(교체 완료).
  const pendingIdsRef = useRef<Set<number>>(new Set());
  // 서버가 removed 로 확정한 본인 업로드 — 사용자가 실패 카드를 눌러 재업로드할 때까지 유지.
  const failedIdsRef = useRef<Set<number>>(new Set());
  // pending → active 승급 감지용 재조회 타이머. 언마운트/새 업로드 시 정리.
  const pollTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const clearPollTimers = useCallback(() => {
    pollTimersRef.current.forEach(clearTimeout);
    pollTimersRef.current = [];
  }, []);
  useEffect(() => clearPollTimers, [clearPollTimers]);

  const fetchStories = useCallback(async () => {
    if (storyQaKeyboard) {
      // QA 하네스는 mock 뷰어만 사용 — 실데이터 조회 자체를 하지 않는다
      setLoaded(true);
      return;
    }
    try {
      // 로그인 상태면 bearer 전달 → 서버가 차단 유저 필터(getVerifiedUserFromRequest 는 Bearer-only)
      const session = await getSafeSession();
      const token = session?.access_token;
      const statusIds = [...pendingIdsRef.current];
      const statusQuery =
        statusIds.length > 0 ? `&statusIds=${encodeURIComponent(statusIds.join(","))}` : "";
      const res = await fetch(`/api/venue-stories?gameId=${encodeURIComponent(gameId)}${statusQuery}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      const data = await res.json();
      const server: VenueStory[] = Array.isArray(data.stories) ? data.stories : [];
      const uploadStatuses: Array<{ id: number; status: string }> = Array.isArray(
        data.uploadStatuses,
      )
        ? data.uploadStatuses
        : [];
      const serverIds = new Set(server.map((s) => s.id));
      const removedIds = new Set(
        uploadStatuses.filter((row) => row.status === "removed").map((row) => row.id),
      );
      for (const id of [...pendingIdsRef.current]) {
        if (serverIds.has(id)) pendingIdsRef.current.delete(id);
        if (removedIds.has(id)) {
          pendingIdsRef.current.delete(id);
          failedIdsRef.current.add(id);
        }
      }
      setStories((prev) => {
        const failed = prev
          .filter((story) => failedIdsRef.current.has(story.id))
          .map((story) => ({
            ...story,
            processing: false,
            stalled: false,
            failed: true,
          }));
        return [...failed, ...mergePendingStories(prev, server, pendingIdsRef.current)];
      });
      if (pendingIdsRef.current.size === 0) clearPollTimers();
    } catch {
      // 무시 — 섹션은 조용히 비워둠
    } finally {
      setLoaded(true);
    }
  }, [gameId, storyQaKeyboard, clearPollTimers]);

  useEffect(() => {
    fetchStories();
  }, [fetchStories]);

  // pending 낙관 카드 백오프 폴링 + 소진 시 '지연' 전환(삼순 #839 blocker 2).
  // active 승급 감지 시 fetchStories 가 실제 카드로 교체. 마지막 폴(~60초)까지도 안 뜨면
  // 무한 '처리중' 대신 stalled('지연·다시 시도')로 바꿔 재시도 동선을 준다(검증 지연/실패 대응).
  const startPendingPolling = useCallback(() => {
    clearPollTimers();
    for (const d of PENDING_POLL_DELAYS_MS) {
      pollTimersRef.current.push(
        setTimeout(() => {
          if (pendingIdsRef.current.size > 0) fetchStories();
        }, d),
      );
    }
    const lastDelay = PENDING_POLL_DELAYS_MS[PENDING_POLL_DELAYS_MS.length - 1] ?? 60000;
    pollTimersRef.current.push(
      setTimeout(() => {
        if (pendingIdsRef.current.size > 0) {
          setStories((prev) =>
            prev.map((s) =>
              s.processing && pendingIdsRef.current.has(s.id) ? { ...s, stalled: true } : s,
            ),
          );
          clearPollTimers();
        }
      }, lastDelay + 3000),
    );
  }, [fetchStories, clearPollTimers]);

  // 안 본 스토리 좌측 전진배치. 뷰어/트레이가 같은 배열을 쓰므로 인덱스 일치.
  const orderedStories = useMemo(() => orderBySeen(stories, seenIds), [stories, seenIds]);

  const handleStorySeen = useCallback(
    (storyId: string | number) => {
      // 즉시 localStorage 기록만 하고, 트레이 재정렬(seenIds 상태 갱신)은 뷰어 닫힐 때.
      markStorySeen(gameId, storyId, userId);
    },
    [gameId, userId],
  );

  // 업로드 성공 피드백 + pending 자동 반영(하린아빠 A17 리포트, 삼순 #839).
  // 영상은 pending→ffprobe 검증→active 승급 구조라 GET(active만) 직후 1회로는 안 뜬다.
  // → 낙관 '처리중' 카드를 즉시 트레이에 올리고 active 승급까지 폴링해 자동으로 실제 카드로 교체.
  const handleUploaded = useCallback(
    (result: {
      id: number | null;
      mediaType: "video" | "image";
      status: string | null;
      thumbUrl: string | null;
    }) => {
      if (result.mediaType === "video" && result.status === "pending" && result.id != null) {
        const optimistic = buildProcessingStory({
          id: result.id,
          gameId,
          userId: userId ?? "",
          mediaType: "video",
          thumbUrl: result.thumbUrl,
          author: { nickname: null, avatarUrl: null, teamId: null },
        });
        pendingIdsRef.current.add(result.id);
        setStories((prev) => [optimistic, ...prev.filter((s) => s.id !== result.id)]);
        setLoaded(true);
        // 백오프 폴링 — active 승급 감지 시 실제 카드 교체, 소진 시 지연 전환
        startPendingPolling();
      } else {
        fetchStories();
      }
      const msg =
        result.mediaType === "video" && result.status === "pending"
          ? "영상을 올렸어요! 검증 후 잠시 뒤 자동으로 나타나요 🎬"
          : result.mediaType === "video"
            ? "영상을 올렸어요! 🎬"
            : "사진을 올렸어요! 📷";
      setToast(msg);
      setTimeout(() => setToast(null), 2200);
    },
    [fetchStories, gameId, userId, startPendingPolling],
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
              onClick={() => {
                if (s.failed) {
                  failedIdsRef.current.delete(s.id);
                  setStories((prev) => prev.filter((story) => story.id !== s.id));
                  setComposerOpen(true);
                  setToast("영상 처리에 실패했어요. 다시 선택해 주세요.");
                  setTimeout(() => setToast(null), 2200);
                  return;
                }
                // 처리중(pending) 낙관 카드는 공개 객체가 아직 없어 재생 불가 → 뷰어 진입 대신 안내
                if (s.processing) {
                  if (s.stalled) {
                    // 검증 지연 — 재시도 동선: 지연 해제 + 재조회·폴링 재개
                    setStories((prev) =>
                      prev.map((x) => (x.id === s.id ? { ...x, stalled: false } : x)),
                    );
                    fetchStories();
                    startPendingPolling();
                    setToast("다시 확인 중이에요… 잠시만요 🎬");
                  } else {
                    setToast("영상 검증 중이에요. 잠시 뒤 자동으로 재생돼요 🎬");
                  }
                  setTimeout(() => setToast(null), 1800);
                  return;
                }
                setViewerIndex(i);
              }}
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
                {s.mediaType === "video" && !s.processing && (
                  <span className="absolute bottom-1 right-1 w-5 h-5 rounded-full bg-black/60 flex items-center justify-center">
                    <Play size={11} className="text-white fill-white" />
                  </span>
                )}
                {s.processing && !s.stalled && (
                  <div className="absolute inset-0 bg-black/55 flex flex-col items-center justify-center gap-1">
                    <Loader2 size={16} className="animate-spin text-white" />
                    <span className="text-[9px] text-white font-medium">처리중</span>
                  </div>
                )}
                {s.processing && s.stalled && (
                  <div className="absolute inset-0 bg-black/65 flex flex-col items-center justify-center gap-1 px-1">
                    <span className="text-[13px]">⏳</span>
                    <span className="text-[9px] text-white font-medium leading-tight text-center">지연·다시 시도</span>
                  </div>
                )}
                {s.failed && (
                  <div className="absolute inset-0 bg-black/70 flex flex-col items-center justify-center gap-1 px-1">
                    <span className="text-[13px]">↻</span>
                    <span className="text-[9px] text-white font-medium leading-tight text-center">
                      실패·다시 올리기
                    </span>
                  </div>
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
        onUploaded={handleUploaded}
      />

      {/* #809 본/안 본 정렬(orderedStories) + #807 QA 키보드 하네스 모두 보존 */}
      {viewerIndex !== null && (storyQaKeyboard || orderedStories[viewerIndex]) && (
        <VenueStoryViewer
          stories={storyQaKeyboard ? [buildQaKeyboardStory(gameId)] : orderedStories}
          startIndex={viewerIndex}
          currentUserId={user?.id ?? null}
          onStorySeen={handleStorySeen}
          onClose={() => {
            setViewerIndex(null);
            // 닫힐 때만 재정렬/테두리 갱신 (뷰어 열려있는 동안 인덱스 어긋남 방지)
            setSeenIds(loadSeenIds(gameId, userId));
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
