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
  diaryUploadBadge,
  diaryUploadCta,
  VENUE_DIARY_MEDIA_CAP,
  type DiaryUploadItemState,
} from "@/lib/venue-diary/view";

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
  /** 하나라도 저장 성공하면 호출(홈 목록 갱신용). */
  onUploaded: () => void;
}

const RESULT_STYLE: Record<"W" | "L" | "D", string> = {
  W: "bg-blue-500/15 text-blue-500",
  L: "bg-red-500/15 text-red-500",
  D: "bg-gray-500/15 text-text-secondary",
};

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

  const savedCount = useMemo(
    () => items.filter((i) => i.state.phase === "done").length,
    [items],
  );
  const usedCount = game.existingCount + savedCount;
  const remaining = Math.max(0, VENUE_DIARY_MEDIA_CAP - game.existingCount);
  const locked = remaining <= 0;
  const cta = diaryUploadCta(items.map((i) => i.state));

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

  const processItem = async (item: UploadItem) => {
    if (!agreed) {
      setError("업로드 가이드라인에 동의해주세요");
      return;
    }
    setError(null);
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
          caption: caption.trim() || null,
          consentVersion: VENUE_STORY_CONSENT_VERSION,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setError(data.error ?? "저장에 실패했어요");
        updateItem(item.key, { phase: "failed" });
        return;
      }
      onUploaded();
      // 영상 pending → 처리 중, 그 외 → 완료
      updateItem(item.key, {
        phase: data.status === "pending" ? "processing" : "done",
      });
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
    setItems((prev) => [...prev, ...accepted]);
    // 선택 즉시 순차 업로드 시작(외부 API 부하 방지 — 병렬 대신 순차)
    void (async () => {
      for (const item of accepted) {
        await processItem(item);
      }
    })();
  };

  const removeItem = (key: string) => {
    setItems((prev) => {
      const target = prev.find((i) => i.key === key);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((i) => i.key !== key);
    });
  };

  const close = () => {
    items.forEach((i) => URL.revokeObjectURL(i.previewUrl));
    setItems([]);
    setCaption("");
    setError(null);
    onClose();
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
            <button onClick={onBack} aria-label="뒤로" className="text-text-tertiary">
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
                    <span className={`rounded px-1.5 py-0.5 text-[11px] font-bold ${RESULT_STYLE[game.result]}`}>
                      {resultText(game.result)}
                    </span>
                  )}
                </p>
              </div>
              <button onClick={onBack} className="text-xs font-bold text-accent">
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

            <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2.5 text-[11.5px] leading-relaxed text-amber-300">
              🔒 올린 사진·영상은 비공개로 저장돼 나만 볼 수 있어요. 나가도 업로드·처리는 계속돼요.
            </div>
          </div>

          <div
            className="shrink-0 border-t border-border p-4 flex flex-col gap-2.5"
            style={{ paddingBottom: "max(env(safe-area-inset-bottom), 12px)" }}
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
            {cta.subLabel && (
              <p className="text-center text-[11px] text-amber-400">{cta.subLabel}</p>
            )}

            <button
              onClick={close}
              className={`w-full py-3.5 rounded-xl font-bold text-white ${
                cta.kind === "go"
                  ? "bg-brand-primary"
                  : cta.kind === "wait"
                    ? "bg-brand-primary/40"
                    : "bg-bg-tertiary text-text-tertiary"
              }`}
            >
              {cta.kind === "idle" ? "완료" : cta.label}
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body,
  );
}
