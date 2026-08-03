"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { X, MoreVertical, Loader2, Trash2 } from "lucide-react";
import { getSafeSession } from "@/lib/supabase/client";
import { isIosNativeRuntime, isNativeRuntime } from "@/lib/capacitor/platform";
import { getTeamById, getTeamBgColor } from "@/lib/constants/teams";
import {
  applyDiaryDetailUrlRefresh,
  diaryMediaSourceLabel,
  diaryShowsComments,
  makeDiaryDetailRefresh,
} from "@/lib/venue-diary/view";
import { startVenueStoryUrlRefresh } from "@/lib/venue-stories/refresh-policy";
import { gameResultTone, resultToneChipStyle } from "@/lib/ui/result-tone";

interface DiaryComment {
  id: number;
  userId: string;
  content: string;
  createdAt: string;
  author: { nickname: string | null; avatarUrl: string | null; teamId: number | null };
}

interface DiaryMedia {
  id: number;
  gameId: string;
  mediaType: "video" | "image";
  mediaUrl: string;
  thumbUrl: string | null;
  caption: string | null;
  venueVerified: boolean;
  stadiumName: string | null;
  createdAt: string;
  comments: DiaryComment[];
}

export interface DiaryViewerHeader {
  matchLabel: string;
  dateLabel: string;
  result: "W" | "L" | "D" | null;
}

interface Props {
  gameId: string;
  header: DiaryViewerHeader;
  isOpen: boolean;
  onClose: () => void;
  /** 삭제 후 홈 목록 갱신. */
  onChanged: () => void;
}

/** 승패 색은 홈 팀카드 기준 SSOT(@/lib/ui/result-tone)를 따른다. */
function resultStyle(result: "W" | "L" | "D") {
  return resultToneChipStyle(gameResultTone(result));
}

function resultText(result: "W" | "L" | "D"): string {
  return result === "W" ? "승" : result === "L" ? "패" : "무";
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "방금";
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  return `${Math.floor(hr / 24)}일 전`;
}

