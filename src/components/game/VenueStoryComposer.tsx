"use client";

import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { X, Loader2, Video as VideoIcon } from "lucide-react";
import { getSafeSession } from "@/lib/supabase/client";
import { prepareVenueStoryMedia } from "@/lib/venue-stories/upload";

interface Props {
  gameId: string;
  isOpen: boolean;
  onClose: () => void;
  onUploaded: () => void;
}

export default function VenueStoryComposer({ gameId, isOpen, onClose, onUploaded }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewType, setPreviewType] = useState<"image" | "video" | null>(null);
  const [caption, setCaption] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(null);
    setPreviewUrl(null);
    setPreviewType(null);
    setCaption("");
    setError(null);
    setSubmitting(false);
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
    setSubmitting(true);
    setError(null);
    try {
      const prepared = await prepareVenueStoryMedia(file, gameId);
      if ("error" in prepared) {
        setError(prepared.error);
        setSubmitting(false);
        return;
      }
      const session = await getSafeSession();
      const token = session?.access_token;
      if (!token) {
        setError("로그인이 필요해요");
        setSubmitting(false);
        return;
      }
      const res = await fetch("/api/venue-stories", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          gameId,
          mediaType: prepared.mediaType,
          mediaUrl: prepared.mediaUrl,
          thumbUrl: prepared.thumbUrl,
          durationMs: prepared.durationMs,
          width: prepared.width,
          height: prepared.height,
          caption: caption.trim() || null,
        }),
      });
      const data = await res.json();
      if (data.error) {
        setError(data.error);
        setSubmitting(false);
        return;
      }
      onUploaded();
      close();
    } catch {
      setError("업로드에 실패했어요");
      setSubmitting(false);
    }
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
          className="relative w-full max-w-lg mx-auto bg-bg-secondary rounded-t-3xl max-h-[90dvh] overflow-y-auto flex flex-col"
          initial={{ y: "100%" }}
          animate={{ y: 0 }}
          exit={{ y: "100%" }}
          transition={{ type: "spring", damping: 26 }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <span className="text-base font-semibold text-text-primary">직관 라이브 올리기</span>
            <button onClick={close} aria-label="닫기" className="text-text-tertiary">
              <X size={22} />
            </button>
          </div>

          <div className="p-4 flex flex-col gap-3">
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
              onChange={onPick}
            />

            <input
              type="text"
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              maxLength={200}
              placeholder="한 줄 코멘트 (선택)"
              className="w-full px-3 py-2.5 rounded-xl bg-bg-tertiary text-sm text-text-primary placeholder:text-text-tertiary outline-none"
            />

            {error && <p className="text-sm text-red-400">{error}</p>}

            <button
              onClick={submit}
              disabled={!file || submitting}
              className="w-full py-3 rounded-xl bg-brand-primary text-white font-semibold flex items-center justify-center gap-2 disabled:opacity-40"
            >
              {submitting ? <Loader2 size={18} className="animate-spin" /> : null}
              {submitting ? "올리는 중…" : "올리기"}
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body,
  );
}
