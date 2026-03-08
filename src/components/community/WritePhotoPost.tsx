"use client";

import { useState, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Plus, XCircle, Loader2 } from "lucide-react";
import Image from "next/image";
import imageCompression from "browser-image-compression";
import { createPost, uploadImages } from "@/lib/supabase/usePosts";

interface WritePhotoPostProps {
  isOpen: boolean;
  onClose: () => void;
  teamName?: string;
  boardType: string;
  boardId: string;
  onSuccess?: () => void;
}

export default function WritePhotoPost({
  isOpen,
  onClose,
  teamName,
  boardType,
  boardId,
  onSuccess,
}: WritePhotoPostProps) {
  const [caption, setCaption] = useState("");
  const [images, setImages] = useState<{ preview: string; file: File }[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleImageSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files) return;
    const remaining = 3 - images.length;
    Array.from(files)
      .slice(0, remaining)
      .forEach((file) => {
        const preview = URL.createObjectURL(file);
        setImages((prev) => [...prev, { preview, file }]);
      });
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function removeImage(index: number) {
    setImages((prev) => {
      URL.revokeObjectURL(prev[index].preview);
      return prev.filter((_, i) => i !== index);
    });
  }

  async function handleSubmit() {
    if (images.length === 0) return;
    setSubmitting(true);

    try {
      // Resize images
      const compressed = await Promise.all(
        images.map((img) =>
          imageCompression(img.file, {
            maxWidthOrHeight: 1200,
            maxSizeMB: 1,
            useWebWorker: true,
          })
        )
      );

      // Upload to Storage
      const urls = await uploadImages(compressed);

      // Create post
      await createPost({
        boardType,
        boardId,
        title: "",
        content: caption.trim(),
        imageUrls: urls,
        contentType: "photo",
      });

      // Reset & close
      setCaption("");
      setImages([]);
      onClose();
      onSuccess?.();
    } catch (e: unknown) {
      alert("업로드 실패: " + ((e as Error).message || JSON.stringify(e)));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/60"
            onClick={onClose}
          />
          <motion.div
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", damping: 30, stiffness: 300 }}
            className="fixed inset-0 z-50 bg-bg-primary overflow-y-auto flex flex-col"
          >
            {/* Header */}
            <div
              className="flex items-center justify-between px-5 py-3"
              style={{ paddingTop: "max(env(safe-area-inset-top, 0px), 12px)" }}
            >
              <button onClick={onClose} className="text-text-secondary p-1">
                <X size={24} />
              </button>
              <h2 className="text-lg font-semibold text-text-primary">
                {teamName ? `${teamName} 사진` : "사진 올리기"}
              </h2>
              <button
                onClick={handleSubmit}
                disabled={images.length === 0 || submitting}
                className="rounded-full bg-accent px-4 py-1.5 text-base font-semibold text-white disabled:opacity-40 transition-opacity flex items-center gap-1.5"
              >
                {submitting && <Loader2 size={16} className="animate-spin" />}
                등록
              </button>
            </div>

            <div className="px-5 pb-8 space-y-4 flex-1 flex flex-col">
              {/* Photo picker */}
              <div className="flex gap-3 overflow-x-auto scrollbar-hide pb-1">
                {images.map((img, i) => (
                  <div key={i} className="relative flex-shrink-0 w-28 h-28 rounded-xl overflow-hidden bg-bg-tertiary">
                    <Image
                      src={img.preview}
                      alt={`preview ${i}`}
                      fill
                      className="object-cover"
                    />
                    <button
                      onClick={() => removeImage(i)}
                      className="absolute top-1 right-1 bg-black/60 rounded-full p-0.5"
                    >
                      <XCircle size={20} className="text-white" />
                    </button>
                  </div>
                ))}
                {images.length < 3 && (
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="flex-shrink-0 w-28 h-28 rounded-xl bg-bg-tertiary flex flex-col items-center justify-center gap-1 text-text-tertiary hover:text-text-secondary transition-colors"
                  >
                    <Plus size={28} />
                    <span className="text-xs">{images.length}/3</span>
                  </button>
                )}
              </div>

              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                onChange={handleImageSelect}
                className="hidden"
              />

              {/* Caption */}
              <textarea
                placeholder="캡션을 입력하세요 (선택)"
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
                className="w-full flex-1 min-h-[120px] resize-none rounded-xl bg-bg-tertiary px-5 py-4 text-base text-text-primary placeholder:text-text-tertiary outline-none"
              />
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
