"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { X, ChevronLeft, ImagePlus, Check, Loader2, AlertTriangle, Lock } from "lucide-react";
import { getSafeSession } from "@/lib/supabase/client";
import { prepareVenueStoryMedia } from "@/lib/venue-stories/upload";
import { VENUE_STORY_CONSENT_VERSION } from "@/lib/venue-stories/types";
import { consentStorageKey } from "@/lib/venue-stories/auth-consent";
import {
  diaryBottomCta,
  diaryCaptionForSubmit,
  diaryLeaveNotice,
  diaryPendingTerminalPhase,
  diaryUploadBadge,
  diaryUploadTargets,
  startDiaryPendingPoll,
  VENUE_DIARY_MEDIA_CAP,
  type DiaryUploadItemState,
} from "@/lib/venue-diary/view";
import { PENDING_POLL_DELAYS_MS } from "@/lib/venue-stories/composer-helpers";
import { gameResultTone, resultToneChipStyle } from "@/lib/ui/result-tone";

export interface DiaryUploadGame {
  gameId: string;
  /** 헤더 표시용 라벨(예: "2026.07.18 (금) · 잠실"). */
  dateLabel: string;
  /** 헤더 표시용 매치(예: "LG 5 : 4 두산"). */
  matchLabel: string;
  result: "W" | "L" | "D" | null;
  /** 이 경기에 이미 올린 개수(잠금·잔여 계산). */
  existingCount: number;
}

interface UploadItem {
  key: string;
  file: File;
  previewUrl: string;
  mediaType: "image" | "video";
  state: DiaryUploadItemState;
}

interface Props {
  game: DiaryUploadGame;
  isOpen: boolean;
  onBack: () => void;
  onClose: () => void;
  /** 하나라도 저장 성공하면 호출(홈 목록 갱신용). 영상 pending 은 archived 승급 poll 트리거. */
  onUploaded: (result: {
    id: number | null;
    gameId: string;
    mediaType: "image" | "video";
    status: string;
  }) => void;
}

/** 승패 색은 홈 팀카드 기준 SSOT(@/lib/ui/result-tone)를 따른다. */
function resultStyle(result: "W" | "L" | "D") {
  return resultToneChipStyle(gameResultTone(result));
}

function resultText(result: "W" | "L" | "D"): string {
  return result === "W" ? "승" : result === "L" ? "패" : "무";
}

