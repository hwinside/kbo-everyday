"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { X, Loader2, Video as VideoIcon, MapPin } from "lucide-react";
import { getSafeSession } from "@/lib/supabase/client";
import {
  prepareVenueStoryMedia,
  type VenueStoryUploadProgress,
} from "@/lib/venue-stories/upload";
import { getVenuePosition } from "@/lib/venue-stories/geo";
import { haversineMeters } from "@/lib/venue-stories/stadiums";
import { VENUE_STORY_CONSENT_VERSION, type VenueInfo } from "@/lib/venue-stories/types";
import { consentStorageKey } from "@/lib/venue-stories/auth-consent";
import { useIsAdmin } from "@/hooks/useIsAdmin";

interface Props {
  gameId: string;
  isOpen: boolean;
  onClose: () => void;
  onUploaded: () => void;
}

type Phase = "idle" | "geo" | "upload";

export default function VenueStoryComposer({ gameId, isOpen, onClose, onUploaded }: Props) {
  const isAdmin = useIsAdmin();
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewType, setPreviewType] = useState<"image" | "video" | null>(null);
  const [caption, setCaption] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [venue, setVenue] = useState<VenueInfo | null>(null);
  const [venueLoading, setVenueLoading] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [sessionUserId, setSessionUserId] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<VenueStoryUploadProgress | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // UGC 가이드라인 동의 — 버전별 + **user-scoped** 기억(삼순 09:44 #3: 계정 전환 시 타 계정
  // 동의 상속 금지). userId 미상이면 기억하지 않는다. 서버가 최종 검증하므로 이건 UX 편의용.
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

  const submitting = phase !== "idle";
  const radiusKm = venue ? Math.round((venue.radiusM / 1000) * 10) / 10 : null;

  // 열릴 때 서버에서 구장/업로드 가능 시간대를 받아온다(서버가 최종 권위, 여기선 UX 게이트용).
  useEffect(() => {
    if (!isOpen) return;
    let alive = true;
    setVenueLoading(true);
    setVenue(null);
    (async () => {
      try {
        const res = await fetch(
          `/api/venue-stories/venue?gameId=${encodeURIComponent(gameId)}`,
        );
        const data = (await res.json()) as VenueInfo;
        if (alive) setVenue(data);
      } catch {
        // 무시 — 서버가 POST 에서 최종 판정
      } finally {
        if (alive) setVenueLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [isOpen, gameId]);

  const reset = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(null);
    setPreviewUrl(null);
    setPreviewType(null);
    setCaption("");
    setError(null);
    setPhase("idle");
    setUploadProgress(null);
  };

  const close = () => {
    reset();
    onClose();
  };

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    setError(null);
    const isVideo = f.type.startsWith("video/");
    const isImage = f.type.startsWith("image/");
    if (!isVideo && !isImage) {
      setError("이미지 또는 영상만 올릴 수 있어요");
      return;
    }
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(f);
    setPreviewUrl(URL.createObjectURL(f));
    setPreviewType(isVideo ? "video" : "image");
  };

  const submit = async () => {
    if (!file || submitting) return;
    setError(null);

    // UGC 가이드라인 동의 필수(업로드 시점 게이트)
    if (!agreed) {
      setError("업로드 가이드라인에 동의해주세요");
      return;
    }

    // 업로드 가능 시간대 아님(경기 전/후, 취소, 미지원 구장) — 서버 사유 그대로 노출
    if (venue && !venue.uploadOpen) {
      setError(venue.reason ?? "지금은 올릴 수 없어요");
      return;
    }

    // 일반 유저는 위치 필수. 관리자 WIP QA 계정은 구장 밖 테스트를 위해 GPS 수집부터 생략.
    let pos: { lat: number | null; lng: number | null; accuracy: number | null } = {
      lat: null,
      lng: null,
      accuracy: null,
    };
    if (!isAdmin) {
      setPhase("geo");
      const measured = await getVenuePosition();
      if ("error" in measured) {
        setError(measured.error);
        setPhase("idle");
        return;
      }
      pos = measured;
      if (venue && venue.lat != null && venue.lng != null) {
        const dist = haversineMeters(measured.lat, measured.lng, venue.lat, venue.lng);
        if (dist > venue.radiusM) {
          const where = venue.stadiumName ?? "경기장";
          setError(
            `직관 인증 실패 — ${where}${radiusKm ? ` 반경 ${radiusKm}km` : ""} 안에서만 올릴 수 있어요`,
          );
          setPhase("idle");
          return;
        }
      }
    }

    setPhase("upload");
    setUploadProgress({ percent: 1, label: "업로드 준비 중…" });
    try {
      const session = await getSafeSession();
      const token = session?.access_token;
      const userId = session?.user?.id;
      if (!token || !userId) {
        setError("로그인이 필요해요");
        setPhase("idle");
        return;
      }
      const prepared = await prepareVenueStoryMedia(file, gameId, {
        userId,
        accessToken: token,
        onProgress: (progress) => {
          setUploadProgress((current) =>
            current && progress.percent < current.percent ? current : progress,
          );
        },
      });
      if ("error" in prepared) {
        setError(prepared.error);
        setPhase("idle");
        return;
      }
      setUploadProgress({
        percent: 94,
        label: prepared.mediaType === "video" ? "영상 확인 중…" : "게시 준비 중…",
      });
      const res = await fetch("/api/venue-stories", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          gameId,
          mediaType: prepared.mediaType,
          mediaUrl: prepared.mediaUrl,
          mediaPath: prepared.mediaPath, // 영상: private staging 경로(서버 즉시 검증 후 공개 승격)
          thumbUrl: prepared.thumbUrl,
          durationMs: prepared.durationMs,
          width: prepared.width,
          height: prepared.height,
          caption: caption.trim() || null,
          lat: pos.lat,
          lng: pos.lng,
          accuracy: pos.accuracy,
          consentVersion: VENUE_STORY_CONSENT_VERSION,
        }),
      });
      const data = await res.json();
      if (data.error) {
        setError(data.error);
        setPhase("idle");
        return;
      }
      setUploadProgress({ percent: 100, label: "업로드 완료" });
      onUploaded();
      await new Promise((resolve) => setTimeout(resolve, 250));
      close();
    } catch {
      setError("업로드에 실패했어요");
      setPhase("idle");
    }
  };

  if (!isOpen || typeof document === "undefined") return null;

  const gateReason = venue && !venue.uploadOpen ? venue.reason : null;

  return createPortal(
    <AnimatePresence>
      <motion.div
        className="fixed inset-0 z-[55] flex items-end"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
      >
        <div className="absolute inset-0 bg-black/60" onClick={submitting ? undefined : close} />
        <motion.div
          className="relative w-full max-w-lg mx-auto bg-bg-secondary rounded-t-3xl max-h-[90dvh] overflow-y-auto flex flex-col"
          initial={{ y: "100%" }}
          animate={{ y: 0 }}
          exit={{ y: "100%" }}
          transition={{ type: "spring", damping: 26 }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <span className="text-base font-semibold text-text-primary">직관 라이브 올리기</span>
            <button
              onClick={close}
              disabled={submitting}
              aria-label="닫기"
              className="text-text-tertiary disabled:opacity-40"
            >
              <X size={22} />
            </button>
          </div>

          <div className="p-4 flex flex-col gap-3">
            <div className="flex items-center gap-1.5 text-[12px] text-text-tertiary bg-bg-tertiary/50 rounded-lg px-3 py-2">
              <MapPin size={13} className="text-red-400 shrink-0" />
              <span>
                {isAdmin
                  ? "관리자 QA 모드 · 위치 인증 없이 업로드할 수 있어요"
                  : venueLoading
                  ? "구장 정보 확인 중…"
                  : gateReason
                    ? gateReason
                    : `${venue?.stadiumName ?? "경기장"}${radiusKm ? ` 반경 ${radiusKm}km` : ""} 안(직관 중)에서만 올릴 수 있어요`}
              </span>
            </div>

            {!previewUrl ? (
              <button
                onClick={() => inputRef.current?.click()}
                className="flex flex-col items-center justify-center gap-2 h-48 rounded-2xl border-2 border-dashed border-border text-text-tertiary active:bg-bg-tertiary"
              >
                <VideoIcon size={28} />
                <span className="text-sm">현장 사진·영상 선택</span>
                <span className="text-[11px] text-text-tertiary/70">영상은 15초 이하 · 세로 추천</span>
              </button>
            ) : (
              <div className="relative rounded-2xl overflow-hidden bg-black aspect-[9/16] max-h-[50dvh] flex items-center justify-center">
                {previewType === "video" ? (
                  <video src={previewUrl} className="w-full h-full object-contain" controls playsInline muted />
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={previewUrl} alt="" className="w-full h-full object-contain" />
                )}
                <button
                  onClick={() => inputRef.current?.click()}
                  disabled={submitting}
                  className="absolute bottom-2 right-2 text-xs bg-black/60 text-white px-3 py-1.5 rounded-full"
                >
                  다시 선택
                </button>
              </div>
            )}

            <input
              ref={inputRef}
              type="file"
              accept="image/*,video/*"
              className="hidden"
              disabled={submitting}
              onChange={onPick}
            />

            <input
              type="text"
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              maxLength={200}
              disabled={submitting}
              placeholder="한 줄 코멘트 (선택)"
              className="w-full px-3 py-2.5 rounded-xl bg-bg-tertiary text-sm text-text-primary placeholder:text-text-tertiary outline-none"
            />

            <label className="flex items-start gap-2 text-[11px] text-text-tertiary leading-relaxed cursor-pointer select-none">
              <input
                type="checkbox"
                checked={agreed}
                onChange={toggleAgree}
                disabled={submitting}
                className="mt-0.5 accent-brand-primary shrink-0"
              />
              <span>
                중계화면 무단 재촬영·타인 얼굴/초상권 침해·욕설/폭력·불법 촬영물을 올리지 않겠습니다.
                위반 콘텐츠는 신고·삭제될 수 있어요. <b className="text-text-secondary">가이드라인에 동의합니다.</b>
              </span>
            </label>

            {error && <p className="text-sm text-red-400">{error}</p>}

            {phase === "upload" && uploadProgress && (
              <div className="rounded-xl bg-bg-tertiary/70 px-3 py-2.5" aria-live="polite">
                <div className="mb-1.5 flex items-center justify-between gap-3 text-xs">
                  <span className="text-text-secondary">{uploadProgress.label}</span>
                  <span className="tabular-nums font-semibold text-text-primary">
                    {uploadProgress.percent}%
                  </span>
                </div>
                <div
                  role="progressbar"
                  aria-label="직관 라이브 업로드 진행률"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={uploadProgress.percent}
                  className="h-2 overflow-hidden rounded-full bg-border"
                >
                  <div
                    className="h-full rounded-full bg-brand-primary transition-[width] duration-200 ease-out"
                    style={{ width: `${uploadProgress.percent}%` }}
                  />
                </div>
              </div>
            )}

            <button
              onClick={submit}
              disabled={!file || submitting || !!gateReason || !agreed}
              className="w-full py-3 rounded-xl bg-brand-primary text-white font-semibold flex items-center justify-center gap-2 disabled:opacity-40"
            >
              {submitting ? <Loader2 size={18} className="animate-spin" /> : null}
              {phase === "geo" ? "직관 인증 중…" : phase === "upload" ? "올리는 중…" : "올리기"}
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body,
  );
}