export default function VenueDiaryViewer({ gameId, header, isOpen, onClose, onChanged }: Props) {
  const [media, setMedia] = useState<DiaryMedia[] | null>(null);
  const [index, setIndex] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  // signed URL(5분 만료) 4분 재발급 루프용 — 현재 열린 gameId 소유권 가드(late apply 0).
  const gameIdRef = useRef(gameId);
  const refreshedTokenRef = useRef<number | null>(null);
  const lastUrlRefreshAtRef = useRef(0);
  useEffect(() => {
    gameIdRef.current = gameId;
  }, [gameId]);

  useEffect(() => {
    if (!isOpen) return;
    let alive = true;
    setMedia(null);
    setIndex(0);
    (async () => {
      try {
        const session = await getSafeSession();
        const token = session?.access_token;
        const res = await fetch(
          `/api/me/venue-diary/media?gameId=${encodeURIComponent(gameId)}`,
          {
            headers: token ? { Authorization: `Bearer ${token}` } : undefined,
            cache: "no-store",
          },
        );
        const data = (await res.json()) as { media?: DiaryMedia[] };
        if (alive) setMedia(Array.isArray(data.media) ? data.media : []);
      } catch {
        if (alive) setMedia([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [isOpen, gameId]);

  // 체류 중 signed URL 메디어 만료 전 detail refetch 로 mediaUrl/thumbUrl 재발급.
  // A1 검증된 순수 루프(startVenueStoryUrlRefresh)를 그대로 쓰고, controller 는 루프가 소유해
  // cleanup/경기 전환 시 in-flight abort, 전환 후 도착한 응답은 gameId 소유권 가드로 무시한다.
  useEffect(() => {
    if (!isOpen || !gameId) return;
    const token = 1;
    // 초기 fetch 가 이미 fresh URL 을 주므로 즉시 재발급하지 않고 4분 후부터.
    refreshedTokenRef.current = token;
    lastUrlRefreshAtRef.current = Date.now();
    return startVenueStoryUrlRefresh({
      storyId: token,
      isCurrentStory: () => gameIdRef.current === gameId,
      // getSafeSession/fetch 가 non-settle 이면 inFlight 가 영구 고정되므로 전체 mint 를
      // mintWithTimeout(8s, loop controller)로 감싸 반드시 settle→retry 된다(Blocker 1).
      refresh: makeDiaryDetailRefresh({
        getToken: async () => (await getSafeSession())?.access_token ?? null,
        fetchMedia: async (t, signal) => {
          const res = await fetch(
            `/api/me/venue-diary/media?gameId=${encodeURIComponent(gameId)}`,
            {
              headers: t ? { Authorization: `Bearer ${t}` } : undefined,
              cache: "no-store",
              signal,
            },
          );
          if (!res.ok) return null;
          const data = (await res.json()) as { media?: DiaryMedia[] };
          return Array.isArray(data.media) ? data.media : [];
        },
        isCurrent: () => gameIdRef.current === gameId,
        apply: (fresh) =>
          setMedia((prev) => (prev == null ? prev : applyDiaryDetailUrlRefresh(prev, fresh))),
        timers: {
          setTimer: (fn, ms) => setTimeout(fn, ms),
          clearTimer: (handle) => clearTimeout(handle),
        },
      }),
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle),
      getPreviousStoryId: () => refreshedTokenRef.current,
      setPreviousStoryId: (v) => {
        refreshedTokenRef.current = v;
      },
      getLastRefreshAt: () => lastUrlRefreshAtRef.current,
      setLastRefreshAt: (v) => {
        lastUrlRefreshAtRef.current = v;
      },
    });
  }, [isOpen, gameId]);

  useEffect(() => {
    if (!isOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [isOpen]);

  const current = media?.[index] ?? null;

  const goPrev = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);
  const goNext = useCallback(
    () => setIndex((i) => Math.min((media?.length ?? 1) - 1, i + 1)),
    [media],
  );

  const handleDelete = async () => {
    if (!current || busy) return;
    setBusy(true);
    try {
      const session = await getSafeSession();
      const token = session?.access_token;
      if (!token) {
        setToast("로그인이 필요해요");
        return;
      }
      const res = await fetch(`/api/venue-stories/${current.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.error) {
        setToast(data.error);
        return;
      }
      setMenuOpen(false);
      onChanged();
      // 로컬 목록에서 제거, 비면 닫기
      setMedia((prev) => {
        const next = (prev ?? []).filter((m) => m.id !== current.id);
        if (next.length === 0) {
          setTimeout(onClose, 200);
        } else {
          setIndex((i) => Math.min(i, next.length - 1));
        }
        return next;
      });
      setToast("삭제했어요");
    } catch {
      setToast("삭제 실패");
    } finally {
      setBusy(false);
    }
  };

  if (!isOpen || typeof document === "undefined") return null;

  const showComments = current != null && diaryShowsComments(current.venueVerified);
  const sourceLabel = current ? diaryMediaSourceLabel(current.venueVerified) : null;

  // iOS 네이티브 상태바(시계/배터리)는 z-index 로 덮을 수 없고, 원격 로드(server.url=keubo.fan)
  // WKWebView 에서는 env(safe-area-inset-top) 이 0 으로 깨지는 기기가 있다. 그래서 상단 크롬을
  // top-6(24px) 로 고정하면 버튼이 통째로 상태바 밴드 안에 들어가 터치가 상태바에 먹혀
  // "X·… 둘 다 안 눌려 화면에 갇힘"이 된다(하린아빠 2026-08-02 iOS 리포트).
  // VenueStoryViewer 가 #795/#843 에서 이미 같은 사고를 겪고 쓰는 보정을 그대로 따른다.
  // Android·웹/PWA 는 env() 순수값 유지(#843 NO-GO — 전 플랫폼 44px 강제 회귀 방지).
  const safeTop = isIosNativeRuntime()
    ? "max(env(safe-area-inset-top, 0px), 44px)"
    : "env(safe-area-inset-top, 0px)";
  // 하단 시트는 Android 제스처/3버튼 내비바에 캡션이 가렸다(하린아빠 같은 날 A17 리포트).
  // Capacitor WebView 는 env(safe-area-inset-bottom) 이 0 으로 오는 경우가 있어
  // 네이티브 런타임에서만 최소 48px 을 보장한다. 웹은 기존 여백(24px) 그대로.
  const safeBottom = isNativeRuntime()
    ? "max(env(safe-area-inset-bottom, 0px), 48px)"
    : "env(safe-area-inset-bottom, 0px)";

  return createPortal(
    <motion.div
      className="fixed inset-0 z-[120] bg-black flex flex-col select-none overflow-hidden"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      {/* 진행 도트 — 상태바 아래로 밀어 iOS 상태바와 겹치지 않게 한다. */}
      {media && media.length > 0 && (
        <div
          className="absolute left-0 right-0 z-20 flex gap-1 justify-center px-4"
          style={{ top: `calc(${safeTop} + 12px)` }}
        >
          {media.map((m, i) => (
            <span
              key={m.id}
              className={`h-[3px] w-6 rounded-full ${i === index ? "bg-white" : "bg-white/35"}`}
            />
          ))}
        </div>
      )}

      {/* 상단 닫기/더보기 — 상태바 밴드 아래에서 시작하고 44px 터치 타겟을 보장한다. */}
      <div
        className="absolute left-3 right-3 z-30 flex items-center justify-between"
        style={{ top: `calc(${safeTop} + 24px)` }}
      >
        <button
          onClick={onClose}
          aria-label="닫기"
          className="w-11 h-11 rounded-full bg-black/45 text-white flex items-center justify-center touch-manipulation"
        >
          <X size={18} />
        </button>
        {current && (
          <button
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="더보기"
            className="w-11 h-11 rounded-full bg-black/45 text-white flex items-center justify-center touch-manipulation"
          >
            <MoreVertical size={18} />
          </button>
        )}
      </div>

      {/* 더보기 메뉴 */}
      {menuOpen && current && (
        <>
          <div className="absolute inset-0 z-30" onClick={() => setMenuOpen(false)} />
          <div
            className="absolute right-3 z-40 w-48 rounded-xl border border-border bg-bg-secondary p-1.5 shadow-xl"
            style={{ top: `calc(${safeTop} + 76px)` }}
          >
            <button
              onClick={handleDelete}
              disabled={busy}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-semibold text-red-400 disabled:opacity-50"
            >
              {busy ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
              이 {current.mediaType === "video" ? "영상" : "사진"} 삭제
            </button>
          </div>
        </>
      )}

      {/* 미디어 */}
      <div className="flex-1 flex items-center justify-center relative bg-black">
        {media == null ? (
          <Loader2 size={26} className="animate-spin text-white/60" />
        ) : media.length === 0 ? (
          <p className="text-white/60 text-sm">기록이 없어요</p>
        ) : current ? (
          <>
            {current.mediaType === "video" ? (
              <video
                key={current.id}
                src={current.mediaUrl}
                className="max-h-full max-w-full w-full h-full object-contain"
                controls
                playsInline
              />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={current.id}
                src={current.mediaUrl}
                alt=""
                className="max-h-full max-w-full w-full h-full object-contain"
              />
            )}
            {/* 좌우 탭 존 */}
            {index > 0 && (
              <button aria-label="이전" onClick={goPrev} className="absolute inset-y-0 left-0 w-1/4" />
            )}
            {index < media.length - 1 && (
              <button aria-label="다음" onClick={goNext} className="absolute inset-y-0 right-0 w-1/4" />
            )}
          </>
        ) : null}

        {/* 경기 정보 */}
        {current && (
          <div className="absolute left-4 right-4 bottom-4 z-10 pointer-events-none">
            <p className="text-white text-base font-bold drop-shadow flex items-center gap-1.5">
              {header.matchLabel}
              {header.result && (
                <span
                  className="rounded px-1.5 py-0.5 text-[11px] font-bold"
                  style={resultStyle(header.result)}
                >
                  {resultText(header.result)}
                </span>
              )}
              {sourceLabel && (
                <span
                  className={`rounded px-1.5 py-0.5 text-[10.5px] font-bold ${
                    sourceLabel.kind === "gps"
                      ? "bg-emerald-500/20 text-emerald-400"
                      : "bg-white/15 text-text-secondary"
                  }`}
                >
                  {sourceLabel.text}
                </span>
              )}
            </p>
            <p className="mt-1 text-xs text-white/80 drop-shadow">
              {header.dateLabel}
              {sourceLabel?.kind === "manual" ? " · 직접 추가한 기록" : ""}
            </p>
          </div>
        )}
      </div>

      {/* 하단 시트: 캡션 + 댓글/안내 — 내비게이션 바 아래로 안 깔리게 안전영역을 더한다. */}
      {current && (
        <div
          className="shrink-0 bg-bg-primary border-t border-border px-4 pt-4 max-h-[36dvh] overflow-y-auto"
          style={{ paddingBottom: `calc(${safeBottom} + 24px)` }}
        >
          {current.caption && (
            <p className="text-sm text-text-primary leading-relaxed">{current.caption}</p>
          )}

          {showComments ? (
            <div className="mt-3 space-y-3">
              {current.comments.length === 0 ? (
                <p className="text-xs text-text-tertiary">아직 댓글이 없어요</p>
              ) : (
                current.comments.map((c) => {
                  const team = c.author.teamId != null ? getTeamById(c.author.teamId) : undefined;
                  return (
                    <div key={c.id} className="flex gap-2.5">
                      <div className="w-7 h-7 rounded-full bg-bg-tertiary shrink-0 overflow-hidden flex items-center justify-center text-text-secondary text-xs">
                        {(c.author.nickname ?? "?").slice(0, 1)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs text-text-secondary truncate">
                            {c.author.nickname ?? "익명"}
                          </span>
                          {team && (
                            <span
                              className="shrink-0 px-1 py-0.5 rounded text-[9px] font-bold text-white leading-none"
                              style={{ backgroundColor: getTeamBgColor(team, "dark") }}
                            >
                              {team.shortName}
                            </span>
                          )}
                          <span className="shrink-0 text-text-tertiary text-xs">· {timeAgo(c.createdAt)}</span>
                        </div>
                        <p className="mt-0.5 text-sm text-text-primary break-words">{c.content}</p>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          ) : (
            <div className="mt-3 flex items-start gap-2 rounded-xl border border-dashed border-border bg-bg-secondary px-3 py-3 text-[11.5px] leading-relaxed text-text-tertiary">
              💬 직접 추가한 경기는 <b className="text-text-secondary">댓글 영역이 없어요</b>. 읽기전용 댓글은 GPS 인증 라이브 경기 상세에서만 보여요.
            </div>
          )}
        </div>
      )}

      {toast && (
        <div className="absolute bottom-24 left-0 right-0 z-40 flex justify-center pointer-events-none">
          <div className="bg-black/80 text-white text-sm px-4 py-2 rounded-full">{toast}</div>
        </div>
      )}
    </motion.div>,
    document.body,
  );
}
