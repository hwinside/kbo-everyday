"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Video, X, Send, Loader2 } from "lucide-react";
import { uploadFeedbackVideo } from "@/lib/supabase/storage";
import { useAuth } from "@/lib/supabase/AuthContext";
import { supabase } from "@/lib/supabase/client";

type FeedbackType = "bug" | "data" | "feature" | "other";

interface FeedbackSheetProps {
  isOpen: boolean;
  onClose: () => void;
  defaultType?: FeedbackType;
}

const TYPES: { value: FeedbackType; label: string }[] = [
  { value: "bug", label: "🐛 버그" },
  { value: "data", label: "📊 데이터" },
  { value: "feature", label: "💡 제안" },
  { value: "other", label: "💬 기타" },
];

export default function FeedbackSheet({ isOpen, onClose, defaultType }: FeedbackSheetProps) {
  const { user } = useAuth();

  useEffect(() => {
    if (!isOpen) return;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, [isOpen]);
  const [type, setType] = useState<FeedbackType>(defaultType ?? "bug");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoPreviewUrl, setVideoPreviewUrl] = useState<string | null>(null);
  const [videoError, setVideoError] = useState("");
  const [uploadingVideo, setUploadingVideo] = useState(false);

  const supportsVideo = type === "bug" || type === "feature";

  const resetForm = () => {
    setType(defaultType ?? "bug");
    setTitle("");
    setBody("");
    setError("");
    setSuccess(false);
    setVideoFile(null);
    setVideoError("");
    if (videoPreviewUrl) {
      URL.revokeObjectURL(videoPreviewUrl);
      setVideoPreviewUrl(null);
    }
  };

  const handleClose = () => {
    resetForm();
    onClose();
  };

  const handleVideoSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setVideoError("");

    const allowed = ["video/mp4", "video/quicktime", "video/webm"];
    if (!allowed.includes(file.type)) {
      setVideoError("mp4, mov, webm 파일만 가능합니다");
      return;
    }

    if (file.size > 50 * 1024 * 1024) {
      setVideoError("50MB 이하만 가능합니다");
      return;
    }

    try {
      const duration = await getVideoDuration(file);
      if (duration > 30) {
        setVideoError("30초 이하만 가능합니다");
        return;
      }
    } catch {
      setVideoError("영상을 읽을 수 없습니다");
      return;
    }

    if (videoPreviewUrl) URL.revokeObjectURL(videoPreviewUrl);
    setVideoFile(file);
    setVideoPreviewUrl(URL.createObjectURL(file));
  };

  function getVideoDuration(file: File): Promise<number> {
    return new Promise((resolve, reject) => {
      const video = document.createElement("video");
      video.preload = "metadata";
      const url = URL.createObjectURL(file);
      video.onloadedmetadata = () => {
        URL.revokeObjectURL(url);
        resolve(video.duration);
      };
      video.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("Cannot load video"));
      };
      video.src = url;
    });
  }

  const removeVideo = () => {
    setVideoFile(null);
    setVideoError("");
    if (videoPreviewUrl) {
      URL.revokeObjectURL(videoPreviewUrl);
      setVideoPreviewUrl(null);
    }
  };

  const handleSubmit = async () => {
    if (!title.trim()) {
      setError("제목을 입력해주세요");
      return;
    }
    if (!user) return;

    setLoading(true);
    setError("");

    try {
      const { data: { session } } = await supabase.auth.getSession();
      const accessToken = session?.access_token;

      if (!accessToken) {
        setError("로그인이 필요합니다");
        return;
      }

      // Phase 1: Submit text feedback
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          type,
          title: title.trim(),
          body: body.trim() || null,
          pageUrl: window.location.pathname,
          deviceInfo: navigator.userAgent,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "전송에 실패했습니다");
        return;
      }

      const feedbackId = data.feedbackId;

      // Phase 2: Upload video if attached
      if (videoFile && feedbackId) {
        setUploadingVideo(true);
        const storagePath = await uploadFeedbackVideo(videoFile, user.id, feedbackId);

        if (storagePath) {
          const duration = await getVideoDuration(videoFile);
          const attachRes = await fetch("/api/feedback/attachment", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${accessToken}`,
            },
            body: JSON.stringify({
              feedbackId,
              storagePath,
              mimeType: videoFile.type,
              fileSize: videoFile.size,
              durationSec: Math.round(duration),
            }),
          });

          if (!attachRes.ok) {
            setError("영상 업로드에 실패했지만 피드백은 전송되었습니다");
            setUploadingVideo(false);
            setTimeout(() => handleClose(), 2000);
            return;
          }
        } else {
          setError("영상 업로드에 실패했지만 피드백은 전송되었습니다");
          setUploadingVideo(false);
          setTimeout(() => handleClose(), 2000);
          return;
        }
        setUploadingVideo(false);
      }

      setSuccess(true);
      setTimeout(() => {
        handleClose();
      }, 1500);
    } catch {
      setError("네트워크 오류가 발생했습니다");
    } finally {
      setLoading(false);
      setUploadingVideo(false);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[90] bg-black/60"
            onClick={handleClose}
          />
          <motion.div
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", damping: 25, stiffness: 300 }}
            className="fixed bottom-0 left-0 right-0 z-[91] mx-auto max-w-lg rounded-t-3xl bg-bg-secondary p-5 pb-safe"
          >
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-lg font-bold text-text-primary">📮 피드백 보내기</h2>
              <button onClick={handleClose} className="p-1 rounded-full hover:bg-bg-tertiary">
                <X size={20} className="text-text-tertiary" />
              </button>
            </div>

            {success ? (
              <div className="flex flex-col items-center gap-3 py-8">
                <span className="text-4xl">🙏</span>
                <p className="text-base font-semibold text-text-primary">소중한 의견 감사합니다!</p>
              </div>
            ) : (
              <>
                {/* Type pills */}
                <div className="flex gap-2 mb-5">
                  {TYPES.map((t) => (
                    <button
                      key={t.value}
                      onClick={() => {
                        setType(t.value);
                        if (t.value !== "bug" && t.value !== "feature") {
                          removeVideo();
                        }
                      }}
                      className={`rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
                        type === t.value
                          ? "bg-accent text-white"
                          : "bg-bg-tertiary text-text-secondary"
                      }`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>

                {/* Title */}
                <input
                  type="text"
                  placeholder="제목 (필수)"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  maxLength={100}
                  className="w-full rounded-xl bg-bg-tertiary px-4 py-3 text-sm text-text-primary placeholder:text-text-tertiary outline-none focus:ring-1 focus:ring-accent mb-3"
                />

                {/* Body */}
                <textarea
                  placeholder="상세 설명 (선택)"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={4}
                  maxLength={2000}
                  className="w-full rounded-xl bg-bg-tertiary px-4 py-3 text-sm text-text-primary placeholder:text-text-tertiary outline-none focus:ring-1 focus:ring-accent resize-none mb-4 [overscroll-behavior:contain]"
                />

                {/* Video attachment (bug & feature only) */}
                {supportsVideo && (
                  <div className="mb-4">
                    {videoFile && videoPreviewUrl ? (
                      <div className="relative rounded-xl overflow-hidden bg-black">
                        <video
                          src={videoPreviewUrl}
                          className="w-full max-h-32 object-contain"
                          muted
                          playsInline
                        />
                        <button
                          onClick={removeVideo}
                          className="absolute top-2 right-2 p-1 rounded-full bg-black/60"
                        >
                          <X size={14} className="text-white" />
                        </button>
                        <span className="absolute bottom-2 left-2 text-[10px] text-white/70 bg-black/60 px-1.5 py-0.5 rounded">
                          {(videoFile.size / 1024 / 1024).toFixed(1)}MB
                        </span>
                      </div>
                    ) : (
                      <label className="flex items-center gap-2 rounded-xl bg-bg-tertiary px-4 py-3 text-sm text-text-tertiary cursor-pointer hover:bg-bg-tertiary/80 transition-colors">
                        <Video size={16} />
                        <span>영상 첨부 (30초, 50MB 이하)</span>
                        <input
                          type="file"
                          accept="video/mp4,video/quicktime,video/webm"
                          onChange={handleVideoSelect}
                          className="hidden"
                        />
                      </label>
                    )}
                    {videoError && <p className="text-red-400 text-xs mt-1">{videoError}</p>}
                  </div>
                )}

                {error && <p className="text-red-400 text-xs mb-3">{error}</p>}

                {/* Submit */}
                <button
                  onClick={handleSubmit}
                  disabled={loading || uploadingVideo || !title.trim()}
                  className="w-full flex items-center justify-center gap-2 rounded-xl bg-accent py-3 text-sm font-semibold text-white transition-opacity disabled:opacity-40"
                >
                  {uploadingVideo ? (
                    <>
                      <Loader2 size={16} className="animate-spin" />
                      영상 업로드 중...
                    </>
                  ) : (
                    <>
                      <Send size={16} />
                      {loading ? "보내는 중..." : "보내기"}
                    </>
                  )}
                </button>
              </>
            )}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