export default function VenueDiaryUploader({ game, isOpen, onBack, onClose, onUploaded }: Props) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const [caption, setCaption] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionUserId, setSessionUserId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // 제출 시점 caption 을 읽는 소스(선택 순간 closure 고정 방지 — Blocker 2).
  const captionRef = useRef("");
  useEffect(() => {
    captionRef.current = caption;
  }, [caption]);
  // beforeunload/close 가드가 최신 항목 상태를 읽도록 ref 로 미러링(Blocker 3).
  const itemsRef = useRef<UploadItem[]>([]);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
  // pending 영상 terminal poll cancel 함수들 — 언마운트/닫힐 시 모두 중단(Blocker 3).
  const pendingPollsRef = useRef<Array<() => void>>([]);
  useEffect(
    () => () => {
      pendingPollsRef.current.forEach((cancel) => cancel());
      pendingPollsRef.current = [];
    },
    [],
  );

  const consentKey = consentStorageKey(VENUE_STORY_CONSENT_VERSION, sessionUserId);

  useEffect(() => {
    if (!isOpen) return;
    let alive = true;
    (async () => {
      const session = await getSafeSession();
      const uid = session?.user?.id ?? null;
      if (!alive) return;
      setSessionUserId(uid);
      const key = consentStorageKey(VENUE_STORY_CONSENT_VERSION, uid);
      try {
        setAgreed(key != null && localStorage.getItem(key) === "1");
      } catch {
        setAgreed(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [isOpen]);

  // 언마운트/닫힘 시 objectURL 회수
  useEffect(() => {
    return () => {
      items.forEach((i) => URL.revokeObjectURL(i.previewUrl));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 모달 열린 동안 body 스크롤 잠금(composer 동일)
  useEffect(() => {
    if (!isOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [isOpen]);

  // uploading(XHR/fetch 진행 중)일 때만 새로고침/탭 종료 이탈을 실제로 막는다(Blocker 3 actual guard).
  useEffect(() => {
    if (!isOpen) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (diaryLeaveNotice(itemsRef.current.map((i) => i.state)).guard) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [isOpen]);

  const savedCount = useMemo(
    () => items.filter((i) => i.state.phase === "done").length,
    [items],
  );
  const usedCount = game.existingCount + savedCount;
  const remaining = Math.max(0, VENUE_DIARY_MEDIA_CAP - game.existingCount);
  const locked = remaining <= 0;
  const itemStates = items.map((i) => i.state);
  const bottom = diaryBottomCta(itemStates, agreed);
  const leaveNotice = diaryLeaveNotice(itemStates);

  const toggleAgree = () => {
    setAgreed((prev) => {
      const next = !prev;
      try {
        if (consentKey != null) {
          if (next) localStorage.setItem(consentKey, "1");
          else localStorage.removeItem(consentKey);
        }
      } catch {
        /* noop */
      }
      return next;
    });
  };

  const updateItem = (key: string, patch: Partial<DiaryUploadItemState>) => {
    setItems((prev) =>
      prev.map((i) => (i.key === key ? { ...i, state: { ...i.state, ...patch } } : i)),
    );
  };

  // POST 반환 story id 를 상세 GET(active|archived)에서 추적해 terminal(승급) 까지 poll,
  // 항목을 processing→done(archived)/stalled(timeout)로 전환한다(Blocker 3).
  const startPendingItemPoll = (itemKey: string, storyId: number) => {
    const cancel = startDiaryPendingPoll({
      delays: PENDING_POLL_DELAYS_MS,
      probe: async (signal) => {
        const session = await getSafeSession();
        const token = session?.access_token;
        if (!token) return null;
        const res = await fetch(
          `/api/me/venue-diary/media?gameId=${encodeURIComponent(game.gameId)}`,
          { headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal },
        );
        if (!res.ok) return null;
        const data = (await res.json()) as { media?: { id: number }[] };
        return { found: (data.media ?? []).some((m) => m.id === storyId) };
      },
      onTerminal: (terminal) => {
        updateItem(itemKey, { phase: diaryPendingTerminalPhase(terminal) });
      },
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle),
    });
    pendingPollsRef.current.push(cancel);
  };

  const processItem = async (item: UploadItem) => {
    if (!agreed) {
      setError("업로드 가이드라인에 동의해주세요");
      return;
    }
    setError(null);
    // 이미 저장 완료된 항목은 재전송하지 않는다(Blocker 2).
    if (item.state.phase === "done") return;
    updateItem(item.key, { phase: "uploading", percent: 0 });
    try {
      const prepared = await prepareVenueStoryMedia(item.file, game.gameId, (r) => {
        updateItem(item.key, { phase: "uploading", percent: Math.min(99, Math.round(r * 100)) });
      });
      if ("error" in prepared) {
        setError(prepared.error);
        updateItem(item.key, { phase: "failed" });
        return;
      }
      const session = await getSafeSession();
      const token = session?.access_token;
      if (!token) {
        setError("로그인이 필요해요");
        updateItem(item.key, { phase: "failed" });
        return;
      }
      const res = await fetch("/api/me/venue-diary/media", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          gameId: game.gameId,
          mediaType: prepared.mediaType,
          mediaUrl: prepared.mediaUrl,
          mediaPath: prepared.mediaPath,
          thumbUrl: prepared.thumbUrl,
          durationMs: prepared.durationMs,
          width: prepared.width,
          height: prepared.height,
          // 선택 순간이 아니라 제출 시점 caption 을 읽는다(Blocker 2 closure 고정 방지).
          caption: diaryCaptionForSubmit(captionRef.current),
          consentVersion: VENUE_STORY_CONSENT_VERSION,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setError(data.error ?? "저장에 실패했어요");
        updateItem(item.key, { phase: "failed" });
        return;
      }
      const storyId = typeof data.id === "number" ? data.id : null;
      const status = data.status ?? "archived";
      onUploaded({
        id: storyId,
        gameId: game.gameId,
        mediaType: prepared.mediaType,
        status,
      });
      // 영상 pending → 처리 중(id 추적 terminal poll 시작), 그 외 → 완료
      if (status === "pending" && storyId != null) {
        updateItem(item.key, { phase: "processing", storyId });
        startPendingItemPoll(item.key, storyId);
      } else {
        updateItem(item.key, { phase: "done" });
      }
    } catch {
      setError("업로드에 실패했어요");
      updateItem(item.key, { phase: "failed" });
    }
  };

  const handlePick = (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const picked = Array.from(fileList);
    const slots = Math.max(0, remaining - items.length);
    if (slots <= 0) {
      setError(`이 경기에는 최대 ${VENUE_DIARY_MEDIA_CAP}개까지 올릴 수 있어요`);
      return;
    }
    const accepted = picked.slice(0, slots).flatMap((file) => {
      const isVideo = file.type.startsWith("video/");
      const isImage = file.type.startsWith("image/");
      if (!isVideo && !isImage) return [];
      const item: UploadItem = {
        key: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        file,
        previewUrl: URL.createObjectURL(file),
        mediaType: isVideo ? "video" : "image",
        state: { phase: "queued", mediaType: isVideo ? "video" : "image" },
      };
      return [item];
    });
    if (accepted.length === 0) {
      setError("이미지 또는 영상만 올릴 수 있어요");
      return;
    }
    if (picked.length > slots) {
      setError(`남은 ${slots}개까지만 추가했어요`);
    }
    // 선택은 queued 까지만. 실제 업로드는 동의 완료 후 명시적 CTA(startUpload)로만 시작한다(Blocker 2).
    setItems((prev) => [...prev, ...accepted]);
  };

  // 명시적 업로드 CTA — 동의 완료 + 제출 시점 caption 으로 queued/failed 항목만 순차 전송(done 재전송 안 함).
  const startUpload = async () => {
    if (!agreed) {
      setError("업로드 가이드라인에 동의해주세요");
      return;
    }
    const targets = diaryUploadTargets(itemsRef.current);
    if (targets.length === 0) return;
    setError(null);
    for (const item of targets) {
      await processItem(item);
    }
  };

  const removeItem = (key: string) => {
    setItems((prev) => {
      const target = prev.find((i) => i.key === key);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((i) => i.key !== key);
    });
  };

  // uploading 중 이탈은 실제로 막는다(confirm). pending/processing/완료/빈 상태는 자유롭게 닫힘.
  const confirmLeaveIfUploading = (): boolean => {
    if (!diaryLeaveNotice(itemsRef.current.map((i) => i.state)).guard) return true;
    return window.confirm("업로드가 진행 중이에요. 지금 나가면 중단돼요. 나가시겠어요?");
  };

  const close = () => {
    if (!confirmLeaveIfUploading()) return;
    items.forEach((i) => URL.revokeObjectURL(i.previewUrl));
    setItems([]);
    setCaption("");
    setError(null);
    onClose();
  };

  const handleBack = () => {
    if (!confirmLeaveIfUploading()) return;
    onBack();
  };

  if (!isOpen || typeof document === "undefined") return null;

  return createPortal(
    <AnimatePresence>
      <motion.div
        className="fixed inset-0 z-[55] flex items-end"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
      >
        <div className="absolute inset-0 bg-black/60" onClick={close} />
        <motion.div
          className="relative w-full max-w-lg mx-auto bg-bg-secondary rounded-t-3xl max-h-[92dvh] overflow-hidden flex flex-col"
          initial={{ y: "100%" }}
          animate={{ y: 0 }}
          exit={{ y: "100%" }}
          transition={{ type: "spring", damping: 26 }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <button onClick={handleBack} aria-label="뒤로" className="text-text-tertiary">
              <ChevronLeft size={22} />
            </button>
            <span className="text-base font-semibold text-text-primary">기록 추가</span>
            <button onClick={close} aria-label="닫기" className="text-text-tertiary">
              <X size={22} />
            </button>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-4 flex flex-col gap-3">
            {/* 선택된 경기 */}
            <div className="flex items-center justify-between rounded-2xl bg-bg-tertiary/60 border border-border px-4 py-3">
              <div>
                <p className="text-[11px] font-bold text-text-tertiary">{game.dateLabel}</p>
                <p className="mt-0.5 text-sm font-bold text-text-primary flex items-center gap-1.5">
                  {game.matchLabel}
                  {game.result && (
                    <span
                      className="rounded px-1.5 py-0.5 text-[11px] font-bold"
                      style={resultStyle(game.result)}
                    >
                      {resultText(game.result)}
                    </span>
                  )}
                </p>
              </div>
              <button onClick={handleBack} className="text-xs font-bold text-accent">
                변경
              </button>
            </div>

            {/* 업로드 드롭/버튼 */}
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={locked}
              className="flex flex-col items-center justify-center gap-1.5 rounded-2xl border-2 border-dashed border-border py-6 text-text-tertiary active:bg-bg-tertiary disabled:opacity-40"
            >
              {locked ? <Lock size={24} /> : <ImagePlus size={26} />}
              <span className="text-sm font-bold text-text-secondary">
                {locked ? "이 경기는 가득 찼어요" : "사진·영상 더 올리기"}
              </span>
              <span className="text-[11px]">
                경기당 최대 {VENUE_DIARY_MEDIA_CAP}개 · GPS 인증 불필요 · {usedCount}/{VENUE_DIARY_MEDIA_CAP}
              </span>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,video/*"
              multiple
              className="hidden"
              onChange={(e) => {
                handlePick(e.target.files);
                e.target.value = "";
              }}
            />

            {/* 미리보기 + 항목 상태 */}
            {items.length > 0 && (
              <div className="grid grid-cols-4 gap-2">
                {items.map((item) => {
                  const badge = diaryUploadBadge(item.state);
                  return (
                    <div
                      key={item.key}
                      className="relative aspect-square rounded-xl overflow-hidden bg-bg-tertiary"
                    >
                      {item.mediaType === "video" ? (
                        <video src={item.previewUrl} className="w-full h-full object-cover" muted playsInline />
                      ) : (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={item.previewUrl} alt="" className="w-full h-full object-cover" />
                      )}

                      {/* 상태 오버레이 */}
                      {item.state.phase === "done" ? (
                        <div className="absolute top-1 left-1 w-[18px] h-[18px] rounded-full bg-emerald-500 text-white flex items-center justify-center">
                          <Check size={12} strokeWidth={3} />
                        </div>
                      ) : item.state.phase === "uploading" ? (
                        <>
                          <div className="absolute inset-0 bg-black/50 flex flex-col items-center justify-center gap-1 text-white text-[10px] font-bold text-center px-1">
                            <Loader2 size={20} className="animate-spin" />
                            {badge.label}
                          </div>
                          <div
                            className="absolute left-0 bottom-0 h-1 bg-emerald-500"
                            style={{ width: `${item.state.percent ?? 0}%` }}
                          />
                        </>
                      ) : item.state.phase === "processing" ? (
                        <div className="absolute inset-0 bg-black/60 flex flex-col items-center justify-center gap-1 text-amber-400 text-[10px] font-bold text-center px-1">
                          <Loader2 size={20} className="animate-spin" />
                          영상<br />처리 중
                        </div>
                      ) : item.state.phase === "stalled" ? (
                        <div className="absolute inset-0 bg-black/60 flex flex-col items-center justify-center gap-1 text-amber-300 text-[10px] font-bold text-center px-1">
                          <AlertTriangle size={16} />
                          처리 지연<br />나중에 확인
                        </div>
                      ) : item.state.phase === "failed" ? (
                        <button
                          onClick={() => void processItem(item)}
                          className="absolute inset-0 bg-red-950/70 border-[1.5px] border-red-500 rounded-xl flex flex-col items-center justify-center gap-0.5 text-red-100 text-[10px] font-bold text-center px-1"
                        >
                          <AlertTriangle size={16} />
                          실패<br />다시 시도
                        </button>
                      ) : null}

                      {/* 대기/실패 시 제거 버튼 */}
                      {(item.state.phase === "queued" || item.state.phase === "failed") && (
                        <button
                          onClick={() => removeItem(item.key)}
                          aria-label="제거"
                          className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/60 text-white text-[11px] flex items-center justify-center z-10"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* 메모 */}
            <input
              type="text"
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              maxLength={200}
              placeholder="한 줄 메모 (선택)"
              className="w-full px-3 py-2.5 rounded-xl bg-bg-tertiary text-sm text-text-primary placeholder:text-text-tertiary outline-none"
            />

            <div
              className={`rounded-xl border px-3 py-2.5 text-[11.5px] leading-relaxed ${
                leaveNotice.tone === "warn"
                  ? "border-red-500/30 bg-red-500/10 text-red-300"
                  : "border-amber-500/25 bg-amber-500/10 text-amber-300"
              }`}
            >
              {leaveNotice.text}
            </div>
          </div>

          <div
            className="shrink-0 border-t border-border p-4 flex flex-col gap-2.5"
            style={{ paddingBottom: "max(var(--safe-area-inset-bottom, env(safe-area-inset-bottom)), 12px)" }}
          >
            <label className="flex items-start gap-2 text-[11px] text-text-tertiary leading-relaxed cursor-pointer select-none">
              <input
                type="checkbox"
                checked={agreed}
                onChange={toggleAgree}
                className="mt-0.5 accent-brand-primary shrink-0"
              />
              <span>
                타인 얼굴/초상권 침해·욕설/폭력·불법 촬영물을 올리지 않겠습니다.{" "}
                <b className="text-text-secondary">가이드라인에 동의합니다.</b>
              </span>
            </label>

            {error && <p className="text-sm text-red-400">{error}</p>}
            {bottom.subLabel && (
              <p className="text-center text-[11px] text-amber-400">{bottom.subLabel}</p>
            )}

            <button
              onClick={() => {
                if (bottom.action === "upload") void startUpload();
                else close();
              }}
              disabled={bottom.disabled}
              className={`w-full py-3.5 rounded-xl font-bold text-white disabled:opacity-50 ${
                bottom.kind === "go" || bottom.kind === "start"
                  ? "bg-brand-primary"
                  : bottom.kind === "wait"
                    ? "bg-brand-primary/40"
                    : "bg-bg-tertiary text-text-tertiary"
              }`}
            >
              {bottom.label}
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body,
  );
}
